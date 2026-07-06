# CLAUDE.md — 點工機具稽核系統

給 AI agent 與新進開發者的技術導覽。營運層資訊（網址、帳密、真實名單）不在本檔——本 repo 為 public，遵守去識別化政策（見下）。演進脈絡見 `docs/milestones/`（11 個節點），異動摘要見 `CHANGELOG.md`。

## 系統一句話

工地端「點工（人力派工）／機具」申請與回報覆核工具：父層申請單 → 子層逐人/逐台勾選回報 → 差異自動計算 → 期間篩選匯出 CSV 供成本部門計價。多人共編（雲端共用資料庫）、多工地資料完全隔離。

## 架構

```
瀏覽器（純前端，無框架/無建置）
  └─ index.html + style.css + app.js + config.local.js(建置時產生)
       │ fetch /api/data（Basic Auth 由瀏覽器自動附帶）
       ▼
netlify/edge-functions/auth.ts   整站 Basic Auth（env: SITE_AUTH_USER/PASS；未設密碼=放行）
netlify/functions/api.mjs        資料 API（函式內二次驗證同一組帳密）
  └─ Netlify Blobs store "audit-data"（strong consistency）
```

- **部署**：Git 連動 main 自動建置。`netlify.toml` build command 執行 `scripts/build-config.mjs`，從環境變數 `LOCAL_CONFIG_JS` 產生 `config.local.js`（真實名單不進 repo；變數未設定時站台用 `app.js` 內建範例值）。
- **本機**：純靜態伺服器無 /api → 前端顯示「無法連線」畫面（設計行為）。完整本機測試需 `netlify dev`；純前端邏輯可在 console 注入 `MASTER`/`SITE_CACHE`/`READY=true` 後 `renderAll()` 驗證。

## Blobs 資料模型

| Key | 內容 |
|---|---|
| `master` | `{ sites: [...] }` 全域工地清單 |
| `cfg2:<b64url(工地)>` | 該工地基礎資料：vendors/locations/categories/equipTypes/people/workers 陣列 ＋ `lockDate` 字串 |
| `rec2:<b64url(工地)>:<labor\|equipment>:<id>` | 單筆紀錄（父單含子層 `report`） |

- **工地段必須 base64url**：Blobs 後端會解碼 key 中的 `%` 序列，encodeURIComponent 不可靠（節點 10/11 踩過的坑）。舊 `rec:`/`cfg:` 命名空間由 GET 時的 `migrateLegacyKeys()` 一次性搬移。
- **紀錄結構**：`{ id, date, vendor, applicant, ..., status: "待回報"|"已回報", report: null|{...}, v, updatedAt }`。點工父單有 `workers[]`（預計進場名單）、子層 `report.attendance[]`（逐人 present/work/ot）；機具子層 `report.usage[]`（逐台 present/hours）。`report.zeroWork`/`zeroUse` 為 0 工/0 使用確認旗標。
- **樂觀並發**：寫入附 `baseV`，與現存 `v` 不符回 409（含「已被刪除但 baseV>0」）；成功回 `{v, updatedAt}`。前端「編輯前先 refetchSite」大幅降低衝突率。
- **選項新增**：`op:addOption` 伺服器端 read-merge-write，避免兩人同時新增互相覆蓋。整包 config 覆蓋只用於管理員批次儲存。

## 前端要點（app.js）

- 無 localStorage 業務資料；記憶體快取 `SITE_CACHE` ＋ sessionStorage（`dm_site` 本分頁工地、`dm_admin` 管理員狀態）。
- 寫入 await-first：雲端成功才清表單；失敗保留輸入提示重試；409 顯示「已被他人修改」並重載。
- 防呆：開站選工地攔截頁（每 session 必選）、表單常駐工地徽章、申請送出前 confirm 工地、0 必須勾「0 工/0 使用確認」、出工×加班異常警告（可確認後送出）、鎖單（`config.lockDate` 含以前非管理員不可增修刪）、已回報單刪除限管理員。
- 日期一律 `localDate()`（本地時區）——不可用 `toISOString().slice(0,10)`（UTC 會把 UTC+8 早上記成前一天，影響計價月份）。
- 管理員模式為前端層級防誤觸（adminPin 比對），非資安防線；真正權限需後端登入（未做）。

## 工作規範

1. **去識別化（最高優先）**：進 git 的一切內容不得含真實工地代號、分包商名、人名、密碼。提交前掃描 staged diff。真實名單僅存於本機 `config.local.js`（gitignored）與 Netlify 環境變數。
2. **PR 流程**：分支 → PR（說明含背景/變更/驗證）→ 合併。每次改版新增 `docs/milestones/NN-描述.md` 並更新索引與 CHANGELOG；營運操作（不改碼）記到 `docs/ops-log.md`（同樣去識別化）。
3. **測試共用資料庫**：用拋棄式工地名寫入，測畢 `op:clearSite` 清除；嚴禁 `clearAll`。
4. 程式風格：原生 JS、無依賴（僅 @netlify/blobs）、繁體中文 UI 與註解、`esc()` 處理所有插入 DOM 的動態字串。

## 檔案地圖

```
index.html                     頁面結構（5 頁籤＋申請/回報子頁＋overlay 們）
app.js                         全部前端邏輯（~1300 行，區塊註解分段）
style.css                      樣式（teal/amber 設計系統）
config.local.js                （gitignored）真實名單；格式見 app.js 開頭註解
netlify/functions/api.mjs      資料 API（op: master/config/record/addOption/deleteRecord/clearSite/clearAll）
netlify/edge-functions/auth.ts 整站 Basic Auth
scripts/build-config.mjs       建置時由環境變數產生 config.local.js
docs/milestones/               11 個迭代節點文件（背景/決策/驗證）
docs/ops-log.md                營運紀錄（去識別化）
CHANGELOG.md                   版本摘要
```

## 已知限制與擱置項目

- 同筆紀錄並發：409 保護下仍是「後確認者重填」；無合併編輯
- 無使用者身分/操作軌跡（單一共用帳密）；審計需求要升級含登入的後端
- 鎖單/刪除保護/管理員皆前端管控
- 擱置待議：清單狀態快篩、總覽跨工地待回報名單、逐人計價明細 CSV 匯出
