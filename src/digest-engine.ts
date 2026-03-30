import type { Config } from "./config.js";
import type { MessageStore, StoredMessage } from "./message-store.js";
import { log, logError } from "./logger.js";

export type DigestMessage = Omit<StoredMessage, "lineMessageId">;

const SYSTEM_PROMPT = `你是一個 LINE 訊息摘要助手。以下是用戶的 LINE 訊息。

請產生一份簡潔的摘要，包含：
1. 需要回覆的訊息（誰在找你、什麼事、哪個群組）
2. 重要資訊更新（決定、公告、截止日期）
3. 可以忽略的（閒聊、貼圖、重複訊息）

格式規則：
- 使用繁體中文
- 每個群組/對話用【】標示名稱
- 需回覆的項目用 → 開頭
- 時間用 (HH:MM) 格式
- 可略過的合併為一行統計

輸出格式：
📌 需要回覆
━━━━━━━━━━
【群組名/人名】
→ 摘要 (HH:MM)

📋 重要更新
━━━━━━━━━━
【群組名/人名】摘要

💤 可略過
━━━━━━━━━━
N 則閒聊 · N 則貼圖

如果某個分類沒有內容，省略該分類。`;

export function buildPrompt(messages: DigestMessage[], hours: number): string {
  if (messages.length === 0) return "";

  const groups = new Map<string, DigestMessage[]>();
  for (const msg of messages) {
    const existing = groups.get(msg.chatId) ?? [];
    existing.push(msg);
    groups.set(msg.chatId, existing);
  }

  const sections: string[] = [];
  for (const [chatId, msgs] of groups) {
    const sorted = msgs.sort((a, b) => a.timestamp - b.timestamp);
    const first = sorted[0];
    const label =
      first.chatType === "USER"
        ? `[私訊: ${first.chatName ?? first.senderId}]`
        : `[群組: ${first.chatName ?? chatId}]`;

    const lines = sorted.map((m) => {
      const time = new Date(m.timestamp).toLocaleTimeString("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Taipei",
      });
      const content =
        m.contentType === "TEXT"
          ? m.text ?? ""
          : m.contentType === "STICKER"
            ? "[貼圖]"
            : m.contentType === "IMAGE"
              ? "[圖片]"
              : m.contentType === "VIDEO"
                ? "[影片]"
                : `[${m.contentType}]`;
      return `${m.senderName ?? m.senderId} (${time}): ${content}`;
    });

    sections.push(`${label}\n${lines.join("\n")}`);
  }

  return `${SYSTEM_PROMPT}\n\n---\n過去 ${hours} 小時的訊息（共 ${messages.length} 則）：\n\n${sections.join("\n\n")}`;
}

export function parseTimeArg(arg: string): number | null {
  const match = arg.match(/^(\d+)([mhd])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

export function extractApiError(err: unknown): { code: number | null; message: string; isQuota: boolean } {
  const errObj = err as any;
  const status = errObj?.status ?? errObj?.response?.status ?? errObj?.code ?? null;
  const message = errObj?.message ?? String(err);
  const isQuota = status === 429
    || message.includes("RESOURCE_EXHAUSTED")
    || message.includes("quota")
    || message.includes("rate limit")
    || message.includes("Rate limit");
  return { code: status, message, isQuota };
}

// Unified LLM call — auto-detects Anthropic vs OpenAI-compatible based on baseUrl
export async function callLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const isAnthropic = baseUrl.includes("anthropic.com");

  if (isAnthropic) {
    return callAnthropic(baseUrl, apiKey, model, prompt);
  }
  return callOpenAICompatible(baseUrl, apiKey, model, prompt);
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const url = `${baseUrl}/messages`;
  log("LLM", `POST ${url} model=${model} prompt=${prompt.length} chars (anthropic)`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const body = await res.json() as any;

  if (!res.ok) {
    const errMsg = body?.error?.message ?? JSON.stringify(body);
    log("LLM", `HTTP ${res.status}: ${errMsg}`);
    return { ok: false, status: res.status, error: errMsg };
  }

  const text = body?.content?.[0]?.text ?? "";
  if (!text) {
    log("LLM", `Empty response: ${JSON.stringify(body).substring(0, 200)}`);
    return { ok: false, status: 200, error: "Empty response from LLM" };
  }

  log("LLM", `Success. Response: ${text.length} chars, model: ${body?.model ?? "unknown"}`);
  return { ok: true, text };
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  const url = `${baseUrl}/chat/completions`;
  log("LLM", `POST ${url} model=${model} prompt=${prompt.length} chars (openai-compat)`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const body = await res.json() as any;

  if (!res.ok) {
    const errMsg = body?.error?.message ?? JSON.stringify(body);
    log("LLM", `HTTP ${res.status}: ${errMsg}`);
    return { ok: false, status: res.status, error: errMsg };
  }

  const text = body?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    log("LLM", `Empty response: ${JSON.stringify(body).substring(0, 200)}`);
    return { ok: false, status: 200, error: "Empty response from LLM" };
  }

  log("LLM", `Success. Response: ${text.length} chars, model: ${body?.model ?? "unknown"}`);
  return { ok: true, text };
}

export class DigestEngine {
  private store: MessageStore;
  private config: Config;
  private generating = false;

  constructor(config: Config, store: MessageStore) {
    this.config = config;
    this.store = store;
  }

  async validateApiKey(): Promise<{ ok: boolean; error?: string }> {
    log("DIGEST", `Validating LLM API key (${this.config.llm.baseUrl}, model: ${this.config.llm.model})...`);
    const result = await callLLM(
      this.config.llm.baseUrl,
      this.config.llm.apiKey,
      this.config.llm.model,
      "Reply with OK",
    );
    if (result.ok) {
      log("DIGEST", `API key valid. Test response: "${result.text.substring(0, 50)}"`);
      return { ok: true };
    }
    const msg = result.status === 429
      ? `配額已用完 (429). 需要更換 API key 或升級方案.`
      : result.status === 401
        ? `API key 無效 (401): ${result.error}`
        : `API 錯誤 (${result.status}): ${result.error}`;
    log("DIGEST", `Validation failed: ${msg}`);
    return { ok: false, error: msg };
  }

  async generate(mode: "scheduled" | "manual", timeWindowMs?: number): Promise<string | null> {
    if (this.generating) {
      log("DIGEST", "Already generating, waiting...");
      while (this.generating) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.generating = true;
    try {
      return await this._generate(mode, timeWindowMs);
    } finally {
      this.generating = false;
    }
  }

  private async _generate(mode: "scheduled" | "manual", timeWindowMs?: number): Promise<string | null> {
    const now = Date.now();
    let messages: StoredMessage[];
    let hours: number;

    if (timeWindowMs) {
      const since = now - timeWindowMs;
      messages = this.store.getMessagesSince(since);
      hours = Math.round(timeWindowMs / (60 * 60 * 1000) * 10) / 10;
    } else if (mode === "scheduled") {
      const lastTs = this.store.getLastDigestTimestamp();
      const fallbackSince = now - this.config.digest.defaultHours * 60 * 60 * 1000;
      const since = lastTs > 0 ? lastTs : fallbackSince;
      messages = this.store.getMessagesSince(since);
      hours = Math.round((now - since) / (60 * 60 * 1000) * 10) / 10;
    } else {
      const lastTs = this.store.getLastDigestTimestamp();
      if (lastTs > 0) {
        messages = this.store.getMessagesSince(lastTs);
        hours = Math.round((now - lastTs) / (60 * 60 * 1000) * 10) / 10;
      } else {
        const fallbackSince = now - this.config.digest.defaultHours * 60 * 60 * 1000;
        messages = this.store.getMessagesSince(fallbackSince);
        hours = this.config.digest.defaultHours;
      }
    }

    if (messages.length === 0) {
      log("DIGEST", "No messages to summarize.");
      return null;
    }

    log("DIGEST", `Generating digest: ${messages.length} messages over ~${hours}h`);

    const prompt = buildPrompt(messages, hours);
    const dateStr = new Date(now).toLocaleDateString("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Taipei",
    });
    const timeStr = new Date(now).toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Taipei",
    });

    let summary: string | null = null;
    let lastError: string = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await callLLM(
        this.config.llm.baseUrl,
        this.config.llm.apiKey,
        this.config.llm.model,
        prompt,
      );

      if (result.ok) {
        summary = result.text;
        break;
      }

      lastError = `[${result.status}] ${result.error}`;
      log("DIGEST", `Attempt ${attempt}/3 failed: ${lastError}`);

      if (result.status === 429 || result.status === 401) {
        log("DIGEST", "Auth/quota error — skipping retries.");
        break;
      }
      if (attempt < 3) {
        const delay = attempt * 2000;
        log("DIGEST", `Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!summary) {
      const userMsg = lastError.includes("429")
        ? "⚠️ LLM API 配額已用完。請更換 API key 或升級方案。"
        : lastError.includes("401")
          ? "⚠️ LLM API key 無效。請檢查 .env 中的 LLM_API_KEY。"
          : `⚠️ 摘要產生失敗 (${lastError.substring(0, 100)})\n請稍後重試 /digest`;
      return userMsg;
    }

    if (!timeWindowMs) {
      this.store.setLastDigestTimestamp(now);
    }

    return `📋 LINE 摘要 | ${dateStr} ${timeStr}\n\n${summary}`;
  }
}
