import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LARK_SEND_DEDUP_MS } from './lark-bot.js';

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function displayName(value) {
  return value.replace(/[\r\n\t]/gu, ' ').replaceAll('<', '＜').replaceAll('>', '＞');
}

function isConfirmed(event) {
  return (event.kind === 'delivery' || event.kind === 'reply')
    && [event.serverId, event.deliveryId, event.providerReceiptId, event.senderName, event.recipientName].every(isText)
    && typeof event.confirmedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(event.confirmedAt)
    && Number.isFinite(Date.parse(event.confirmedAt));
}

export class TraceJournal {
  #db;
  #clock;
  #sending = new Map();

  constructor(path, { clock = Date.now } = {}) {
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cloud_trace_settings (
        server_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        test_message_id TEXT,
        enabled_since INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cloud_trace_notices (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        recipient_name TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        sent_message_id TEXT,
        first_attempt_at INTEGER,
        UNIQUE (server_id, delivery_id, kind)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cloud_trace_pending
        ON cloud_trace_notices(server_id, revision, confirmed_at)
        WHERE sent_message_id IS NULL;
    `);
  }

  close() {
    this.#db.close();
  }

  configure(serverId, chatId) {
    if (!isText(serverId) || !isText(chatId)) throw new TypeError('Server and group IDs are required');
    const revision = randomUUID();
    this.#db.prepare(`
      INSERT INTO cloud_trace_settings (server_id, chat_id, revision) VALUES (?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        chat_id = excluded.chat_id, revision = excluded.revision, test_message_id = NULL, enabled_since = NULL
    `).run(serverId, chatId, revision);
    return revision;
  }

  // The caller supplies an application send receipt, never a client assertion.
  verify(serverId, revision, receipt) {
    if (!isText(receipt?.messageId) || !isText(receipt.chatId)) return false;
    return this.#db.prepare(`
      UPDATE cloud_trace_settings SET test_message_id = ?
      WHERE server_id = ? AND revision = ? AND chat_id = ?
    `).run(receipt.messageId, serverId, revision, receipt.chatId).changes === 1;
  }

  enable(serverId, revision) {
    return this.#db.prepare(`
      UPDATE cloud_trace_settings SET enabled_since = COALESCE(enabled_since, ?)
      WHERE server_id = ? AND revision = ? AND test_message_id IS NOT NULL
    `).run(this.#clock(), serverId, revision).changes === 1;
  }

  disable(serverId) {
    this.#db.prepare(`
      UPDATE cloud_trace_settings SET enabled_since = NULL, revision = ?, test_message_id = NULL
      WHERE server_id = ?
    `).run(randomUUID(), serverId);
  }

  // Call only for authoritative platform confirmations from the main bridge.
  record(event) {
    if (!isConfirmed(event)) return false;
    const { serverId, deliveryId, kind, senderName, recipientName, confirmedAt } = event;
    return this.#db.prepare(`
      INSERT INTO cloud_trace_notices (
        id, server_id, delivery_id, kind, trace_id, revision, sender_name, recipient_name, confirmed_at
      )
      SELECT ?, server_id, ?, ?,
        COALESCE((SELECT trace_id FROM cloud_trace_notices
          WHERE server_id = ? AND delivery_id = ? LIMIT 1), ?),
        revision, ?, ?, ?
      FROM cloud_trace_settings WHERE server_id = ? AND enabled_since <= ?
      ON CONFLICT(server_id, delivery_id, kind) DO NOTHING
    `).run(randomUUID(), deliveryId, kind, serverId, deliveryId, randomUUID(),
      displayName(senderName), displayName(recipientName), confirmedAt, serverId, Date.parse(confirmedAt)).changes === 1;
  }

  pending(serverId) {
    const rows = this.#db.prepare(`
      SELECT n.id, n.kind, n.trace_id AS traceId, s.chat_id AS chatId,
        n.sender_name AS senderName, n.recipient_name AS recipientName, n.confirmed_at AS confirmedAt
      FROM cloud_trace_notices n JOIN cloud_trace_settings s
        ON s.server_id = n.server_id AND s.revision = n.revision
      WHERE n.server_id = ? AND s.enabled_since IS NOT NULL AND n.sent_message_id IS NULL
      ORDER BY n.confirmed_at, n.rowid
      LIMIT 100
    `).all(serverId);
    return rows.map(({ id, kind, traceId, chatId, senderName, recipientName, confirmedAt }) => {
      const direction = kind === 'delivery' ? `投递　${senderName} → ${recipientName}`
        : `回复　${recipientName} → ${senderName}`;
      return { id, traceId, chatId, text: `${direction}　${confirmedAt}　编号 ${traceId}` };
    });
  }

  flush(serverId, send) {
    const current = this.#sending.get(serverId);
    if (current) return current;
    const running = Promise.resolve().then(() => this.#sendPending(serverId, send))
      .finally(() => this.#sending.delete(serverId));
    this.#sending.set(serverId, running);
    return running;
  }

  async #sendPending(serverId, send) {
    const result = { sent: 0, pending: 0, needsReview: 0 };
    const begin = this.#db.prepare(`
      UPDATE cloud_trace_notices SET first_attempt_at = COALESCE(first_attempt_at, ?)
      WHERE server_id = ? AND id = ? AND sent_message_id IS NULL AND EXISTS (
        SELECT 1 FROM cloud_trace_settings s WHERE s.server_id = cloud_trace_notices.server_id
          AND s.revision = cloud_trace_notices.revision AND s.enabled_since IS NOT NULL
      )
      RETURNING first_attempt_at
    `);

    for (const notice of this.pending(serverId)) {
      const now = this.#clock();
      const attempt = begin.get(now, serverId, notice.id);
      if (!attempt) continue;
      if (now - attempt.first_attempt_at >= LARK_SEND_DEDUP_MS) {
        result.needsReview += 1;
        continue;
      }
      try {
        const receipt = await send(notice);
        if (receipt?.chatId === notice.chatId && this.markSent(serverId, notice.id, receipt.messageId)) {
          result.sent += 1;
          continue;
        }
      } catch {
        // Retain the notice UUID and attempt time for the next dispatch.
      }
      result.pending += 1;
    }
    return result;
  }

  markSent(serverId, id, messageId) {
    if (!isText(messageId)) return false;
    return this.#db.prepare(`
      UPDATE cloud_trace_notices SET sent_message_id = ?
      WHERE server_id = ? AND id = ? AND sent_message_id IS NULL
    `).run(messageId, serverId, id).changes === 1;
  }
}
