# PTT 貼文草稿 (Soft_Job 或 MobileComm)

---

**[分享] 寫了一個工具，讓你不用再一則一則看 LINE**

大家好，

在台灣工作過的都知道，LINE 就是台灣的 Slack。但它沒有 thread、沒有搜尋、沒有靜音、也不會幫你分工作跟私人。

我自己的狀況：每天早上打開 LINE，20 幾個群組、幾百則未讀。光是「滾完」確認有沒有人找我就要半小時。更痛苦的是，90% 是早安圖、貼圖、閒聊——但你不看完就不知道哪些重要。

LINE 不會修這個問題。他們靠你頻繁打開 APP 賺廣告錢，靠官方帳號推播按則收費。幫你過濾噪音 = 砍自己營收。公私分離是 LINE WORKS 的賣點（月費 $450-800/人），他們不可能在免費版做。

所以我自己寫了一個工具：LINE Smart Digest

它做的事很簡單：
1. 在背景接收你的 LINE 訊息（用非官方協議）
2. 存到本地 SQLite
3. 每天早上用 AI（Claude Haiku / Gemini Flash）產生一頁摘要
4. 摘要直接傳回你的 LINE（自己跟自己聊天）

你收到的摘要長這樣：

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
3 則早安圖 · 8 則閒聊 · 12 則貼圖
```

也可以隨時自己叫：傳 /digest 給自己就會即時產生。

技術棧：TypeScript、@evex/linejs（非官方 LINE 協議）、better-sqlite3、node-cron
LLM：支援 Anthropic Claude、Google Gemini、OpenRouter、任何 OpenAI-compatible API
部署：自架 Node.js 或 Docker，每個用戶獨立 instance

開源 MIT，你的訊息只存在你自己的機器上（除了送給 LLM 做摘要）。

線上試用（掃 QR 就能用）：https://line-digest.onrender.com/join
GitHub: https://github.com/dans-huang/line-digest

目前很早期（MVP），歡迎：
- 試用回饋
- 開 Issue 報 bug 或建議功能
- Star 讓我知道有人需要這個

已知限制：
- 群組名稱顯示可能有問題（linejs API 限制）
- 用的是非官方協議，理論上有被 LINE 封的風險（目前沒遇過）

如果你也每天被 LINE 群組轟炸到焦慮，歡迎試試看。

---
