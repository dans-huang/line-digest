import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { LineClient } from "./line-client.js";
import { UserInstance, type UserProfile } from "./user-instance.js";
import { UserManager } from "./user-manager.js";
import { log, logError } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionState = "idle" | "qr" | "pin" | "logged-in" | "testing" | "done" | "error";

interface OnboardingSession {
  id: string;
  name: string;
  state: SessionState;
  qrUrl: string | null;
  pinCode: string | null;
  error: string | null;
  sseClients: Set<http.ServerResponse>;
  lineClient: LineClient | null;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const sessions = new Map<string, OnboardingSession>();
const ONBOARDING_ROOT = join("data", "onboarding");

export function generateSessionId(): string {
  return randomBytes(8).toString("hex"); // 16 hex chars
}

function getOnboardingPaths(sid: string) {
  const dir = join(ONBOARDING_ROOT, sid);
  return {
    dir,
    authTokenPath: join(dir, "line-auth.json"),
    storagePath: join(dir, "storage.json"),
  };
}

// ---------------------------------------------------------------------------
// Session SSE helper
// ---------------------------------------------------------------------------

function broadcastToSession(session: OnboardingSession, event: string, data: Record<string, unknown> = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of session.sseClients) {
    try {
      client.write(payload);
    } catch {
      session.sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Request body parser
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

const TAG = "WEB";

async function handleApiLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
): Promise<void> {
  const raw = await readBody(req);
  let name: string;
  try {
    name = JSON.parse(raw).name;
    if (!name || typeof name !== "string") throw new Error("missing name");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required" }));
    return;
  }

  const sid = generateSessionId();
  const paths = getOnboardingPaths(sid);
  mkdirSync(paths.dir, { recursive: true });

  // Create a temporary LineClient for onboarding
  const tempConfig: Config = {
    ...config,
    line: {
      ...config.line,
      authTokenPath: paths.authTokenPath,
      storagePath: paths.storagePath,
    },
  };
  const lineClient = new LineClient(tempConfig);

  const session: OnboardingSession = {
    id: sid,
    name,
    state: "idle",
    qrUrl: null,
    pinCode: null,
    error: null,
    sseClients: new Set(),
    lineClient,
  };
  sessions.set(sid, session);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessionId: sid }));

  // Fire-and-forget QR login
  doLogin(session);
}

async function doLogin(session: OnboardingSession): Promise<void> {
  if (!session.lineClient) return;

  try {
    await session.lineClient.loginWithQR({
      onQRUrl: (url) => {
        session.qrUrl = url;
        session.state = "qr";
        broadcastToSession(session, "qr", { url });
      },
      onPincode: (pin) => {
        session.pinCode = pin;
        session.state = "pin";
        broadcastToSession(session, "pin", { code: pin });
      },
    });
    session.state = "logged-in";
    broadcastToSession(session, "logged-in");
  } catch (err: any) {
    const msg = err?.message ?? "登入失敗，請重新整理頁面再試";
    session.error = msg;
    session.state = "error";
    broadcastToSession(session, "login-error", { message: msg });
    logError(TAG, err);
  }
}

async function handleApiConfigure(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: Config,
  manager: UserManager,
): Promise<void> {
  const raw = await readBody(req);
  let sessionId: string;
  let time: string;
  try {
    const body = JSON.parse(raw);
    sessionId = body.sessionId;
    time = body.time;
    if (!sessionId || !time) throw new Error("missing fields");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "sessionId and time are required" }));
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "session not found" }));
    return;
  }

  if (!session.lineClient) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "login not completed" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));

  // Do configure async
  doConfigure(session, time, config, manager);
}

async function doConfigure(
  session: OnboardingSession,
  time: string,
  config: Config,
  manager: UserManager,
): Promise<void> {
  try {
    session.state = "testing";
    broadcastToSession(session, "testing");

    // Parse schedule
    const [h, m] = time.split(":").map(Number);
    const cronExpr = `${m} ${h} * * *`;

    // Get MID from temp lineClient
    const mid = session.lineClient!.myMid;

    // Create proper UserProfile
    const profile: UserProfile = {
      mid,
      name: session.name,
      schedule: cronExpr,
      createdAt: new Date().toISOString(),
    };

    // Create UserInstance (this mkdirs the real user dir)
    const instance = new UserInstance(profile, config);

    // Copy auth + storage from onboarding temp dir to real user dir
    const tempPaths = getOnboardingPaths(session.id);
    const { dataDir } = { dataDir: join("data", "users", mid) };

    if (existsSync(tempPaths.authTokenPath)) {
      cpSync(tempPaths.authTokenPath, join(dataDir, "line-auth.json"));
    }
    if (existsSync(tempPaths.storagePath)) {
      cpSync(tempPaths.storagePath, join(dataDir, "storage.json"));
    }

    // Resume via token login (from copied auth file)
    const ok = await instance.tryResume();
    if (!ok) {
      throw new Error("Failed to resume with token after onboarding");
    }

    // Send test message
    await instance.sendTestMessage(time);

    // Register with manager
    manager.addUser(instance);

    // Clean up temp onboarding dir
    try {
      rmSync(tempPaths.dir, { recursive: true, force: true });
    } catch {}

    // Clean up session lineClient reference
    session.lineClient = null;

    session.state = "done";
    broadcastToSession(session, "test-success");
    log(TAG, `User ${session.name} (${mid}) onboarded successfully.`);
  } catch (err: any) {
    const msg = err?.message ?? "設定失敗，請重試";
    session.error = msg;
    session.state = "error";
    broadcastToSession(session, "test-failed", { message: msg });
    logError(TAG, err);
  }
}

function handleApiUsers(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: UserManager,
): void {
  const users = manager.listUsers();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(users));
}

// ---------------------------------------------------------------------------
// SSE endpoint (scoped to session)
// ---------------------------------------------------------------------------

function handleSSE(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sid: string,
): void {
  const session = sessions.get(sid);
  if (!session) {
    res.writeHead(404);
    res.end("Session not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Replay current state for reconnecting clients
  if (session.state === "qr" && session.qrUrl) {
    res.write(`event: qr\ndata: ${JSON.stringify({ url: session.qrUrl })}\n\n`);
  } else if (session.state === "pin" && session.pinCode) {
    res.write(`event: pin\ndata: ${JSON.stringify({ code: session.pinCode })}\n\n`);
  } else if (session.state === "logged-in") {
    res.write(`event: logged-in\ndata: {}\n\n`);
  } else if (session.state === "done") {
    res.write(`event: test-success\ndata: {}\n\n`);
  } else if (session.state === "error" && session.error) {
    res.write(`event: login-error\ndata: ${JSON.stringify({ message: session.error })}\n\n`);
  }

  session.sseClients.add(res);
  req.on("close", () => session.sseClients.delete(res));
}

// ---------------------------------------------------------------------------
// HTML: Dashboard
// ---------------------------------------------------------------------------

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>LINE Smart Digest</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;
  background:linear-gradient(135deg,#f0fdf4 0%,#f5f5f5 100%);
  color:#333;min-height:100vh;
  padding:40px 20px;
}
.container{max-width:700px;margin:0 auto}
.header{text-align:center;margin-bottom:32px}
.header h1{font-size:28px;font-weight:700;margin-bottom:4px}
.header .logo{font-size:48px;margin-bottom:12px}
.header .subtitle{color:#666;font-size:14px}

.card{
  background:#fff;border-radius:20px;padding:28px 24px;
  box-shadow:0 4px 24px rgba(0,0,0,0.06);margin-bottom:20px;
}

.user-table{width:100%;border-collapse:collapse}
.user-table th{
  text-align:left;font-size:12px;font-weight:600;
  color:#888;text-transform:uppercase;letter-spacing:0.5px;
  padding:8px 12px;border-bottom:2px solid #f0f0f0;
}
.user-table td{
  padding:14px 12px;border-bottom:1px solid #f5f5f5;
  font-size:14px;vertical-align:middle;
}
.user-table tr:last-child td{border-bottom:none}

.status-dot{
  display:inline-block;width:8px;height:8px;border-radius:50%;
  margin-right:6px;vertical-align:middle;
}
.status-dot.online{background:#06C755}
.status-dot.offline{background:#ccc}

.empty-state{
  text-align:center;padding:40px 20px;color:#999;
}
.empty-state p{font-size:15px;margin-bottom:20px;line-height:1.6}

.btn{
  display:inline-block;background:#06C755;color:#fff;border:none;
  border-radius:14px;padding:14px 28px;font-size:15px;font-weight:600;
  cursor:pointer;transition:all .2s;text-decoration:none;
}
.btn:hover{background:#05a648;transform:translateY(-1px);box-shadow:0 4px 12px rgba(6,199,85,0.3)}
.btn:active{transform:translateY(0)}

.btn-bar{text-align:center;margin-top:24px}

.user-name{font-weight:600}
.schedule-badge{
  display:inline-block;background:#f0fdf4;color:#06C755;
  font-size:12px;font-weight:600;padding:3px 10px;
  border-radius:12px;
}
.count-badge{
  display:inline-block;background:#f5f5f5;color:#555;
  font-size:13px;font-weight:500;padding:2px 8px;
  border-radius:8px;
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">💬</div>
    <h1>LINE Smart Digest</h1>
    <p class="subtitle">AI 幫你讀 LINE 訊息，每天一則摘要</p>
  </div>

  <div class="card">
    <div id="user-list"></div>
    <div class="btn-bar">
      <a class="btn" href="/join">新增使用者</a>
    </div>
  </div>
</div>

<script>
async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    const users = await res.json();
    const container = document.getElementById('user-list');

    if (!users.length) {
      container.innerHTML = '<div class="empty-state"><p>還沒有使用者<br>點擊下方按鈕開始設定</p></div>';
      return;
    }

    let html = '<table class="user-table"><thead><tr>' +
      '<th>使用者</th><th>狀態</th><th>今日訊息</th><th>排程</th>' +
      '</tr></thead><tbody>';

    for (const u of users) {
      const online = u.status.online;
      const dotClass = online ? 'online' : 'offline';
      const statusText = online ? '運作中' : '離線';

      // Parse cron schedule to readable time
      let scheduleText = u.profile.schedule;
      const cronParts = u.profile.schedule.split(' ');
      if (cronParts.length >= 2) {
        const min = cronParts[0].padStart(2, '0');
        const hr = cronParts[1].padStart(2, '0');
        scheduleText = hr + ':' + min;
      }

      html += '<tr>' +
        '<td><span class="user-name">' + escapeHtml(u.profile.name) + '</span></td>' +
        '<td><span class="status-dot ' + dotClass + '"></span>' + statusText + '</td>' +
        '<td><span class="count-badge">' + u.status.messageCountToday + '</span></td>' +
        '<td><span class="schedule-badge">' + scheduleText + '</span></td>' +
        '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

loadUsers();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTML: Onboarding
// ---------------------------------------------------------------------------

function getOnboardingHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LINE Smart Digest — 新增使用者</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;
  background:linear-gradient(135deg,#f0fdf4 0%,#f5f5f5 100%);
  color:#333;min-height:100vh;
  display:flex;align-items:center;justify-content:center;
  padding:20px;
}
.container{max-width:400px;width:100%}
.card{
  background:#fff;border-radius:24px;padding:40px 32px;
  box-shadow:0 4px 24px rgba(0,0,0,0.06);text-align:center;
  transition:opacity .3s;
}
.step{display:none;animation:fadeIn .4s ease}
.step.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

h1{font-size:22px;margin-bottom:8px;font-weight:700}
.subtitle{color:#666;font-size:14px;margin-bottom:28px;line-height:1.6}
.logo{font-size:56px;margin-bottom:16px}
.step-tag{
  display:inline-block;background:#f0fdf4;color:#06C755;
  font-size:12px;font-weight:600;padding:4px 12px;
  border-radius:20px;margin-bottom:16px;
}

.btn{
  display:block;width:100%;background:#06C755;color:#fff;border:none;
  border-radius:14px;padding:16px;font-size:16px;font-weight:600;
  cursor:pointer;transition:all .2s;
}
.btn:hover{background:#05a648;transform:translateY(-1px);box-shadow:0 4px 12px rgba(6,199,85,0.3)}
.btn:active{transform:translateY(0)}
.btn:disabled{background:#ccc;cursor:not-allowed;transform:none;box-shadow:none}

.name-input{
  width:100%;padding:16px;font-size:18px;text-align:center;
  border:2px solid #e8e8e8;border-radius:14px;background:#fff;
  margin:20px 0 24px;
}
.name-input:focus{border-color:#06C755;outline:none}

.qr-box{
  background:#fff;border:2px solid #f0f0f0;border-radius:16px;
  padding:16px;display:inline-block;margin:20px 0;
}
canvas#qr{display:block}

.pin{
  font-size:48px;font-weight:800;letter-spacing:14px;
  color:#06C755;margin:24px 0 16px;
  font-family:"SF Mono","Fira Code","Consolas",monospace;
}

.time-select{
  width:100%;padding:16px;font-size:18px;text-align:center;
  border:2px solid #e8e8e8;border-radius:14px;background:#fff;
  appearance:none;margin:20px 0 24px;cursor:pointer;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23999' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 16px center;
}
.time-select:focus{border-color:#06C755;outline:none}

.spinner{
  display:inline-block;width:36px;height:36px;
  border:3px solid #e8e8e8;border-top:3px solid #06C755;
  border-radius:50%;animation:spin .8s linear infinite;margin:24px 0;
}
@keyframes spin{to{transform:rotate(360deg)}}

.success-icon{font-size:72px;margin-bottom:20px}

.commands{
  text-align:left;background:#f8f9fa;border-radius:14px;
  padding:18px 22px;margin:24px 0 8px;font-size:14px;line-height:2;
}
.commands code{
  background:#e9ecef;padding:2px 8px;border-radius:6px;
  font-family:"SF Mono","Fira Code","Consolas",monospace;font-size:13px;
}

.hint{color:#999;font-size:12px;margin-top:12px;line-height:1.5}

.error-box{
  background:#fef2f2;border:1px solid #fecaca;border-radius:14px;
  padding:16px;margin:20px 0;color:#b91c1c;font-size:14px;line-height:1.5;
}

.loading-text{color:#888;font-size:14px;margin-top:8px}

.back-link{
  display:inline-block;margin-top:16px;color:#06C755;
  font-size:13px;text-decoration:none;
}
.back-link:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
<div class="card">

<!-- Step 0: Enter name -->
<div id="s-name" class="step active">
  <div class="logo">💬</div>
  <h1>新增使用者</h1>
  <p class="subtitle">
    輸入你的名字開始設定<br>
    LINE Smart Digest 會用這個名字識別你
  </p>
  <input type="text" class="name-input" id="user-name" placeholder="你的名字" maxlength="30" autofocus>
  <button class="btn" id="btn-start" onclick="startLogin()">開始</button>
  <a class="back-link" href="/">← 返回首頁</a>
</div>

<!-- Step 1: QR Code -->
<div id="s-qr" class="step">
  <span class="step-tag">步驟 1 / 3</span>
  <h1>掃描 QR Code</h1>
  <p class="subtitle">打開手機 LINE → 主頁右上角 QR 掃描器</p>
  <div class="qr-box" id="qr-box" style="display:none">
    <canvas id="qr" width="220" height="220"></canvas>
  </div>
  <div id="qr-loading">
    <div class="spinner"></div>
    <p class="loading-text">產生 QR Code 中...</p>
  </div>
</div>

<!-- Step 2: PIN -->
<div id="s-pin" class="step">
  <span class="step-tag">步驟 1 / 3</span>
  <h1>輸入認證碼</h1>
  <p class="subtitle">在手機 LINE 畫面上輸入這組數字</p>
  <div class="pin" id="pin">----</div>
  <div class="spinner"></div>
  <p class="loading-text">等待確認...</p>
</div>

<!-- Step 3: Configure time -->
<div id="s-config" class="step">
  <span class="step-tag">步驟 2 / 3</span>
  <h1>選擇摘要時間</h1>
  <p class="subtitle">每天幾點傳摘要到你的 LINE？</p>
  <select class="time-select" id="digest-time">
    <option value="07:00">07:00 早上</option>
    <option value="07:30">07:30 早上</option>
    <option value="08:00" selected>08:00 早上</option>
    <option value="08:30">08:30 早上</option>
    <option value="09:00">09:00 早上</option>
    <option value="12:00">12:00 中午</option>
    <option value="18:00">18:00 傍晚</option>
    <option value="21:00">21:00 晚上</option>
    <option value="22:00">22:00 晚上</option>
  </select>
  <button class="btn" onclick="configure()">下一步</button>
</div>

<!-- Step 4: Testing -->
<div id="s-test" class="step">
  <span class="step-tag">步驟 3 / 3</span>
  <h1>測試中...</h1>
  <p class="subtitle">正在傳送測試訊息到你的 LINE</p>
  <div class="spinner"></div>
  <p class="loading-text">請稍候</p>
</div>

<!-- Step 5: Done -->
<div id="s-done" class="step">
  <div class="success-icon">&#x2705;</div>
  <h1>設定完成！</h1>
  <p class="subtitle">
    請檢查 LINE 是否收到測試訊息<br>
    明天 <strong id="done-time">08:00</strong> 會收到第一封摘要
  </p>
  <div class="commands">
    <code>/digest</code> 立即產生摘要<br>
    <code>/digest 3h</code> 最近 3 小時摘要<br>
    <code>/status</code> 查看運作狀態
  </div>
  <p class="hint">在 LINE 的「自己的聊天室」輸入指令</p>
  <a class="btn" href="/" style="margin-top:20px;text-align:center;text-decoration:none">返回首頁</a>
</div>

<!-- Error -->
<div id="s-error" class="step">
  <div class="logo">&#x26A0;&#xFE0F;</div>
  <h1>出了點問題</h1>
  <div class="error-box" id="error-msg"></div>
  <button class="btn" onclick="retry()" style="margin-top:16px">重試</button>
</div>

</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
<script>
let sessionId = null;
let sse = null;
let selectedTime = '08:00';

function show(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('s-' + id).classList.add('active');
}

function connectSSE(sid) {
  if (sse) sse.close();
  sse = new EventSource('/events/' + sid);

  sse.addEventListener('qr', e => {
    const { url } = JSON.parse(e.data);
    show('qr');
    document.getElementById('qr-loading').style.display = 'none';
    document.getElementById('qr-box').style.display = 'inline-block';
    QRCode.toCanvas(document.getElementById('qr'), url, {
      width: 220, margin: 0,
      color: { dark: '#000000', light: '#ffffff' }
    });
  });

  sse.addEventListener('pin', e => {
    const { code } = JSON.parse(e.data);
    show('pin');
    document.getElementById('pin').textContent = code;
  });

  sse.addEventListener('logged-in', () => show('config'));

  sse.addEventListener('testing', () => show('test'));

  sse.addEventListener('test-success', () => {
    document.getElementById('done-time').textContent = selectedTime;
    show('done');
    sse.close();
  });

  sse.addEventListener('test-failed', e => {
    const { message } = JSON.parse(e.data);
    document.getElementById('error-msg').textContent = message || '傳送失敗，請重試';
    show('error');
  });

  sse.addEventListener('login-error', e => {
    const { message } = JSON.parse(e.data);
    document.getElementById('error-msg').textContent = message || '登入失敗，請重試';
    show('error');
  });
}

async function startLogin() {
  const nameInput = document.getElementById('user-name');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.style.borderColor = '#f87171';
    nameInput.focus();
    return;
  }

  show('qr');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    sessionId = data.sessionId;
    connectSSE(sessionId);
  } catch (err) {
    document.getElementById('error-msg').textContent = '無法連線伺服器';
    show('error');
  }
}

function configure() {
  selectedTime = document.getElementById('digest-time').value;
  show('test');
  fetch('/api/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, time: selectedTime })
  });
}

function retry() {
  location.reload();
}

// Allow pressing Enter in name input
document.getElementById('user-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') startLogin();
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// URL routing helper
// ---------------------------------------------------------------------------

function parseUrl(raw: string): { path: string; params: Record<string, string> } {
  const [pathPart] = raw.split("?");
  return { path: pathPart, params: {} };
}

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------

export function startWebServer(config: Config, manager: UserManager): void {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const { path } = parseUrl(req.url ?? "/");

    try {
      // Dashboard
      if (method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getDashboardHTML());
        return;
      }

      // Onboarding page
      if (method === "GET" && path === "/join") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getOnboardingHTML());
        return;
      }

      // SSE endpoint: /events/:sid
      if (method === "GET" && path.startsWith("/events/")) {
        const sid = path.slice("/events/".length);
        handleSSE(req, res, sid);
        return;
      }

      // API: list users
      if (method === "GET" && path === "/api/users") {
        handleApiUsers(req, res, manager);
        return;
      }

      // API: login (start onboarding)
      if (method === "POST" && path === "/api/login") {
        await handleApiLogin(req, res, config);
        return;
      }

      // API: configure (finish onboarding)
      if (method === "POST" && path === "/api/configure") {
        await handleApiConfigure(req, res, config, manager);
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      logError(TAG, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  server.listen(PORT, () => {
    log(TAG, `\n${"=".repeat(50)}`);
    log(TAG, `  LINE Smart Digest — Multi-user Server`);
    log(TAG, `  Dashboard: http://localhost:${PORT}`);
    log(TAG, `  Add user:  http://localhost:${PORT}/join`);
    log(TAG, `${"=".repeat(50)}\n`);
  });

  server.on("error", (err) => {
    logError(TAG, err);
  });
}
