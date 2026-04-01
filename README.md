# LINE Smart Digest

> 每天早上一頁看完所有 LINE 訊息。不用換 APP，不用改習慣。

LINE 是台灣人的生活基礎設施。2,100 萬月活用戶，71% 用它工作。但每天打開 LINE 的那一刻——幾十個群組、幾百則未讀——你知道那個焦慮感。

**LINE Smart Digest** 在背景讀取你的 LINE 訊息，每天早上用 AI 產生一份摘要：誰在找你、什麼事要回、什麼可以不看。30 秒看完，取代 30 分鐘的逐則滾動。

**立即試用：https://line-digest.onrender.com/join**

---

## 它長什麼樣

你的 LINE 自己聊天裡，每天早上會出現這個：

```
📋 LINE 摘要 | 03/30 08:00

📌 需要回覆 (3)
━━━━━━━━━━
【行銷部群組】
→ Amy 問素材好了嗎 (07:50)
→ 主管 Kevin：下午 3 點客戶來，要準備 (07:18)

【Jenny】
→ 約週六吃新開的餐廳 (07:45)

📋 重要更新 (1)
━━━━━━━━━━
【公司公告】薪資單提醒

💤 可略過
━━━━━━━━━━
3 則早安圖 · 8 則同學群閒聊 · 12 則貼圖
```

你也可以隨時自己叫：

```
/digest        → 立即產生摘要
/digest 3h     → 最近 3 小時的摘要
/status        → 看運行狀態
```

---

## 為什麼 LINE 不會自己做這件事

LINE 的營收來自官方帳號推播（按訊息收費）和聊天列表廣告（按曝光收費）。你越常打開 LINE、越焦慮地刷訊息，LINE 賺越多。

幫你過濾噪音 = 砍自己營收。他們不會做。

而且公私分離是 LINE WORKS（企業付費方案）的核心賣點。免費版解決這個問題 = 殺掉付費版。

**你的焦慮是 LINE 的商業模式。這不是 bug，是 feature。**

---

## 技術架構

```
你的 LINE 帳號
    ↓ (push，即時接收所有訊息)
LINE Smart Digest daemon
    ↓
SQLite (存所有訊息)
    ↓
AI 摘要引擎 (Claude Haiku / Gemini Flash / 任何 LLM)
    ↓
傳回你的 LINE (自己跟自己聊天)
```

- 你的訊息不會離開你的機器（除了送給 LLM 做摘要）
- 每個用戶是獨立的 instance，互不干擾
- 跑在你自己的電腦或伺服器上

## 安裝（5 分鐘）

### 前置需求

- Node.js 20+
- 一支有 LINE 的手機
- 一個 LLM API key（[Anthropic](https://console.anthropic.com/)、[Google AI Studio](https://aistudio.google.com/)、或 [OpenRouter](https://openrouter.ai/)）

### 步驟

```bash
# 1. Clone
git clone https://github.com/dans-huang/line-digest.git
cd line-digest

# 2. 安裝
npm install

# 3. 設定 API key
echo "LLM_API_KEY=your-api-key-here" > .env

# 4. 登入 LINE（掃 QR code）
npx tsx src/main.ts --login

# 5. 啟動
npx tsx src/main.ts
```

登入後，在 LINE 裡傳 `/status` 給自己，確認有回應就代表成功。

### 設定摘要時間

編輯 `config.yaml`：

```yaml
digest:
  schedule: "0 8 * * *"    # 每天早上 8 點（cron 格式）
  timezone: "Asia/Taipei"
  defaultHours: 12          # 摘要涵蓋幾小時
```

### 換 LLM

預設用 Anthropic Claude Haiku（便宜、快、品質夠）。也可以用：

```yaml
# config.yaml
llm:
  model: "google/gemini-2.0-flash-001"
  baseUrl: "https://openrouter.ai/api/v1"
```

支援任何 OpenAI-compatible API（OpenRouter、OpenAI、Groq 等）和 Anthropic API。

### Docker（多人部署）

```bash
# 建立用戶目錄
mkdir -p users/alice/data
cp config.yaml users/alice/config.yaml
echo "LLM_API_KEY=..." > users/alice/.env

# 登入
docker compose run --rm digest-alice node dist/main.js --login

# 啟動
docker compose up -d digest-alice
```

---

## 成本

| 項目 | 費用 |
|------|------|
| Claude Haiku（一般用量，每天 1 次摘要） | ~NT$10/月 |
| Claude Haiku（重度用量，每天 3+ 次） | ~NT$45/月 |
| Gemini Flash via OpenRouter（一般用量） | ~NT$1.5/月 |
| 自架伺服器 | NT$0（你的電腦） |
| Railway/Render 雲端 | ~NT$150/月 |

每人每月約 NT$1.5-7（Gemini API）。免費額度內幾乎零成本。

## Roadmap

- [x] 核心摘要引擎（定時 + 隨叫隨到）
- [x] 多 LLM 支援（Anthropic / OpenAI / OpenRouter）
- [x] Docker 多用戶部署
- [ ] 智慧即時提醒（老闆找你、有人 @ 你）
- [ ] 訊息搜尋（「上次 Amy 說的那個報價是多少？」）
- [ ] Web 設定介面（不用改 config.yaml）
- [ ] One-click 部署（掃 QR 就能用，不需要 terminal）

---

## 回饋

這是一個很早期的專案。如果你試用了，不管是好是壞，都請告訴我：

- **Bug** → [回報 Bug](../../issues/new?template=bug_report.md)
- **想要的功能** → [功能建議](../../issues/new?template=feature_request.md)
- **使用心得** → [Discussion](../../discussions)

---

## 為什麼做這個

台灣有超過 1,400 萬人用 LINE 工作。他們的痛點——訊息轟炸、公私不分、已讀壓力——不會被 LINE 解決，因為這些痛點是 LINE 的營收來源。

這個工具不是要取代 LINE。是在 LINE 不願意做的地方，幫你一把。

---

## License

MIT
