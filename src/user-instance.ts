import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TalkMessage } from "@evex/linejs";
import type { Config } from "./config.js";
import { LineClient, type LoginCallbacks } from "./line-client.js";
import { MessageStore } from "./message-store.js";
import { DigestEngine } from "./digest-engine.js";
import { Scheduler, parseCommand } from "./scheduler.js";
import { log, logError } from "./logger.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface UserProfile {
  mid: string;
  name: string;
  schedule: string;
  createdAt: string;
}

export interface UserPaths {
  dataDir: string;
  authTokenPath: string;
  storagePath: string;
  dbPath: string;
  profilePath: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const DATA_ROOT = "data/users";

export function deriveUserPaths(mid: string): UserPaths {
  const dataDir = join(DATA_ROOT, mid);
  return {
    dataDir,
    authTokenPath: join(dataDir, "line-auth.json"),
    storagePath: join(dataDir, "storage.json"),
    dbPath: join(dataDir, "messages.db"),
    profilePath: join(dataDir, "user.json"),
  };
}

// ---------------------------------------------------------------------------
// Content-type mapping (moved from main.ts)
// ---------------------------------------------------------------------------

function mapContentType(raw: string | undefined): string {
  switch (raw) {
    case "NONE": return "TEXT";
    case "IMAGE": return "IMAGE";
    case "VIDEO": return "VIDEO";
    case "STICKER": return "STICKER";
    case "AUDIO": return "AUDIO";
    default: return raw ?? "OTHER";
  }
}

// ---------------------------------------------------------------------------
// UserInstance
// ---------------------------------------------------------------------------

export class UserInstance {
  readonly profile: UserProfile;
  private readonly paths: UserPaths;
  private readonly config: Config;

  private lineClient: LineClient;
  private store: MessageStore | null = null;
  private engine: DigestEngine | null = null;
  private scheduler: Scheduler | null = null;

  constructor(profile: UserProfile, baseConfig: Config) {
    this.profile = profile;
    this.paths = deriveUserPaths(profile.mid);

    // Ensure per-user data directory exists
    mkdirSync(this.paths.dataDir, { recursive: true });

    // Create per-user config by overriding paths and schedule
    this.config = {
      ...baseConfig,
      line: {
        ...baseConfig.line,
        authTokenPath: this.paths.authTokenPath,
        storagePath: this.paths.storagePath,
      },
      digest: {
        ...baseConfig.digest,
        schedule: profile.schedule,
      },
      store: {
        ...baseConfig.store,
        dbPath: this.paths.dbPath,
      },
    };

    this.lineClient = new LineClient(this.config);
  }

  // ---- Login ----

  /**
   * Attempt token-based login. If successful, starts the daemon
   * (message handler + listening + scheduler + cleanup).
   * Returns true if login succeeded, false otherwise.
   */
  async tryResume(): Promise<boolean> {
    const ok = await this.lineClient.tryTokenLogin();
    if (!ok) return false;

    this.startDaemon();
    return true;
  }

  /**
   * Delegates QR login to the underlying LineClient.
   */
  async loginWithQR(callbacks: LoginCallbacks): Promise<void> {
    await this.lineClient.loginWithQR(callbacks);
  }

  // ---- Daemon ----

  /**
   * Wires message handler, starts listening for messages,
   * starts the cron scheduler, and runs DB cleanup.
   */
  startDaemon(): void {
    this.store = new MessageStore(this.config.store.dbPath);
    this.engine = new DigestEngine(this.config, this.store);
    this.scheduler = new Scheduler(this.config, this.engine, this.lineClient, this.store);

    this.wireMessageHandler();
    this.lineClient.startListening();
    this.scheduler.start();
    this.store.cleanupOlderThan(this.config.store.retentionDays);

    log(this.tag, "Daemon started.");
  }

  // ---- Commands ----

  /**
   * Send a test message to the user's own Keep Memo / self-chat.
   */
  async sendTestMessage(time: string): Promise<void> {
    await this.lineClient.sendDigest(
      `✅ LINE Smart Digest 設定成功！\n\n` +
      `這是測試訊息，代表一切正常運作。\n\n` +
      `明天 ${time} 你會收到第一封 LINE 訊息摘要。\n\n` +
      `指令（在自己的聊天室輸入）：\n` +
      `/digest → 立即產生摘要\n` +
      `/digest 3h → 最近 3 小時\n` +
      `/status → 查看狀態`
    );
    log(this.tag, "Test message sent.");
  }

  /**
   * Update the digest schedule, save profile, and restart the scheduler.
   */
  updateSchedule(cronExpr: string): void {
    this.profile.schedule = cronExpr;
    this.config.digest.schedule = cronExpr;
    this.saveProfile();

    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler.start();
      log(this.tag, `Schedule updated to: ${cronExpr}`);
    }
  }

  // ---- Profile persistence ----

  saveProfile(): void {
    mkdirSync(this.paths.dataDir, { recursive: true });
    writeFileSync(this.paths.profilePath, JSON.stringify(this.profile, null, 2));
    log(this.tag, "Profile saved.");
  }

  static loadProfile(mid: string): UserProfile | null {
    const paths = deriveUserPaths(mid);
    if (!existsSync(paths.profilePath)) return null;
    try {
      const raw = readFileSync(paths.profilePath, "utf-8");
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }

  // ---- Status ----

  getStatus(): { online: boolean; messageCountToday: number; lastDigest: number } {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return {
      online: this.store !== null,
      messageCountToday: this.store?.countSince(todayStart.getTime()) ?? 0,
      lastDigest: this.store?.getLastDigestTimestamp() ?? 0,
    };
  }

  // ---- Lifecycle ----

  shutdown(): void {
    this.scheduler?.stop();
    this.store?.close();
    this.scheduler = null;
    this.engine = null;
    this.store = null;
    log(this.tag, "Shut down.");
  }

  // ---- Accessors ----

  get mid(): string {
    return this.lineClient.myMid;
  }

  // ---- Private helpers ----

  private get tag(): string {
    return `USER:${this.profile.name}`;
  }

  /**
   * Message handler scoped to this user's store — mirrors main.ts logic
   * but prefixes logs with the user's name.
   */
  private wireMessageHandler(): void {
    if (!this.store || !this.scheduler) {
      throw new Error("Cannot wire message handler before daemon components are created");
    }

    const store = this.store;
    const scheduler = this.scheduler;
    const lineClient = this.lineClient;
    const tag = this.tag;

    lineClient.onMessage(async (message: TalkMessage) => {
      const isMyMessage = message.isMyMessage;
      const text = message.text ?? "";

      // Own messages: check for commands, discard everything else
      if (isMyMessage) {
        const cmd = parseCommand(text);
        if (cmd) {
          await scheduler.handleCommand(text);
        }
        return;
      }

      // Other people's messages: store in SQLite
      const chatId = message.to.type === "USER"
        ? message.from.id
        : message.to.id;

      const chatType = message.to.type === "USER" ? "USER" : String(message.to.type);

      let senderName: string;
      try {
        senderName = await lineClient.getContactName(message.from.id);
      } catch {
        senderName = message.from.id;
      }

      const chatName = chatType === "USER" ? senderName : null;

      const rawContentType = (message.raw as any).contentType;
      const contentType = mapContentType(
        typeof rawContentType === "string" ? rawContentType : String(rawContentType ?? "")
      );

      store.insert({
        lineMessageId: (message.raw as any).id ?? `${Date.now()}_${Math.random()}`,
        chatId,
        chatType,
        chatName,
        senderId: message.from.id,
        senderName,
        contentType,
        text: message.text ?? null,
        timestamp: Date.now(),
      });

      log(tag, `${chatType}:${chatName ?? chatId} | ${senderName}: ${contentType} ${text.substring(0, 50)}`);
    });
  }
}
