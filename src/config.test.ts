import { test, describe } from "node:test";
import assert from "node:assert";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  test("parses valid YAML with defaults", () => {
    const yaml = `
line:
  device: "IOSIPAD"
digest:
  schedule: "0 8 * * *"
`;
    const config = parseConfig(yaml, { LLM_API_KEY: "test-key" });

    assert.strictEqual(config.line.device, "IOSIPAD");
    assert.strictEqual(config.line.authTokenPath, "./data/line-auth.json");
    assert.strictEqual(config.line.storagePath, "./data/storage.json");
    assert.strictEqual(config.digest.schedule, "0 8 * * *");
    assert.strictEqual(config.digest.timezone, "Asia/Taipei");
    assert.strictEqual(config.digest.defaultHours, 12);
    assert.strictEqual(config.store.dbPath, "./data/messages.db");
    assert.strictEqual(config.store.retentionDays, 30);
    assert.strictEqual(config.llm.apiKey, "test-key");
    assert.strictEqual(config.llm.model, "claude-haiku-4-5-20251001");
    assert.strictEqual(config.llm.baseUrl, "https://api.anthropic.com/v1");
    assert.strictEqual(config.health.intervalMs, 3600000);
  });

  test("overrides defaults from YAML", () => {
    const yaml = `
line:
  device: "DESKTOPWIN"
  authTokenPath: /custom/auth.json
digest:
  schedule: "0 9 * * *"
  timezone: "America/New_York"
  defaultHours: 8
store:
  dbPath: /custom/db.sqlite
  retentionDays: 7
llm:
  model: "anthropic/claude-3-haiku"
  baseUrl: "https://custom.api.com/v1"
health:
  intervalMs: 0
`;
    const config = parseConfig(yaml, { LLM_API_KEY: "key2" });

    assert.strictEqual(config.line.device, "DESKTOPWIN");
    assert.strictEqual(config.line.authTokenPath, "/custom/auth.json");
    assert.strictEqual(config.digest.schedule, "0 9 * * *");
    assert.strictEqual(config.digest.timezone, "America/New_York");
    assert.strictEqual(config.digest.defaultHours, 8);
    assert.strictEqual(config.store.dbPath, "/custom/db.sqlite");
    assert.strictEqual(config.store.retentionDays, 7);
    assert.strictEqual(config.llm.model, "anthropic/claude-3-haiku");
    assert.strictEqual(config.llm.baseUrl, "https://custom.api.com/v1");
    assert.strictEqual(config.health.intervalMs, 0);
  });

  test("throws if LLM_API_KEY missing", () => {
    const yaml = `line:\n  device: "IOSIPAD"`;
    assert.throws(() => parseConfig(yaml, {}), /LLM_API_KEY/);
  });

  test("accepts GEMINI_API_KEY as fallback", () => {
    const yaml = `line:\n  device: "IOSIPAD"`;
    const config = parseConfig(yaml, { GEMINI_API_KEY: "legacy-key" });
    assert.strictEqual(config.llm.apiKey, "legacy-key");
  });
});
