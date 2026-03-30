import { test, describe } from "node:test";
import assert from "node:assert";
import { buildPrompt, parseTimeArg, extractApiError, type DigestMessage } from "./digest-engine.js";

const sampleMessages: DigestMessage[] = [
  {
    chatId: "g1", chatType: "GROUP", chatName: "Marketing Team",
    senderId: "u1", senderName: "Amy", contentType: "TEXT",
    text: "The PPT is ready", timestamp: new Date("2026-03-26T07:15:00+08:00").getTime(),
  },
  {
    chatId: "g1", chatType: "GROUP", chatName: "Marketing Team",
    senderId: "u2", senderName: "Kevin", contentType: "TEXT",
    text: "Client visit at 3pm, everyone prepare", timestamp: new Date("2026-03-26T07:18:00+08:00").getTime(),
  },
  {
    chatId: "u3", chatType: "USER", chatName: "Jenny",
    senderId: "u3", senderName: "Jenny", contentType: "TEXT",
    text: "Want to try the new restaurant Saturday?", timestamp: new Date("2026-03-26T07:45:00+08:00").getTime(),
  },
  {
    chatId: "g2", chatType: "GROUP", chatName: "College Friends",
    senderId: "u4", senderName: "David", contentType: "STICKER",
    text: null, timestamp: new Date("2026-03-26T07:30:00+08:00").getTime(),
  },
  {
    chatId: "g1", chatType: "GROUP", chatName: "Marketing Team",
    senderId: "u1", senderName: "Amy", contentType: "TEXT",
    text: "Have you finished the material?", timestamp: new Date("2026-03-26T07:50:00+08:00").getTime(),
  },
];

describe("buildPrompt", () => {
  test("groups messages by chat and sorts by time", () => {
    const prompt = buildPrompt(sampleMessages, 12);
    assert.ok(prompt.includes("[群組: Marketing Team]"));
    assert.ok(prompt.includes("[群組: College Friends]"));
    assert.ok(prompt.includes("[私訊: Jenny]"));
    assert.ok(prompt.includes("The PPT is ready"));
    assert.ok(prompt.includes("[貼圖]"));
    assert.ok(prompt.includes("LINE 訊息摘要助手"));
  });

  test("returns empty string for no messages", () => {
    const prompt = buildPrompt([], 12);
    assert.strictEqual(prompt, "");
  });
});

describe("parseTimeArg", () => {
  test("parses hours", () => {
    assert.strictEqual(parseTimeArg("3h"), 3 * 60 * 60 * 1000);
    assert.strictEqual(parseTimeArg("12h"), 12 * 60 * 60 * 1000);
  });

  test("parses minutes", () => {
    assert.strictEqual(parseTimeArg("30m"), 30 * 60 * 1000);
  });

  test("parses days", () => {
    assert.strictEqual(parseTimeArg("1d"), 24 * 60 * 60 * 1000);
    assert.strictEqual(parseTimeArg("7d"), 7 * 24 * 60 * 60 * 1000);
  });

  test("returns null for invalid input", () => {
    assert.strictEqual(parseTimeArg("abc"), null);
    assert.strictEqual(parseTimeArg("3x"), null);
    assert.strictEqual(parseTimeArg(""), null);
  });
});

describe("extractApiError", () => {
  test("extracts quota error from status 429", () => {
    const err = { status: 429, message: "You exceeded your current quota" };
    const result = extractApiError(err);
    assert.strictEqual(result.code, 429);
    assert.strictEqual(result.isQuota, true);
    assert.ok(result.message.includes("quota"));
  });

  test("extracts quota error from RESOURCE_EXHAUSTED message", () => {
    const err = { message: "RESOURCE_EXHAUSTED: limit exceeded" };
    const result = extractApiError(err);
    assert.strictEqual(result.isQuota, true);
  });

  test("extracts non-quota error", () => {
    const err = { status: 403, message: "API key not valid" };
    const result = extractApiError(err);
    assert.strictEqual(result.code, 403);
    assert.strictEqual(result.isQuota, false);
    assert.ok(result.message.includes("not valid"));
  });

  test("handles plain Error objects", () => {
    const err = new Error("Network timeout");
    const result = extractApiError(err);
    assert.strictEqual(result.code, null);
    assert.strictEqual(result.isQuota, false);
    assert.ok(result.message.includes("Network timeout"));
  });

  test("handles nested response status", () => {
    const err = { response: { status: 429 }, message: "rate limit hit" };
    const result = extractApiError(err);
    assert.strictEqual(result.code, 429);
    assert.strictEqual(result.isQuota, true);
  });
});
