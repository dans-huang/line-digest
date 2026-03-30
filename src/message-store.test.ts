import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import { MessageStore, type StoredMessage } from "./message-store.js";

function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    lineMessageId: "msg_" + Math.random().toString(36).slice(2),
    chatId: "group_abc",
    chatType: "GROUP",
    chatName: "Test Group",
    senderId: "user_123",
    senderName: "Alice",
    contentType: "TEXT",
    text: "Hello world",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("MessageStore", () => {
  let store: MessageStore;

  beforeEach(() => {
    store = new MessageStore(":memory:");
  });

  test("insert and query by time range", () => {
    const now = Date.now();
    store.insert(makeMsg({ timestamp: now - 5000, text: "old" }));
    store.insert(makeMsg({ timestamp: now - 1000, text: "recent" }));
    store.insert(makeMsg({ timestamp: now - 10000, text: "very old" }));

    const msgs = store.getMessagesSince(now - 6000);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].text, "old");
    assert.strictEqual(msgs[1].text, "recent");
  });

  test("query between timestamps", () => {
    const now = Date.now();
    store.insert(makeMsg({ timestamp: now - 10000, text: "before" }));
    store.insert(makeMsg({ timestamp: now - 5000, text: "during" }));
    store.insert(makeMsg({ timestamp: now - 1000, text: "after window" }));

    const msgs = store.getMessagesBetween(now - 8000, now - 2000);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, "during");
  });

  test("deduplicates by lineMessageId", () => {
    const msg = makeMsg({ lineMessageId: "dup_1" });
    store.insert(msg);
    store.insert(msg);
    const msgs = store.getMessagesSince(0);
    assert.strictEqual(msgs.length, 1);
  });

  test("last digest timestamp: default and update", () => {
    assert.strictEqual(store.getLastDigestTimestamp(), 0);

    store.setLastDigestTimestamp(1234567890);
    assert.strictEqual(store.getLastDigestTimestamp(), 1234567890);

    store.setLastDigestTimestamp(9999999999);
    assert.strictEqual(store.getLastDigestTimestamp(), 9999999999);
  });

  test("cleanup removes old messages", () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;

    store.insert(makeMsg({ timestamp: thirtyOneDaysAgo, text: "expired" }));
    store.insert(makeMsg({ timestamp: twentyDaysAgo, text: "keep" }));

    const deleted = store.cleanupOlderThan(30);
    assert.strictEqual(deleted, 1);

    const msgs = store.getMessagesSince(0);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, "keep");
  });

  test("countSince returns message count", () => {
    const now = Date.now();
    store.insert(makeMsg({ timestamp: now - 5000 }));
    store.insert(makeMsg({ timestamp: now - 3000 }));
    store.insert(makeMsg({ timestamp: now - 1000 }));

    assert.strictEqual(store.countSince(now - 4000), 2);
    assert.strictEqual(store.countSince(0), 3);
  });
});
