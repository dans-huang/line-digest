import { test, describe } from "node:test";
import assert from "node:assert";
import { generateSessionId } from "./web-server.js";

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

describe("generateSessionId", () => {
  test("returns a string of at least 8 characters", () => {
    const id = generateSessionId();
    assert.ok(typeof id === "string");
    assert.ok(id.length >= 8, `Expected length >= 8, got ${id.length}`);
  });

  test("returns exactly 16 hex characters", () => {
    const id = generateSessionId();
    assert.strictEqual(id.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(id), `Expected hex string, got "${id}"`);
  });

  test("generates unique IDs across multiple calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateSessionId());
    }
    assert.strictEqual(ids.size, 100, "Expected 100 unique session IDs");
  });
});
