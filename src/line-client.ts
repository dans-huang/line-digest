import { loginWithQR, loginWithAuthToken, type Client, type TalkMessage } from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import qrcode from "qrcode-terminal";
import undici from "undici";
import { log, logError } from "./logger.js";
import type { Config } from "./config.js";

// HTTP/2-enabled fetch for LINE push connection.
// @evex/linejs creates Request objects internally; undici can't parse them directly.
const h2Dispatcher = new undici.Agent({ allowH2: true });
const h2Fetch = async (input: any): Promise<any> => {
  if (input instanceof Request) {
    const url = input.url;
    const isPush = url.includes("/PUSH/");
    let body: any = null;
    if (input.body) {
      if (isPush) {
        body = input.body;
      } else {
        try {
          body = Buffer.from(await input.arrayBuffer());
        } catch {
          body = input.body;
        }
      }
    }
    return undici.fetch(url, {
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      body,
      duplex: "half" as any,
      dispatcher: h2Dispatcher,
    });
  }
  return undici.fetch(input, { dispatcher: h2Dispatcher });
};

export type MessageHandler = (message: TalkMessage) => Promise<void>;

export class LineClient {
  private client: Client | null = null;
  private config: Config;
  private authToken: string | null = null;
  private noE2EE = new Set<string>();
  private _myMid: string | null = null;

  constructor(config: Config) {
    this.config = config;
    this.loadAuthToken();
  }

  get myMid(): string {
    if (!this._myMid) throw new Error("MID not available — login first");
    return this._myMid;
  }

  private loadAuthToken(): void {
    const path = this.config.line.authTokenPath;
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        this.authToken = data.authToken ?? null;
        log("LINE", `Auth token loaded: ${this.authToken ? "yes" : "no"}`);
      } catch (err) {
        logError("LINE", err);
        this.authToken = null;
      }
    }
  }

  private saveAuthToken(token: string): void {
    writeFileSync(
      this.config.line.authTokenPath,
      JSON.stringify({ authToken: token }, null, 2)
    );
    this.authToken = token;
    log("LINE", "Auth token saved.");
  }

  hasAuthToken(): boolean {
    return this.authToken !== null;
  }

  async login(): Promise<void> {
    const storage = new FileStorage(this.config.line.storagePath);
    const device = this.config.line.device as any;

    if (this.authToken) {
      log("LINE", "Attempting token login...");
      try {
        this.client = await loginWithAuthToken(this.authToken, {
          device,
          storage,
          fetch: h2Fetch as any,
        });
        this.setupTokenRefresh();
        await this.acquireMid();
        log("LINE", "Token login successful.");
        return;
      } catch (err) {
        logError("LINE", err);
        log("LINE", "Token login failed, falling back to QR.");
      }
    }

    log("LINE", "QR code login...");
    this.client = await loginWithQR(
      {
        onReceiveQRUrl(url) {
          console.log("\nScan this QR code with LINE:\n");
          qrcode.generate(url, { small: true }, (code: string) => {
            console.log(code);
          });
          console.log("Or open:", url, "\n");
        },
        onPincodeRequest(pincode) {
          console.log(`Enter PIN in LINE app: ${pincode}`);
        },
      },
      { device, storage, fetch: h2Fetch as any }
    );

    const token = this.client.base.authToken;
    this.setupTokenRefresh();

    if (token) {
      this.saveAuthToken(token);
    } else {
      log("LINE", "WARNING: No authToken after QR login.");
    }

    await this.acquireMid();
    log("LINE", "QR login successful.");
  }

  private async acquireMid(): Promise<void> {
    if (!this.client) throw new Error("Not logged in");
    const profile = this.client.base.profile ?? await this.client.base.talk.getProfile();
    this._myMid = profile.mid;
    log("LINE", `My MID: ${this._myMid}`);
  }

  private setupTokenRefresh(): void {
    if (!this.client) return;
    this.client.base.on("update:authtoken", (token) => {
      log("LINE", "Auth token refreshed.");
      this.saveAuthToken(token);
    });
  }

  onMessage(handler: MessageHandler): void {
    if (!this.client) throw new Error("Not logged in");
    this.client.on("message", async (message) => {
      try {
        await handler(message);
      } catch (err) {
        logError("LINE:msg", err);
      }
    });
    log("LINE", "Message handler registered.");
  }

  startListening(): void {
    if (!this.client) throw new Error("Not logged in");
    this.client.listen({ talk: true, square: false });
    log("LINE", "Listening for messages.");
  }

  async sendText(to: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Not logged in");

    if (this.noE2EE.has(to)) {
      await this.client.base.talk.sendMessage({ to, text, e2ee: false });
      return;
    }

    try {
      await this.client.base.talk.sendMessage({ to, text, e2ee: true });
    } catch (err: any) {
      const errStr = String(err?.type ?? "") + String(err?.message ?? "") + String(err?.name ?? "");
      if (errStr.includes("E2EE")) {
        this.noE2EE.add(to);
        log("LINE", `E2EE unsupported for ${to}, retrying without.`);
        await this.client.base.talk.sendMessage({ to, text, e2ee: false });
      } else {
        throw err;
      }
    }
  }

  async sendDigest(text: string): Promise<void> {
    log("LINE", "Sending digest to self...");
    await this.sendText(this.myMid, text);
    log("LINE", "Digest delivered.");
  }

  async getContactName(mid: string): Promise<string> {
    if (!this.client) return mid;
    try {
      const contact = await this.client.base.talk.getContact({ mid });
      return contact.displayName ?? mid;
    } catch {
      return mid;
    }
  }
}
