import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { discoverUserMids, UserManager } from "./user-manager.js";
import { UserInstance, type UserProfile } from "./user-instance.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USERS_DIR = join("data", "users");

const fakeConfig: Config = {
  line: { device: "IOSIPAD", authTokenPath: "", storagePath: "" },
  digest: { schedule: "0 8 * * *", timezone: "Asia/Taipei", defaultHours: 12 },
  store: { dbPath: ":memory:", retentionDays: 30 },
  gemini: { apiKey: "fake-key" },
  health: { intervalMs: 0 },
};

function makeProfile(mid: string, name: string): UserProfile {
  return {
    mid,
    name,
    schedule: "0 8 * * *",
    createdAt: new Date().toISOString(),
  };
}

function writeUserJson(mid: string, profile: UserProfile): void {
  const dir = join(USERS_DIR, mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "user.json"), JSON.stringify(profile, null, 2));
}

// Test MIDs — use distinctive prefixes to avoid collisions
const TEST_MID_A = "__test_mgr_a__";
const TEST_MID_B = "__test_mgr_b__";
const TEST_MID_C = "__test_mgr_c__";
const TEST_MIDS = [TEST_MID_A, TEST_MID_B, TEST_MID_C];

function cleanupTestDirs(): void {
  for (const mid of TEST_MIDS) {
    const dir = join(USERS_DIR, mid);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Also clean up the "no_json" dir used in tests
  const noJsonDir = join(USERS_DIR, "__test_mgr_no_json__");
  if (existsSync(noJsonDir)) {
    rmSync(noJsonDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// discoverUserMids
// ---------------------------------------------------------------------------

describe("discoverUserMids", () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  test("finds user directories that have user.json", () => {
    writeUserJson(TEST_MID_A, makeProfile(TEST_MID_A, "Alice"));
    writeUserJson(TEST_MID_B, makeProfile(TEST_MID_B, "Bob"));

    const mids = discoverUserMids();
    assert.ok(mids.includes(TEST_MID_A), `Expected to find ${TEST_MID_A}`);
    assert.ok(mids.includes(TEST_MID_B), `Expected to find ${TEST_MID_B}`);
  });

  test("ignores directories without user.json", () => {
    writeUserJson(TEST_MID_A, makeProfile(TEST_MID_A, "Alice"));

    // Create a directory WITHOUT user.json
    const noJsonMid = "__test_mgr_no_json__";
    mkdirSync(join(USERS_DIR, noJsonMid), { recursive: true });
    writeFileSync(join(USERS_DIR, noJsonMid, "other-file.txt"), "not a profile");

    const mids = discoverUserMids();
    assert.ok(mids.includes(TEST_MID_A), `Expected to find ${TEST_MID_A}`);
    assert.ok(!mids.includes(noJsonMid), `Should NOT find ${noJsonMid}`);
  });

  test("returns empty array when data/users does not exist or is empty", () => {
    // With no test users written, existing dirs may be present but our test
    // MIDs should not be. Just ensure no crash.
    const mids = discoverUserMids();
    assert.ok(Array.isArray(mids));
  });
});

// ---------------------------------------------------------------------------
// UserManager — synchronous operations
// ---------------------------------------------------------------------------

describe("UserManager", () => {
  beforeEach(() => {
    cleanupTestDirs();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  test("constructor ensures data/users directory exists", () => {
    const _mgr = new UserManager(fakeConfig);
    assert.ok(existsSync(USERS_DIR));
  });

  test("addUser saves profile and makes user retrievable", () => {
    const mgr = new UserManager(fakeConfig);
    const profile = makeProfile(TEST_MID_A, "Alice");

    const instance = new UserInstance(profile, fakeConfig);

    mgr.addUser(instance);

    assert.strictEqual(mgr.size, 1);
    assert.ok(mgr.getUser(TEST_MID_A));
    assert.strictEqual(mgr.getUser(TEST_MID_A)!.profile.name, "Alice");

    // Profile should be persisted to disk
    assert.ok(existsSync(join(USERS_DIR, TEST_MID_A, "user.json")));
  });

  test("removeUser shuts down and removes from map", () => {
    const mgr = new UserManager(fakeConfig);
    const profile = makeProfile(TEST_MID_A, "Alice");

    const instance = new UserInstance(profile, fakeConfig);

    mgr.addUser(instance);
    assert.strictEqual(mgr.size, 1);

    mgr.removeUser(TEST_MID_A);
    assert.strictEqual(mgr.size, 0);
    assert.strictEqual(mgr.getUser(TEST_MID_A), undefined);
  });

  test("getUser returns undefined for unknown MID", () => {
    const mgr = new UserManager(fakeConfig);
    assert.strictEqual(mgr.getUser("nonexistent"), undefined);
  });

  test("listUsers returns profiles and statuses", () => {
    const mgr = new UserManager(fakeConfig);
    const profileA = makeProfile(TEST_MID_A, "Alice");
    const profileB = makeProfile(TEST_MID_B, "Bob");

    const instanceA = new UserInstance(profileA, fakeConfig);
    const instanceB = new UserInstance(profileB, fakeConfig);

    mgr.addUser(instanceA);
    mgr.addUser(instanceB);

    const list = mgr.listUsers();
    assert.strictEqual(list.length, 2);

    const names = list.map((u) => u.profile.name).sort();
    assert.deepStrictEqual(names, ["Alice", "Bob"]);

    // Each entry should have a status object
    for (const entry of list) {
      assert.ok("online" in entry.status);
      assert.ok("messageCountToday" in entry.status);
      assert.ok("lastDigest" in entry.status);
    }
  });

  test("shutdownAll clears all users", () => {
    const mgr = new UserManager(fakeConfig);

    mgr.addUser(new UserInstance(makeProfile(TEST_MID_A, "Alice"), fakeConfig));
    mgr.addUser(new UserInstance(makeProfile(TEST_MID_B, "Bob"), fakeConfig));
    assert.strictEqual(mgr.size, 2);

    mgr.shutdownAll();
    assert.strictEqual(mgr.size, 0);
  });

  test("size getter reflects current user count", () => {
    const mgr = new UserManager(fakeConfig);
    assert.strictEqual(mgr.size, 0);

    mgr.addUser(new UserInstance(makeProfile(TEST_MID_A, "Alice"), fakeConfig));
    assert.strictEqual(mgr.size, 1);

    mgr.addUser(new UserInstance(makeProfile(TEST_MID_B, "Bob"), fakeConfig));
    assert.strictEqual(mgr.size, 2);

    mgr.removeUser(TEST_MID_A);
    assert.strictEqual(mgr.size, 1);
  });
});
