import cron from "node-cron";
import { parseTimeArg, type DigestEngine } from "./digest-engine.js";
import type { LineClient } from "./line-client.js";
import type { MessageStore } from "./message-store.js";
import type { Config } from "./config.js";
import { log, logError } from "./logger.js";

export type Command =
  | { type: "digest"; timeWindowMs?: number }
  | { type: "status" }
  | { type: "error"; message: string };

export function parseCommand(text: string): Command | null {
  if (!text.startsWith("/")) return null;

  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "/digest") {
    if (parts.length === 1) {
      return { type: "digest", timeWindowMs: undefined };
    }
    const timeMs = parseTimeArg(parts[1]);
    if (timeMs === null) {
      return { type: "error", message: "格式：/digest 或 /digest 3h" };
    }
    return { type: "digest", timeWindowMs: timeMs };
  }

  if (cmd === "/status") {
    return { type: "status" };
  }

  return null;
}

export class Scheduler {
  private config: Config;
  private engine: DigestEngine;
  private lineClient: LineClient;
  private store: MessageStore;
  private cronTask: cron.ScheduledTask | null = null;
  private startTime = Date.now();
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: Config,
    engine: DigestEngine,
    lineClient: LineClient,
    store: MessageStore,
  ) {
    this.config = config;
    this.engine = engine;
    this.lineClient = lineClient;
    this.store = store;
  }

  start(): void {
    this.cronTask = cron.schedule(
      this.config.digest.schedule,
      async () => {
        log("SCHEDULER", "Cron triggered.");
        await this.runDigest("scheduled");
      },
      { timezone: this.config.digest.timezone }
    );
    log("SCHEDULER", `Cron scheduled: ${this.config.digest.schedule} (${this.config.digest.timezone})`);

    if (this.config.health.intervalMs > 0) {
      this.healthTimer = setInterval(() => {
        this.logHealth();
      }, this.config.health.intervalMs);
      log("SCHEDULER", `Health check every ${this.config.health.intervalMs / 60000} min.`);
    }
  }

  async handleCommand(text: string): Promise<void> {
    const cmd = parseCommand(text);
    if (!cmd) return;

    log("SCHEDULER", `Command: ${JSON.stringify(cmd)}`);

    switch (cmd.type) {
      case "digest":
        await this.runDigest("manual", cmd.timeWindowMs);
        break;

      case "status":
        await this.sendStatus();
        break;

      case "error":
        await this.lineClient.sendDigest(cmd.message);
        break;
    }
  }

  private async runDigest(mode: "scheduled" | "manual", timeWindowMs?: number): Promise<void> {
    try {
      const result = await this.engine.generate(mode, timeWindowMs);
      if (result === null) {
        if (mode === "manual") {
          await this.lineClient.sendDigest("✅ 沒有新訊息");
        }
      } else {
        await this.lineClient.sendDigest(result);
      }
    } catch (err) {
      logError("SCHEDULER", err);
      try {
        await this.lineClient.sendDigest("⚠️ 摘要產生失敗，請稍後重試 /digest");
      } catch {}
    }
  }

  private async sendStatus(): Promise<void> {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeH = Math.floor(uptimeMs / (60 * 60 * 1000));
    const uptimeM = Math.floor((uptimeMs % (60 * 60 * 1000)) / (60 * 1000));

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = this.store.countSince(todayStart.getTime());

    const lastDigest = this.store.getLastDigestTimestamp();
    const lastDigestStr = lastDigest > 0
      ? new Date(lastDigest).toLocaleTimeString("zh-TW", {
          hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei",
        })
      : "尚未產生";

    const status = [
      "📊 LINE Digest 狀態",
      `⏱ 運行時間：${uptimeH}h ${uptimeM}m`,
      `📨 今日訊息：${todayCount} 則`,
      `📋 上次摘要：${lastDigestStr}`,
      `⏰ 排程：${this.config.digest.schedule}`,
    ].join("\n");

    await this.lineClient.sendDigest(status);
  }

  private logHealth(): void {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = this.store.countSince(todayStart.getTime());

    const lastDigest = this.store.getLastDigestTimestamp();
    const lastStr = lastDigest > 0
      ? new Date(lastDigest).toLocaleTimeString("zh-TW", {
          hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei",
        })
      : "never";

    log("HEALTH", `alive | messages today: ${todayCount} | last digest: ${lastStr}`);
  }

  stop(): void {
    this.cronTask?.stop();
    if (this.healthTimer) clearInterval(this.healthTimer);
    log("SCHEDULER", "Stopped.");
  }
}
