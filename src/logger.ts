import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = process.env.DIGEST_LOG_PATH
  ? resolve(process.env.DIGEST_LOG_PATH)
  : resolve(ROOT_DIR, "data/digest.log");

try {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
} catch {}

export function log(tag: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const line = `[${ts}] [${tag}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {}
  if (process.env.NODE_ENV !== "test") {
    process.stdout.write(line);
  }
}

export function logError(tag: string, error: unknown): void {
  const err =
    error instanceof Error
      ? `${error.message}\n${error.stack}`
      : JSON.stringify(error);
  log(tag, `ERROR: ${err}`);
}
