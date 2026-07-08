# 部署手冊（地端 / 自有伺服器）

本文件供 IT／基礎架構人員將本系統從 Netlify 遷移至自有伺服器。
系統技術背景請先讀 [`CLAUDE.md`](CLAUDE.md)；演進脈絡見 [`docs/milestones/`](docs/milestones/README.md)。

## 1. 系統組成（兩種部署形態）

本系統＝**純靜態前端 ＋ 一支資料 API ＋ 整站 Basic Auth**。repo 內含兩套等價的執行環境，擇一使用：

| | Netlify 版（現行） | 可攜式版（地端用） |
|---|---|---|
| 靜態檔案 | Netlify CDN | `server/server.mjs` 內建靜態服務 |
| 資料 API `/api/data` | `netlify/functions/api.mjs` | `server/server.mjs`（同一 API 合約） |
| Basic Auth | `netlify/edge-functions/auth.ts` | `server/server.mjs`（同一邏輯） |
| 資料儲存 | Netlify Blobs（一筆一 blob） | 檔案系統 `DATA_DIR`（一筆一 JSON 檔，同構） |

前端 `app.js` 對兩種形態**完全無感**——只呼叫 `/api/data`。

> **重要**：`netlify/` 目錄與 `netlify.toml` 是 Netlify 專用，地端部署**不需要、也無法使用**；地端只需要 `server/` ＋ 根目錄靜態檔案。

## 2. 地端環境需求

- **Node.js 18 以上**（僅此一項；**零 npm 依賴**，不需 `npm install`）
- 任一作業系統（Windows Server / Linux 皆可）
- 建議前置一層反向代理（IIS ARR / nginx / Apache）處理 **HTTPS**——本伺服器只講 HTTP，帳密以 Basic Auth 傳輸，**正式環境必須走 HTTPS**
- 磁碟空間：資料量極小（每筆紀錄約 1–2 KB，一年約數十 MB），10 GB 綽綽有餘

## 3. 部署步驟

```bash
# 1) 取得程式碼
git clone <本 repo>
cd <repo>

# 2) 放置真實名單設定檔（向系統管理者索取，勿入版控）
#    內容格式見 app.js 開頭註解；檔名固定：
#    <repo>/config.local.js

# 3) 設定環境變數
#    Linux（systemd 服務檔或 shell）：
export PORT=8080
export SITE_AUTH_USER=<帳號>          # 向系統管理者索取
export SITE_AUTH_PASS=<密碼>          # 未設定＝不啟用驗證，正式環境必設
export DATA_DIR=/var/lib/kg-audit     # 資料目錄（建議獨立於程式目錄）
#    Windows（以系統環境變數或服務包裝器設定同名變數）

# 4) 匯入既有資料（從 Netlify 切換時；全新部署可跳過）
#    先在舊站：設定頁 → 管理員登入 → 「下載完整備份（JSON）」
node server/import-backup.mjs 完整備份.json

# 5) 啟動
node server/server.mjs
#    → http://localhost:8080 應出現登入視窗（若已設 SITE_AUTH_PASS）
```

### 常駐服務建議

- **Linux**：systemd unit，`ExecStart=/usr/bin/node /opt/kg-audit/server/server.mjs`，`Restart=always`，環境變數寫在 unit 的 `Environment=` 或 `EnvironmentFile=`
- **Windows**：以 [NSSM](https://nssm.cc/) 或工作排程器包成服務；環境變數設在服務層級

## 4. 資料遷移（Netlify → 地端）切換流程

1. 公告停機時段（避免切換期間有人寫入舊站）
2. 舊站：管理員「下載完整備份（JSON）」
3. 地端：`node server/import-backup.mjs <備份檔>` → 啟動服務
4. 驗證清單（缺一不可）：
   - 開站出現 Basic Auth 登入 → 選工地攔截頁 → 各工地資料筆數與舊站一致
   - 建立一筆點工申請 → 回報覆核（逐工種＋分段加班）→ 差異正確
   - 歷程報表期間/條件篩選 → 匯出明細與計價彙總 CSV
   - 管理員登入 → 設定頁名單維護 → 下載完整備份
5. DNS／內網入口改指地端；通知使用者新網址
6. **退場舊站**：更換或停用 Netlify 站台密碼、（建議）刪除 Netlify 站台與環境變數，避免兩份資料並存造成誤填

## 5. 維運

| 項目 | 建議 |
|---|---|
| 備份 | 每日排程壓縮整個 `DATA_DIR`（全部即純 JSON 檔）；另保留管理員手動 JSON 備份於月結時點 |
| 監控 | 服務存活（HTTP 200 於 `/`）＋磁碟空間 |
| 密碼輪替 | 人員異動時更換 `SITE_AUTH_PASS` 並重啟服務 |
| 日誌 | stdout（systemd journal / NSSM 日誌檔）；本系統不記錄操作者身分（見下） |

## 6. 已知限制（IT 評估用）

- **單一共用帳密**，無個人身分與操作軌跡；責任歸屬以「簽單責任工程師」欄位＋紙本簽單為準。若需問責到人，須另建含登入的後端（屬改版範疇，非部署設定）
- 破壞性操作（清空資料）伺服器端無權限分級，僅前端管理員模式防誤觸——請以檔案備份為最後防線
- 前端每次開站載入全部紀錄；資料累積數千筆後建議實施「月結封存」（將已鎖定月份移出 `DATA_DIR` 另存）
- `SITE_AUTH_PASS` 未設定時**不啟用驗證**（fail-open，沿用雲端版設計）——正式環境務必設定並納入組態檢查

## 7. 測試狀態聲明

`server/server.mjs` 與 `import-backup.mjs` 撰寫當下開發機無 Node 環境，**僅通過語法驗證與對照 `netlify/functions/api.mjs` 的逐行合約比對，未經實機執行測試**。部署前請務必在測試機完整跑過第 4 節的驗證清單；如有問題請回報系統管理者。
