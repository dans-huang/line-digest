import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deriveUserPaths, UserInstance, type UserProfile } from "./user-instance.js";

// ---------------------------------------------------------------------------
// deriveUserPaths
// ---------------------------------------------------------------------------

describe("deriveUserPaths", () => {
  test("returns correct paths under data/users/<mid>/", () => {
    const mid = "u1234567890abcdef";
    const paths = deriveUserPaths(mid);

    assert.strictEqual(paths.dataDir, `data/users/${mid}`);
    assert.strictEqual(paths.authTokenPath, `data/users/${mid}/line-auth.json`);
    assert.strictEqual(paths.storagePath, `data/users/${mid}/storage.json`);
    assert.strictEqual(paths.dbPath, `data/users/${mid}/messages.db`);
    assert.strictEqual(paths.profilePath, `data/users/${mid}/user.json`);
  });

  test("handles different MID values", () => {
    const paths = deriveUserPaths("abc");
    assert.strictEqual(paths.dataDir, "data/users/abc");
    assert.strictEqual(paths.profilePath, "data/users/abc/user.json");
  });
});

// ---------------------------------------------------------------------------
// UserProfile interface shape
// ---------------------------------------------------------------------------

describe("UserProfile", () => {
  test("interface shape is correct", () => {
    const profile: UserProfile = {
      mid: "u_test_mid",
      name: "Test User",
      schedule: "0 8 * * *",
      createdAt: "2026-03-29T00:00:00Z",
    };

    assert.strictEqual(profile.mid, "u_test_mid");
    assert.strictEqual(profile.name, "Test User");
    assert.strictEqual(profile.schedule, "0 8 * * *");
    assert.strictEqual(profile.createdAt, "2026-03-29T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// loadProfile
// ---------------------------------------------------------------------------

describe("UserInstance.loadProfile", () => {
  const testMid = "__test_load_profile__";
  const paths = deriveUserPaths(testMid);

  beforeEach(() => {
    // Clean up before each test
    if (existsSync(paths.dataDir)) {
      rmSync(paths.dataDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(paths.dataDir)) {
      rmSync(paths.dataDir, { recursive: true, force: true });
    }
  });

  test("returns null for non-existent user", () => {
    const result = UserInstance.loadProfile("nonexistent_mid_12345");
    assert.strictEqual(result, null);
  });

  test("returns null for corrupted JSON", () => {
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.profilePath, "not valid json {{{");
    const result = UserInstance.loadProfile(testMid);
    assert.strictEqual(result, null);
  });

  test("loads a valid profile", () => {
    const profile: UserProfile = {
      mid: testMid,
      name: "Load Test",
      schedule: "30 9 * * *",
      createdAt: "2026-01-01T00:00:00Z",
    };
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.profilePath, JSON.stringify(profile, null, 2));

    const loaded = UserInstance.loadProfile(testMid);
    assert.deepStrictEqual(loaded, profile);
  });
});

// ---------------------------------------------------------------------------
// saveProfile round-trip
// ---------------------------------------------------------------------------

describe("UserInstance.saveProfile", () => {
  const testMid = "__test_save_profile__";
  const paths = deriveUserPaths(testMid);

  afterEach(() => {
    if (existsSync(paths.dataDir)) {
      rmSync(paths.dataDir, { recursive: true, force: true });
    }
  });

  test("saveProfile writes and loadProfile reads back", () => {
    // UserInstance constructor needs a valid Config. We fake one just enough
    // for the constructor (it will try to mkdirSync the data dir — that's fine).
    // We can't fully construct a UserInstance without LineClient trying to
    // load auth tokens, but that path won't exist so it just sets null — safe.
    const profile: UserProfile = {
      mid: testMid,
      name: "Save Test",
      schedule: "0 7 * * *",
      createdAt: "2026-03-29T12:00:00Z",
    };

    const fakeConfig = {
      line: { device: "IOSIPAD", authTokenPath: "", storagePath: "" },
      digest: { schedule: "0 8 * * *", timezone: "Asia/Taipei", defaultHours: 12 },
      store: { dbPath: ":memory:", retentionDays: 30 },
      gemini: { apiKey: "fake-key" },
      health: { intervalMs: 0 },
    };

    const instance = new UserInstance(profile, fakeConfig);
    instance.saveProfile();

    const loaded = UserInstance.loadProfile(testMid);
    assert.deepStrictEqual(loaded, profile);
  });
});
