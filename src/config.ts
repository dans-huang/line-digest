import { readFileSync } from "node:fs";
import { parse } from "yaml";
import "dotenv/config";

export interface Config {
  line: {
    device: string;
    authTokenPath: string;
    storagePath: string;
  };
  digest: {
    schedule: string;
    timezone: string;
    defaultHours: number;
  };
  store: {
    dbPath: string;
    retentionDays: number;
  };
  llm: {
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  health: {
    intervalMs: number;
  };
}

export function parseConfig(yamlStr: string, env: Record<string, string | undefined>): Config {
  const yaml = parse(yamlStr);

  const apiKey = env.LLM_API_KEY ?? env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY not set in environment");

  return {
    line: {
      device: yaml?.line?.device ?? "IOSIPAD",
      authTokenPath: yaml?.line?.authTokenPath ?? "./data/line-auth.json",
      storagePath: yaml?.line?.storagePath ?? "./data/storage.json",
    },
    digest: {
      schedule: yaml?.digest?.schedule ?? "0 8 * * *",
      timezone: yaml?.digest?.timezone ?? "Asia/Taipei",
      defaultHours: yaml?.digest?.defaultHours ?? 12,
    },
    store: {
      dbPath: yaml?.store?.dbPath ?? "./data/messages.db",
      retentionDays: yaml?.store?.retentionDays ?? 30,
    },
    llm: {
      apiKey,
      model: yaml?.llm?.model ?? "claude-haiku-4-5-20251001",
      baseUrl: yaml?.llm?.baseUrl ?? "https://api.anthropic.com/v1",
    },
    health: {
      intervalMs: yaml?.health?.intervalMs ?? 3600000,
    },
  };
}

export function loadConfig(): Config {
  const raw = readFileSync("config.yaml", "utf-8");
  return parseConfig(raw, process.env as Record<string, string | undefined>);
}
