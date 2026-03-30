import { loadConfig } from "./config.js";
import { log, logError } from "./logger.js";
import { LineClient } from "./line-client.js";
import { MessageStore } from "./message-store.js";
import { DigestEngine } from "./digest-engine.js";
import { Scheduler, parseCommand } from "./scheduler.js";
import type { TalkMessage } from "@evex/linejs";

async function main() {
  const isLoginMode = process.argv.includes("--login");

  log("MAIN", `Starting line-digest ${isLoginMode ? "(login mode)" : "(daemon mode)"}...`);

  const config = loadConfig();
  const lineClient = new LineClient(config);

  // Login
  await lineClient.login();

  if (isLoginMode) {
    log("MAIN", "Login complete. Auth token saved. Run without --login to start daemon.");
    process.exit(0);
  }

  // If no auth token was available and we just did QR login, we're now in daemon mode
  const store = new MessageStore(config.store.dbPath);
  const engine = new DigestEngine(config, store);

  // Validate Gemini API key on startup — warn but don't block
  const apiCheck = await engine.validateApiKey();
  if (!apiCheck.ok) {
    log("MAIN", `⚠️ Gemini API check failed: ${apiCheck.error}`);
    log("MAIN", "Digest will fail until API key is fixed. Messages will still be stored.");
  }

  const scheduler = new Scheduler(config, engine, lineClient, store);

  // Message handler: filter and route
  lineClient.onMessage(async (message: TalkMessage) => {
    const isMyMessage = message.isMyMessage;
    const text = message.text ?? "";

    // Own messages: check for commands, discard everything else
    if (isMyMessage) {
      const cmd = parseCommand(text);
      if (cmd) {
        await scheduler.handleCommand(text);
      }
      // All other own messages (including digest echoes) are silently discarded
      return;
    }

    // Other people's messages: store in SQLite
    const chatId = message.to.type === "USER"
      ? message.from.id  // DM: use sender's MID as chat ID
      : message.to.id;    // Group/Room: use group/room ID

    const chatType = message.to.type === "USER" ? "USER" : String(message.to.type);

    // Get sender name (cached by linejs internally for groups)
    let senderName: string;
    try {
      senderName = await lineClient.getContactName(message.from.id);
    } catch {
      senderName = message.from.id;
    }

    // Chat name: for DMs use sender name, for groups we don't have a group name API easily
    // so we use the sender name for DMs and leave null for groups (will show chat ID)
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

    log("MSG", `${chatType}:${chatName ?? chatId} | ${senderName}: ${contentType} ${(text).substring(0, 50)}`);
  });

  // Start listening and scheduling
  lineClient.startListening();
  scheduler.start();

  // Retention cleanup: run once on startup + daily at midnight
  store.cleanupOlderThan(config.store.retentionDays);

  // Graceful shutdown
  const shutdown = () => {
    log("MAIN", "Shutting down...");
    scheduler.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("MAIN", "line-digest running. Waiting for messages...");
}

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

main().catch((err) => {
  logError("MAIN", err);
  process.exit(1);
});
