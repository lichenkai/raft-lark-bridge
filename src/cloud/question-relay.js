import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { renderQuestionCard } from './question-card.js';

const LARK_DEDUP_WINDOW_MS = 60 * 60 * 1000;
const LARK_INTERACTION_MS = 14 * 24 * 60 * 60 * 1000;

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function actorKey(actor) {
  const values = [actor?.tenantId, actor?.appId, actor?.openId];
  return values.every(hasText) ? JSON.stringify(values) : null;
}

function bindingKey(binding) {
  const actor = actorKey(binding?.actor);
  if (!actor || !hasText(binding.id) || !hasText(binding.revision)) return null;
  return JSON.stringify([binding.id, binding.revision, actor]);
}

function sourceOf(row) {
  return { serverId: row.server_id, cardId: row.card_id, recipientId: row.recipient_id };
}

function hasReceipt(id, confirmedAt) {
  return hasText(id) && typeof confirmedAt === 'string' && Number.isFinite(Date.parse(confirmedAt));
}

export class QuestionRelay {
  #db;
  #bindings;
  #raft;
  #lark;
  #trace;
  #clock;
  #inFlight = new Map();

  // Platform adapters must verify ingress and enforce live account permissions.
  // This module persists the relationship and never accepts raw HTTP callbacks.
  constructor({ path, bindings, raft, lark, trace, clock = Date.now }) {
    this.#bindings = bindings;
    this.#raft = raft;
    this.#lark = lark;
    this.#trace = trace;
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cloud_question_delivery (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        binding_key TEXT NOT NULL,
        card_json TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        sender_name TEXT,
        recipient_name TEXT,
        first_attempt_at INTEGER,
        message_id TEXT,
        delivered_at TEXT,
        choice INTEGER,
        raft_receipt_id TEXT,
        answered_at TEXT,
        closed INTEGER NOT NULL DEFAULT 0,
        UNIQUE (server_id, card_id, recipient_id)
      ) STRICT;
    `);
  }

  close() {
    this.#db.close();
  }

  #once(key, run) {
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const task = Promise.resolve().then(run).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, task);
    return task;
  }

  #deliveryById(id) {
    return this.#db.prepare('SELECT * FROM cloud_question_delivery WHERE id = ?').get(id);
  }

  async deliver(source) {
    if (![source?.serverId, source?.cardId, source?.recipientId].every(hasText)) return { state: 'unavailable' };
    const { serverId, cardId, recipientId } = source;
    return this.#once(JSON.stringify(['delivery', serverId, cardId, recipientId]), async () => {
      const binding = await this.#bindings(source);
      const key = bindingKey(binding);
      if (!key || !['answer', 'link'].includes(binding.mode)) return { state: 'unavailable' };

      const card = await this.#raft.readCard(source, binding);
      if (card?.recipientId !== recipientId || this.#expired(card)) return { state: 'unavailable' };

      const id = randomUUID();
      const rendering = renderQuestionCard(card, { ...binding, deliveryId: id });
      if (!rendering) return { state: 'unavailable' };
      this.#db.prepare(`
        INSERT INTO cloud_question_delivery (
          id, server_id, card_id, recipient_id, binding_key, card_json, answers_json, sender_name, recipient_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, card_id, recipient_id) DO NOTHING
      `).run(id, serverId, cardId, recipientId, key, JSON.stringify(rendering.card), JSON.stringify(rendering.answers),
        typeof card.senderName === 'string' ? card.senderName : null,
        typeof binding.recipientName === 'string' ? binding.recipientName : null);
      let row = this.#db.prepare(`
        SELECT * FROM cloud_question_delivery WHERE server_id = ? AND card_id = ? AND recipient_id = ?
      `).get(serverId, cardId, recipientId);
      if (row.binding_key !== key) return { state: 'unavailable' };
      if (row.message_id) return this.#delivered(row);
      // If a transport may have accepted the first attempt, keep the same
      // payload and UUID. Stop automatic retries after Lark's dedup window.
      const previousRendering = renderQuestionCard(card, { ...binding, deliveryId: row.id });
      if (JSON.stringify(previousRendering?.card) !== row.card_json
        || JSON.stringify(previousRendering?.answers) !== row.answers_json) {
        return { state: 'needs_review', deliveryId: row.id };
      }
      this.#db.prepare(`
        UPDATE cloud_question_delivery SET first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ?
      `).run(this.#clock(), row.id);
      row = this.#deliveryById(row.id);
      if (this.#clock() - row.first_attempt_at >= LARK_DEDUP_WINDOW_MS) return { state: 'needs_review', deliveryId: row.id };
      try {
        const receipt = await this.#lark.sendCard({ actor: binding.actor, card: JSON.parse(row.card_json), idempotencyKey: row.id });
        if (hasReceipt(receipt?.messageId, receipt?.confirmedAt)) {
          this.#db.prepare(`
            UPDATE cloud_question_delivery SET message_id = ?, delivered_at = ?
            WHERE id = ? AND message_id IS NULL
          `).run(receipt.messageId, receipt.confirmedAt, row.id);
          return this.#delivered(this.#deliveryById(row.id));
        }
      } catch {
        // The send may already have succeeded, so the recorded UUID is retained.
      }
      return { state: 'pending', deliveryId: row.id };
    });
  }

  async answer({ deliveryId, messageId, option, actor }) {
    if (!hasText(deliveryId) || !hasText(messageId) || !Number.isSafeInteger(option) || option < 0) {
      return { state: 'rejected' };
    }
    const row = this.#deliveryById(deliveryId);
    if (!row || row.message_id !== messageId) return { state: 'rejected' };
    const source = sourceOf(row);
    const binding = await this.#bindings(source);
    const clickActor = actorKey(actor);
    if (!clickActor || clickActor !== actorKey(binding?.actor) || bindingKey(binding) !== row.binding_key
      || binding.mode !== 'answer' || !JSON.parse(row.answers_json)[option]) return { state: 'rejected' };

    return this.#once(`answer:${deliveryId}`, async () => {
      const latest = this.#deliveryById(deliveryId);
      if (latest.raft_receipt_id) return this.#answered(latest);
      if (latest.closed) return { state: 'closed' };
      const input = { source, binding, submissionId: latest.id };
      try {
        if (latest.choice !== null) {
          const existing = await this.#raft.readAnswer(input);
          if (existing?.state !== 'open') return this.#acceptResult(latest.id, existing);
        }

        const card = await this.#raft.readCard(source, binding);
        if (card?.recipientId !== source.recipientId || this.#expired(card)
          || this.#clock() - Date.parse(row.delivered_at) >= LARK_INTERACTION_MS) return { state: 'rejected' };
        const current = renderQuestionCard(card, { ...binding, deliveryId: row.id });
        if (JSON.stringify(current?.card) !== row.card_json || JSON.stringify(current?.answers) !== row.answers_json) {
          return { state: 'rejected' };
        }

        this.#db.prepare('UPDATE cloud_question_delivery SET choice = COALESCE(choice, ?) WHERE id = ?').run(option, row.id);
        const choice = this.#deliveryById(row.id).choice;
        const answer = JSON.parse(row.answers_json)[choice];
        return this.#acceptResult(row.id, await this.#raft.submitAnswer({ ...input, answer }));
      } catch {
        // Reconcile the original submission ID before another write attempt.
        return { state: 'pending' };
      }
    });
  }

  #expired(card) {
    if (!card?.expiresAt) return false;
    const deadline = Date.parse(card.expiresAt);
    return !Number.isFinite(deadline) || this.#clock() >= deadline;
  }

  #delivered(row) {
    this.#recordTrace(row, 'delivery', row.message_id, row.delivered_at);
    return { state: 'delivered', deliveryId: row.id, messageId: row.message_id };
  }

  #answered(row) {
    this.#recordTrace(row, 'reply', row.raft_receipt_id, row.answered_at);
    return { state: 'answered', receiptId: row.raft_receipt_id };
  }

  #recordTrace(row, kind, providerReceiptId, confirmedAt) {
    try {
      this.#trace?.record({ serverId: row.server_id, deliveryId: row.id, kind, providerReceiptId, confirmedAt,
        senderName: row.sender_name, recipientName: row.recipient_name });
    } catch {
      // Reporting cannot undo a confirmed primary send or answer.
    }
  }

  #acceptResult(id, result) {
    if (result?.state === 'closed' || (result?.state === 'answered' && hasText(result.submissionId) && result.submissionId !== id)) {
      this.#db.prepare('UPDATE cloud_question_delivery SET closed = 1 WHERE id = ? AND raft_receipt_id IS NULL').run(id);
      return { state: 'closed' };
    }
    if (result?.state !== 'answered' || result.submissionId !== id || !hasReceipt(result.receiptId, result.confirmedAt)) {
      return { state: 'pending' };
    }

    this.#db.prepare(`
      UPDATE cloud_question_delivery SET raft_receipt_id = ?, answered_at = ?
      WHERE id = ? AND raft_receipt_id IS NULL
    `).run(result.receiptId, result.confirmedAt, id);
    return this.#answered(this.#deliveryById(id));
  }
}
