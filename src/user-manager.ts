import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { UserInstance, type UserProfile } from "./user-instance.js";
import { log, logError } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USERS_DIR = join("data", "users");

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scans `data/users/` for directories containing `user.json`.
 * Returns an array of directory names (MIDs).
 */
export function discoverUserMids(): string[] {
  if (!existsSync(USERS_DIR)) return [];

  return readdirSync(USERS_DIR).filter((entry) => {
    const entryPath = join(USERS_DIR, entry);
    try {
      if (!statSync(entryPath).isDirectory()) return false;
    } catch {
      return false;
    }
    return existsSync(join(entryPath, "user.json"));
  });
}

// ---------------------------------------------------------------------------
// UserManager
// ---------------------------------------------------------------------------

const TAG = "USER-MGR";

export class UserManager {
  private readonly baseConfig: Config;
  private users = new Map<string, UserInstance>();

  constructor(baseConfig: Config) {
    this.baseConfig = baseConfig;
    mkdirSync(USERS_DIR, { recursive: true });
  }

  /**
   * Discovers existing user MIDs, loads their profiles, creates UserInstance
   * objects, and attempts to resume each one via token login.
   */
  async loadExistingUsers(): Promise<void> {
    const mids = discoverUserMids();
    log(TAG, `Discovered ${mids.length} user(s) on disk.`);

    for (const mid of mids) {
      const profile = UserInstance.loadProfile(mid);
      if (!profile) {
        log(TAG, `Warning: Could not load profile for ${mid}, skipping.`);
        continue;
      }

      const instance = new UserInstance(profile, this.baseConfig);
      try {
        const ok = await instance.tryResume();
        if (ok) {
          this.users.set(mid, instance);
          log(TAG, `Resumed user ${profile.name} (${mid}).`);
        } else {
          log(TAG, `Warning: Token login failed for ${profile.name} (${mid}), skipping.`);
        }
      } catch (err) {
        logError(TAG, err);
        log(TAG, `Warning: Error resuming ${profile.name} (${mid}), skipping.`);
      }
    }
  }

  /**
   * Adds a user instance to the manager and saves its profile to disk.
   */
  addUser(instance: UserInstance): void {
    instance.saveProfile();
    this.users.set(instance.profile.mid, instance);
    log(TAG, `Added user ${instance.profile.name} (${instance.profile.mid}).`);
  }

  /**
   * Shuts down and removes a user by MID.
   */
  removeUser(mid: string): void {
    const instance = this.users.get(mid);
    if (instance) {
      instance.shutdown();
      this.users.delete(mid);
      log(TAG, `Removed user ${mid}.`);
    }
  }

  /**
   * Returns a user instance by MID, or undefined if not found.
   */
  getUser(mid: string): UserInstance | undefined {
    return this.users.get(mid);
  }

  /**
   * Returns a list of all users with their profiles and statuses (for dashboard).
   */
  listUsers(): Array<{ profile: UserProfile; status: ReturnType<UserInstance["getStatus"]> }> {
    return Array.from(this.users.values()).map((instance) => ({
      profile: instance.profile,
      status: instance.getStatus(),
    }));
  }

  /**
   * Number of active users.
   */
  get size(): number {
    return this.users.size;
  }

  /**
   * Shuts down all user instances and clears the map.
   */
  shutdownAll(): void {
    for (const instance of this.users.values()) {
      instance.shutdown();
    }
    this.users.clear();
    log(TAG, "All users shut down.");
  }
}
