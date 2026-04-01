import { loadConfig } from "./config.js";
import { log, logError } from "./logger.js";
import { UserManager } from "./user-manager.js";
import { startWebServer } from "./web-server.js";

async function main() {
  log("MAIN", "Starting LINE Smart Digest...");

  const config = loadConfig();
  const manager = new UserManager(config);

  // Resume all existing users (token login for each)
  await manager.loadExistingUsers();
  log("MAIN", `Resumed ${manager.size} user(s).`);

  // Start web server (dashboard + onboarding)
  startWebServer(config, manager);

  // Graceful shutdown
  const shutdown = () => {
    log("MAIN", "Shutting down...");
    manager.shutdownAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logError("MAIN", err);
  process.exit(1);
});
