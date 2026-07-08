# 節點 15：可攜式伺服器與地端部署交付（IT handoff）

**日期**：2026-07-07
**狀態**：現行架構（Netlify 版持續運行；地端版為交付 IT 的預備形態）

## 背景

使用者決定將系統交由公司資訊部門部署至公司自有伺服器。IT 需要「環境與架構」交付物。盤點後的缺口：repo 內的 `netlify/functions/api.mjs`（資料 API）與 Netlify Blobs（儲存）是 Netlify 專用執行環境——IT 取得 repo 只能架出靜態頁面，API 會是死的。另確認 GitHub 上使用者看到的「.netlify」實為 `netlify/` 程式碼目錄（Edge Function＋Function），`.netlify/` 狀態資料夾從未入版控（.gitignore 有擋），無機密外洩問題。

## 變更內容

1. **`server/server.mjs`** — 可攜式伺服器（零外部依賴，Node 18+，不需 npm install）：
   - 與 `netlify/functions/api.mjs` **同一 API 合約**（GET ?site=/scope=all；POST 7 ops 含 409 樂觀並發、id 格式驗證、addOption 白名單）
   - 內建靜態檔案服務（含路徑穿越防護、MIME 表）
   - 與 Edge Function 同邏輯的整站 Basic Auth（SITE_AUTH_USER/PASS 環境變數，fail-open 行為一致）
   - 儲存層：一筆資料一個 JSON 檔（key 整體 base64url 為檔名——key 含 `:` 不能直接當檔名）；tmp+rename 原子寫
   - 前端 app.js 完全不需修改
2. **`server/import-backup.mjs`** — 資料遷移工具：把管理員「下載完整備份（JSON）」的輸出灌入地端資料目錄（master＋各站 config＋逐筆紀錄，id 格式不符者跳過並統計）
3. **`DEPLOYMENT.md`** — 給 IT 的部署手冊：兩種部署形態對照、環境需求、部署步驟、systemd/NSSM 常駐建議、Netlify→地端切換流程（含驗證清單與舊站退場）、維運建議、已知限制、測試狀態聲明

## 設計決策 / 取捨

- **檔案儲存而非資料庫**：與 Blobs「一筆一 blob」同構，資料層行為（含並發語意）與雲端版一致，遷移風險最小；「全量載入」的既有天花板照舊存在（DEPLOYMENT.md 已向 IT 揭露並附月結封存建議）。若未來要上關聯式資料庫屬另一次改版
- **零依賴**：公司伺服器常無法自由連外拉 npm 套件；純 Node 內建模組可離線部署
- **fail-open 保留**：與雲端版一致（未設密碼＝放行），但文件中三處強調正式環境必設

## 影響範圍

- 新增 `server/`（2 檔）與 `DEPLOYMENT.md`；`CLAUDE.md` 檔案地圖同步
- Netlify 現行部署**完全不受影響**（build command 不涉及 server/）

## 驗證紀錄

開發機無 Node 環境，**無法實機執行測試**。已做：
- 兩個 .mjs 通過 Chrome 引擎語法驗證（剝除 node: import 後完整解析，僅於執行期因瀏覽器無 node 環境而停，證明語法無誤）
- API 合約與 `netlify/functions/api.mjs` 逐 case 比對（master/config/record/addOption/deleteRecord/clearSite/clearAll、409 條件、id regex、POOLS 白名單一致）
- DEPLOYMENT.md 第 7 節與檔頭註解均明確聲明未經實機測試，並附部署前驗證清單，由 IT 於測試機執行
