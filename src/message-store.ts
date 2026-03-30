import Database from "better-sqlite3";
import { log } from "./logger.js";

export interface StoredMessage {
  lineMessageId: string;
  chatId: string;
  chatType: string;
  chatName: string | null;
  senderId: string;
  senderName: string | null;
  contentType: string;
  text: string | null;
  timestamp: number;
}

export class MessageStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line_message_id TEXT UNIQUE,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_name TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT,
        content_type TEXT NOT NULL,
        text TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_chat_id ON messages(chat_id, timestamp);

      CREATE TABLE IF NOT EXISTS digest_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    log("STORE", "Database initialized: " + this.db.name);
  }

  insert(msg: StoredMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (line_message_id, chat_id, chat_type, chat_name, sender_id, sender_name, content_type, text, timestamp)
      VALUES
        (@lineMessageId, @chatId, @chatType, @chatName, @senderId, @senderName, @contentType, @text, @timestamp)
    `);
    stmt.run(msg);
  }

  getMessagesSince(sinceTimestamp: number): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT line_message_id as lineMessageId, chat_id as chatId, chat_type as chatType,
             chat_name as chatName, sender_id as senderId, sender_name as senderName,
             content_type as contentType, text, timestamp
      FROM messages
      WHERE timestamp > ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(sinceTimestamp) as StoredMessage[];
  }

  getMessagesBetween(from: number, to: number): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT line_message_id as lineMessageId, chat_id as chatId, chat_type as chatType,
             chat_name as chatName, sender_id as senderId, sender_name as senderName,
             content_type as contentType, text, timestamp
      FROM messages
      WHERE timestamp > ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(from, to) as StoredMessage[];
  }

  countSince(sinceTimestamp: number): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE timestamp > ?`);
    const row = stmt.get(sinceTimestamp) as { count: number };
    return row.count;
  }

  getLastDigestTimestamp(): number {
    const stmt = this.db.prepare(`SELECT value FROM digest_meta WHERE key = 'last_digest_timestamp'`);
    const row = stmt.get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  setLastDigestTimestamp(ts: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO digest_meta (key, value) VALUES ('last_digest_timestamp', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(String(ts));
  }

  cleanupOlderThan(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(`DELETE FROM messages WHERE timestamp < ?`);
    const result = stmt.run(cutoff);
    log("STORE", `Cleanup: deleted ${result.changes} messages older than ${days} days`);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
