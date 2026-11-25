import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

function openDatabase(path) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path);
}

export function hash(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

export function routeKey(binding) {
  return hash([binding.id, binding.profile, binding.appId, binding.userId, binding.brand, binding.agentId, binding.agentHandle, binding.chatId, binding.mode]);
}

export function acquireLock(path) {
  const lock = openDatabase(path);
  try { lock.exec('BEGIN EXCLUSIVE'); } catch (error) {
    lock.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Error('此配置目录已有一个桥接进程在运行。');
    throw error;
  }
  return () => lock.close();
}

export class Store {
  constructor(path) {
    this.db = openDatabase(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        binding_key TEXT NOT NULL,
        original_id TEXT NOT NULL,
        origin_time INTEGER NOT NULL,
        forwarded_content TEXT,
        state TEXT NOT NULL DEFAULT 'queued',
        raft_id TEXT,
        thread_key TEXT UNIQUE,
        reply_text TEXT,
        lark_reply_id TEXT,
        first_attempt INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(binding_id, state, next_attempt, origin_time);
    `);
  }

  close() { this.db.close(); }

  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(binding, message, content) {
    const id = hash([binding.brand, binding.appId, binding.userId, message.id]);
    const result = this.db.prepare(`
      INSERT INTO jobs(id, binding_id, binding_key, original_id, origin_time, forwarded_content)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `).run(id, binding.id, routeKey(binding), message.id, message.sentAt, content);
    return result.changes === 1 ? id : null;
  }

  migrateForwardText() {
    this.transaction(() => {
      const key = 'original-forward-text';
      if (this.get(key)) return;
      this.db.prepare("UPDATE jobs SET forwarded_content = NULL WHERE state = 'queued'").run();
      this.set(key, true);
    });
  }

  saveForwardText(id, content) {
    this.db.prepare("UPDATE jobs SET forwarded_content = ? WHERE id = ? AND state = 'queued'").run(content, id);
  }

  pending(binding, state, now, limit = 30) {
    return this.db.prepare(`
      SELECT * FROM jobs WHERE binding_id = ? AND binding_key = ? AND state = ? AND next_attempt <= ?
      ORDER BY origin_time, id LIMIT ?
    `).all(binding.id, routeKey(binding), state, now, limit);
  }

  hasRecentForward(binding, since) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM jobs
      JOIN metadata ON metadata.key = 'raft-forwarded-at:' || jobs.id
      WHERE binding_id = ? AND binding_key = ? AND state = 'forwarded'
        AND CAST(metadata.value AS INTEGER) >= ?
      LIMIT 1
    `).get(binding.id, routeKey(binding), since));
  }

  forwarded(id, raftId, thread, at) {
    this.transaction(() => {
      this.db.prepare(`UPDATE jobs SET state = 'forwarded', raft_id = ?, thread_key = ?, forwarded_content = NULL,
        attempts = 0, next_attempt = 0, first_attempt = NULL, error = NULL WHERE id = ?`).run(raftId, thread, id);
      this.set(`raft-forwarded-at:${id}`, at);
    });
  }

  byThread(thread) { return this.db.prepare('SELECT * FROM jobs WHERE thread_key = ?').get(thread); }

  prepareReply(id, text) {
    this.db.prepare(`UPDATE jobs SET reply_text = ?, state = 'ready' WHERE id = ? AND state = 'forwarded'`).run(text, id);
    const key = `raft-forwarded-at:${id}`;
    const forwardedAt = this.get(key);
    this.db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    return forwardedAt;
  }

  attemptedReply(id, now) {
    this.db.prepare('UPDATE jobs SET first_attempt = COALESCE(first_attempt, ?) WHERE id = ?').run(now, id);
  }

  replied(id, larkId) {
    this.db.prepare(`UPDATE jobs SET state = 'sent', reply_text = NULL, lark_reply_id = ?, error = NULL WHERE id = ?`).run(larkId, id);
  }

  failure(job, error, now, state = job.state) {
    const attempts = job.attempts + 1;
    const delay = Math.min(15_000 * 2 ** Math.min(attempts - 1, 5), 300_000);
    this.db.prepare('UPDATE jobs SET attempts = ?, next_attempt = ?, error = ?, state = ? WHERE id = ?')
      .run(attempts, now + delay, error, state, job.id);
  }

  summary(bindingId) {
    return this.db.prepare(`SELECT state, count(*) AS total FROM jobs WHERE binding_id = ? GROUP BY state`).all(bindingId);
  }

  recentProblems(bindingId) {
    return this.db.prepare(`SELECT original_id, state, error FROM jobs WHERE binding_id = ? AND error IS NOT NULL
      ORDER BY next_attempt DESC LIMIT 5`).all(bindingId);
  }
}
