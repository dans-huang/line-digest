import { test, describe } from "node:test";
import assert from "node:assert";
import { parseCommand, type Command } from "./scheduler.js";

describe("parseCommand", () => {
  test("parses /digest with no args", () => {
    const cmd = parseCommand("/digest");
    assert.deepStrictEqual(cmd, { type: "digest", timeWindowMs: undefined });
  });

  test("parses /digest with time arg", () => {
    const cmd = parseCommand("/digest 3h");
    assert.deepStrictEqual(cmd, { type: "digest", timeWindowMs: 3 * 60 * 60 * 1000 });
  });

  test("parses /digest 30m", () => {
    const cmd = parseCommand("/digest 30m");
    assert.deepStrictEqual(cmd, { type: "digest", timeWindowMs: 30 * 60 * 1000 });
  });

  test("parses /digest 1d", () => {
    const cmd = parseCommand("/digest 1d");
    assert.deepStrictEqual(cmd, { type: "digest", timeWindowMs: 24 * 60 * 60 * 1000 });
  });

  test("parses /status", () => {
    const cmd = parseCommand("/status");
    assert.deepStrictEqual(cmd, { type: "status" });
  });

  test("returns error for invalid /digest arg", () => {
    const cmd = parseCommand("/digest xyz");
    assert.deepStrictEqual(cmd, { type: "error", message: "格式：/digest 或 /digest 3h" });
  });

  test("returns null for non-command text", () => {
    assert.strictEqual(parseCommand("hello"), null);
    assert.strictEqual(parseCommand("not a /command"), null);
    assert.strictEqual(parseCommand(""), null);
  });

  test("returns null for unknown commands", () => {
    assert.strictEqual(parseCommand("/unknown"), null);
  });
});
