# Daily Manpower and Equipment Report｜點工機具稽核系統

工地端「點工（人力派工）」與「機具」抽查稽核回報工具。依營造工程稽核會議紀錄與現行 Excel 查核表設計，讓工程師與稽核人員能以勾選、下拉選單為主的方式快速完成申請與回報，減少人工登打 Excel 的負擔，並支援跨工地列控。

> 本專案為通用工具，程式內建的工地／分包商／人員名單皆為**範例佔位資料**。實際名單只存在於 `frontend/config.local.js`（已 gitignore）與部署環境變數；業務資料存於共用資料庫，不會回寫至本程式碼庫。**任何進入 git 的內容都不得含真實工地代號、分包商名、人名與密碼**。

---

## 目錄結構：前端／後端／文件

```
frontend/          ← 前端（唯一對外發布的目錄）
backend/           ← 後端（雲端現行、地端未來、資料庫）
docs/              ← 文件（規格、計畫、手冊、迭代紀錄）
```

**三大項各自獨立**：前端不依賴後端原始碼（只依賴 `/api/data` 這個接縫）、後端不含任何頁面、文件不含可執行程式。新增檔案時先問「這屬於哪一項」，不確定就看下表。

### `frontend/` — 前端

純原生 HTML / CSS / JavaScript，**無框架、無建置流程、無 npm 依賴**。整個目錄可直接掛在任何 Web 伺服器。

| 檔案 | 內容 |
|---|---|
| `index.html` | 頁面結構（6 個頁籤＋申請/回報子頁＋各式 overlay） |
| `app.js` | 全部前端邏輯：資料模型、渲染、表單、報表、匯出、並發控制 |
| `style.css` | 樣式（根基營造品牌設計系統） |
| `config.local.js` | **gitignored**。真實名單；部署時由環境變數產生，格式見 `app.js` 開頭註解 |

### `backend/` — 後端

| 子目錄 | 內容 | 狀態 |
|---|---|---|
| `cloud/` | Netlify Functions（`functions/api.mjs` 資料 API）＋ Edge Function（`edge-functions/auth.ts` 整站 Basic Auth） | **現行運作中**（過渡期） |
| `onprem/` | `server.mjs` 零依賴可攜式伺服器（同一 API 合約＋靜態服務＋Basic Auth）、`import-backup.mjs` 資料移轉 | 參考實作／備援 |
| `sql/` | `DB-SCHEMA.sql`（17 表 5 VIEW）、`backup-json-to-sql.py` 移轉工具、`README.md` 逐操作 SQL 對照 | 已交付 IT，本機實測對帳通過 |

> 地端正式方案為 **.NET 8 API**（資訊處開發中）。`onprem/server.mjs` 是行為對照組，不是最終方案。

### `docs/` — 文件

| 文件 | 用途 |
|---|---|
| [`API-CONTRACT.md`](docs/API-CONTRACT.md) | ★ **前後端接縫合約**——重寫後端的唯一依據；**改欄位一律先改這份** |
| [`MIGRATION-PLAN.md`](docs/MIGRATION-PLAN.md) | 地端移轉計畫：現況、目標架構、分工、資料與附件移轉、時程、回退 |
| [`AUTH-PLAN.md`](docs/AUTH-PLAN.md) | 權限規畫：SSO 認證、ERP 權限來源、角色判定規則、驗收情境 |
| [`DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 地端部署手冊（給 IT）：環境需求、步驟、切換流程、維運 |
| [`milestones/`](docs/milestones/README.md) | 逐節點迭代紀錄（背景／決策／驗證），索引在其 README |
| [`ops-log.md`](docs/ops-log.md) | 營運操作紀錄（不改程式碼的資料面操作） |

### 根目錄

| 檔案 | 用途 |
|---|---|
| `README.md` | 本檔——**導覽入口** |
| `CLAUDE.md` | 給 AI agent 與新進開發者的技術導覽（架構、資料模型、不變式） |
| `CHANGELOG.md` | 版本異動摘要 |
| `netlify.toml` | 部署設定——**三個路徑都明示**，改目錄時必須同步 |
| `scripts/build-config.mjs` | 建置腳本：由環境變數產生 `frontend/config.local.js` |

---

## 功能總覽

- **多工地完全隔離**：每個工地一份獨立資料環境（名單池與紀錄互不共用，各站自建）；頁首切換工地即切換整個資料環境，總覽頁跨工地彙總
- **申請（父）／回報覆核（子）**：回報承繼申請單資料，逐「工種」填實際出工數（支援 0.5 等小數）與**分段加班**（前 2 小時／第 3 小時起，費率不同）；全日無人出工經「0 工確認」寫入
- **智慧搜尋下拉**：分包商、人員、地點、工種皆可模糊搜尋；搜不到時「＋ 新增選項」直接寫入該工地名單
- **附件**：申請單夾簽單掃描檔、稽核夾現場照片（手機可直接拍照，圖片自動壓縮）
- **成控現場稽核**（限管理員）：逐項查核、差異計算、PDF 報告
- **報表與匯出**：歷程明細、計價彙總、叫工排名；點工匯出為**帶格式 Excel**（工種計價表＋完整明細兩個工作表）
- **並發保護**：樂觀鎖（baseV／409），兩人同時編輯同一單不會靜默覆蓋

## 技術棧

| 層 | 技術 |
|---|---|
| 前端 | 原生 HTML / CSS / JavaScript（無框架、無建置） |
| 介接 | 單一 REST 端點 `/api/data`（JSON）；位址可由 `config.local.js` 的 `apiBase` 覆寫 |
| 後端（現行） | Netlify Functions ＋ Netlify Blobs |
| 後端（目標） | .NET 8 ＋ SQL Server（17 表 5 VIEW） |
| 認證（現行） | 整站 Basic Auth |
| 認證（目標） | 公司 SSO ＋ ERP 專案權限 |

## 開發／預覽

```bash
# 前端（靜態）：本機無 /api 會顯示「無法連線」畫面，屬設計行為
python -m http.server 8791 --directory frontend
```

完整本機測試用 `netlify dev`；純前端邏輯可在 console 注入 `MASTER`／`SITE_CACHE`／`READY=true` 後呼叫 `renderAll()` 驗證。

## 已知限制

- 同一筆紀錄的並發編輯以 409 保護——後送出者需重填，不會靜默覆蓋；但**現階段不留「誰修改」的軌跡**（單一共用帳密），問責需求待地端個人登入
- 管理員模式為前端層級防誤觸，非資安防線；成控稽核頁對工地端為 UI 隱藏，資料層仍隨單據傳輸——真正隔離待 API 層權限
- 本機純靜態開啟時無 API
