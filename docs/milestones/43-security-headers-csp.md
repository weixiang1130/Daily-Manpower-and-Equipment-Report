# 節點 43 — 安全性回應標頭與 CSP（交付前資安盤點・第 2 批）

> 三後端＋前端一起動；CSP 需前端配合，故本節點同時觸及 frontend/。

## 背景

交付前資安盤點的第 2 批「設定硬化」。三個後端實作（雲端 Netlify、地端 .NET、Node server.mjs）
**都沒有任何安全性回應標頭**——沒有 CSP、`X-Content-Type-Options`、`X-Frame-Options`、
`Referrer-Policy`、`Permissions-Policy`。這使前端缺少對點擊劫持、MIME 嗅探、以及
（萬一 `esc()` 有疏漏時）跨站腳本的縱深防禦。

## 變更內容

- **三後端統一加上五個安全標頭**（CSP **逐字一致**——同一份前端）：
  - 地端 .NET `Program.cs`：以 `Response.OnStarting` 掛在回應送出前設定，連例外處理器 `Clear()`
    之後的 500、Basic Auth 的 401、授權中介層的 403 都帶得到（實測 500 回應仍具全部標頭）
  - 雲端 `netlify.toml`：宣告式 `[[headers]] for = "/*"`（零執行風險，靜態與 `/api` 皆套用）
  - Node `server.mjs`：請求進入點 `res.setHeader`（早於 `writeHead`，涵蓋 JSON／靜態／401／500）
- **CSP 內容**：`default-src 'self'`；`script-src 'self'`（無 `unsafe-inline`）；
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`；`font-src 'self' https://fonts.gstatic.com`；
  `img-src 'self' data: blob:`；`connect-src 'self'`；`object-src/base-uri/form-action/frame-ancestors` 收緊。
- **前端配合 `script-src 'self'` 拆除三個內聯事件處理器**（否則 CSP 會擋掉它們）：
  - `index.html` 連線失敗覆蓋層「重新載入」鈕 `onclick` → 改 `id` ＋ app.js 事件綁定
  - `index.html` `config.local.js` 的 `onerror`（僅記 log，非必要）→ 移除
  - app.js 稽核列印視窗 `onclick="window.print()"` → 改 `id`，由父視窗在 `document.write` 後
    掛事件；子文件（about:blank，繼承本頁 CSP）因此完全不含內聯腳本

## 設計決策 / 取捨

- **`style-src` 允許 `'unsafe-inline'`**：圖表與部分版面用行內 `style=` 寬度，全面改寫成本過高；
  內聯樣式無法執行 JS，風險遠低於內聯腳本。`script-src` 則維持嚴格 `'self'`，才是 CSP 的重點。
- **放行 Google Fonts 網域**而非自架字體：字體缺失時會優雅退回系統字體（`Microsoft JhengHei` 等），
  非功能性風險。自架字體可讓 CSP 收到純 `'self'`（未來硬化項，見殘餘）。
- **HSTS 不在應用層設**：地端服務只講 HTTP，TLS／HSTS 由前置反向代理負責；雲端由 Netlify 於自訂網域提供。
- **列印鈕由父視窗綁定**：`window.open("") + document.write` 產生的 about:blank 會繼承開啟頁的 CSP，
  子文件內的內聯 `onclick` 會被 `script-src 'self'` 擋下；改由父視窗（同源、腳本合法）掛事件即可。

## 影響範圍

- 檔案：`frontend/index.html`、`frontend/app.js`、`backend/onprem/dotnet/Program.cs`、
  `backend/onprem/server.mjs`、`netlify.toml`。**無資料結構／API 合約變動。**
- ⚠ 未來若在前端新增功能，**不可再用內聯 `onclick=`/`onload=` 等**——會被 CSP 擋下，一律 `addEventListener`。

## 驗證

- 地端 .NET 建置 0/0；本機起服務（Development）以瀏覽器實載：五個標頭全部帶出（200 與 500 皆是），
  瀏覽器 console **零 CSP 違規**——`app.js`／`style.css`／Google Fonts 在嚴格 `script-src 'self'` 下全部正常載入。
- 內聯處理器全域掃描確認僅三處、皆已改為事件綁定。

## 殘餘（建議未來處理，非本次）

- 自架字體以移除 CSP 的 Google 網域放行、並讓系統完全離線可用。
- HSTS／rate limit 由前置反向代理負責（內網＋Windows 驗證下 rate limit 誘因低）。
