# CLAUDE.md — 點工機具稽核系統

給 AI agent 與新進開發者的技術導覽。營運層資訊（網址、帳密、真實名單）不在本檔——本 repo 為 public，遵守去識別化政策（見下）。演進脈絡見 `docs/milestones/`（索引在其 README，逐節點記錄背景與決策），異動摘要見 `CHANGELOG.md`。

## 系統一句話

工地端「點工（人力派工）／機具」申請與回報覆核工具：父層申請單 → 子層逐人/逐台勾選回報 → 差異自動計算 → 期間篩選匯出 CSV 供成本部門計價。多人共編（雲端共用資料庫）、多工地資料完全隔離。

## 架構

```
瀏覽器（純前端，無框架/無建置）
  └─ frontend/ = index.html + style.css + app.js + config.local.js(建置時產生)
       │ fetch /api/data（Basic Auth 由瀏覽器自動附帶）
       ▼
backend/cloud/edge-functions/auth.ts   整站 Basic Auth（env: SITE_AUTH_USER/PASS；未設密碼=放行）
backend/cloud/functions/api.mjs        資料 API（函式內二次驗證同一組帳密）
  └─ Netlify Blobs store "audit-data"（strong consistency）
```

- **部署**：Git 連動 main 自動建置。`netlify.toml` build command 執行 `scripts/build-config.mjs`，從環境變數 `LOCAL_CONFIG_JS` 產生 `config.local.js`（真實名單不進 repo；變數未設定時站台用 `app.js` 內建範例值）。
- **本機**：純靜態伺服器無 /api → 前端顯示「無法連線」畫面（設計行為）。完整本機測試需 `netlify dev`；純前端邏輯可在 console 注入 `MASTER`/`SITE_CACHE`/`READY=true` 後 `renderAll()` 驗證。

## Blobs 資料模型

| Key | 內容 |
|---|---|
| `master` | `{ sites: [...] }` 全域工地清單 |
| `cfg2:<b64url(工地)>` | 該工地基礎資料：vendors/locations/categories/equipTypes/people/workers/laborTypes 陣列 ＋ 鎖檔設定（v24.7 `lockRanges` 陣列；舊 `lockDate` 字串保留相容）（**v17 起各站自建，新工地全部名單池皆空**；workers 為 v11 起棄用的舊池，僅相容保留） |
| `rec2:<b64url(工地)>:<labor\|equipment>:<id>` | 單筆紀錄（父單含子層 `report`、`audits[]`、`attachments[]`） |
| `att2:<b64url(工地)>:<附件id>` | **附件檔案本體**（二進位＋name/type metadata；v14）——不進單據 JSON，JSON 備份亦不含 |
| `rates:<labor\|equipment>` | **行情通報費率書**（v22.8）：季別陣列，以 `effectiveFrom` 為唯一鍵、上限 12 季。**一個 kind 一把 key**——同放一把時兩種同時匯入會互相覆蓋。**刻意不進 `scope=all`**（一季 1,500 列會拖慢每個人開站），走獨立端點 `GET ?rates=1`。工地的綁定存在各站 config 的 `rateBindings` |

- **工地段必須 base64url**：Blobs 後端會解碼 key 中的 `%` 序列，encodeURIComponent 不可靠（節點 10/11 踩過的坑）。舊 `rec:`/`cfg:` 命名空間由 GET 時的 `migrateLegacyKeys()` 一次性搬移。
- **紀錄結構**：`{ id, date, vendor, applicant, ..., status: "待回報"|"已回報", report: null|{...}, audits: [...], v, updatedAt }`。點工父單的 `workers[]` 為 v11 前的預計進場名單（**v11 起新單一律空陣列**，僅舊單保留）、子層 `report.attendance[]`（逐人 present/work/ot）；機具子層 `report.usage[]`（逐台 present/hours）。`report.zeroWork`/`zeroUse` 為 0 工/0 使用確認旗標。`audits[]`（v13）＝成控現場稽核紀錄（合約 §4.5），查核項目文字可由 config.local.js `auditItems` 覆蓋。
- **樂觀並發**：寫入附 `baseV`，與現存 `v` 不符回 409（含「已被刪除但 baseV>0」）；成功回 `{v, updatedAt}`。**v18 起點工/機具四表單改樂觀渲染**：開表單即快照 baseV、背景才刷新，送出以快照為 baseV（合約 §3.3 v18 補充）——避免背景刷新讓版本漂移而繞過 409。**稽核模組例外**：saveAudit/deleteAudit 送出時讀快取即時 v，因此任何整批刷新（含 bgRefetchVerify 與四個載入 fallback）都必須在稽核表單編輯中（auditSelectedId）時跳過，與稽核側以 otherFormEditing 把關互為對稱——兩道守衛缺一不可。
- **選項新增**：`op:addOption` 伺服器端 read-merge-write，避免兩人同時新增互相覆蓋。整包 config 覆蓋只用於管理員批次儲存。

## 前端要點（app.js）

- 無 localStorage 業務資料；記憶體快取 `SITE_CACHE` ＋ sessionStorage（`dm_site` 本分頁工地、`dm_admin` 管理員狀態）。
- 寫入 await-first：雲端成功才清表單；失敗保留輸入提示重試；409 顯示「已被他人修改」並重載。
- 防呆：開站選工地攔截頁（每 session 必選）、表單常駐工地徽章、申請送出前 confirm 工地、0 必須勾「0 工/0 使用確認」、出工×加班異常警告（可確認後送出）、鎖檔（v24.7 `config.lockRanges` 區間清單：可多段、可預約生效時刻、可停用解鎖，各站獨立、管理員限定；判定唯一入口 `isLockedDate()`／訊息 `lockReason()`，**新增攔截點別自己重寫判定**。舊 `lockDate` 保留相容。**地端後端於 `op:record`／`op:deleteRecord` 再擋一次**，修改時新舊日期都查）、已回報單刪除限管理員。
- 日期一律 `localDate()`（本地時區）——不可用 `toISOString().slice(0,10)`（UTC 會把 UTC+8 早上記成前一天，影響計價月份）。
- 管理員模式為前端層級防誤觸（adminPin 比對），非資安防線；真正權限需後端登入（未做）。

## 工作規範

1. **去識別化（最高優先）**：進 git 的一切內容不得含真實工地代號、分包商名、人名、密碼。提交前掃描 staged diff。真實名單僅存於本機 `config.local.js`（gitignored）與 Netlify 環境變數。
2. **改版留痕**：現行實務為**直接 commit 到 main**（每次推送即觸發部署，需先取得專案負責人核准），非 PR 流程。新功能新增 `docs/milestones/NN-描述.md` 並更新索引與 CHANGELOG；同一節點的補強修正**追加到既有 NN 檔案**，不另編號；營運操作（不改碼）記到 `docs/ops-log.md`（同樣去識別化）。
3. **測試共用資料庫**：用拋棄式工地名寫入，測畢 `op:clearSite` 清除；嚴禁 `clearAll`。
4. 程式風格：原生 JS、無依賴（僅 @netlify/blobs）、繁體中文 UI 與註解、`esc()` 處理所有插入 DOM 的動態字串。
5. **新增檔案先定位三大項**：畫面相關→`frontend/`、伺服器/資料庫相關→`backend/`、說明文件→`docs/`。
   前端不得引用後端原始碼（只透過 `/api/data`），後端不得含頁面，文件不含可執行程式。

## 檔案地圖（三大項：前端／後端／文件）

```
frontend/                      ★ 前端，唯一對外發布的目錄（netlify.toml publish）
  index.html                   頁面結構（6 頁籤含管理員限定稽核頁＋申請/回報子頁＋overlay 們）
  app.js                       全部前端邏輯（約 3,400 行，區塊註解分段）
  style.css                    樣式（根基營造品牌設計系統：暖中性＋深板岩藍、尖角、無漸層）
  config.local.js              （gitignored）真實名單；格式見 app.js 開頭註解

backend/
  cloud/functions/api.mjs      資料 API（op: master/config/record/addOption/deleteRecord/
                               uploadAttachment/deleteAttachment/rateBook/deleteRateBook/
                               clearSite/clearAll ＋ GET ?attachment= ＋ GET ?rates=1）
  cloud/edge-functions/auth.ts 整站 Basic Auth
  onprem/server.mjs            可攜式伺服器（零依賴 Node 18+；同一 API 合約＋靜態服務＋Basic Auth）
  onprem/import-backup.mjs     資料遷移（備份 JSON → 地端資料目錄；**不含附件本體**）
  sql/                         SQL 交付包：DB-SCHEMA.sql 19表5VIEW＋backup-json-to-sql.py＋README
                               （已於 LocalDB 以正式資料實測對帳）

docs/
  API-CONTRACT.md            ★ 前後端接縫合約（op 規格/409 語意/欄位字典）——改欄位先改這份
  MIGRATION-PLAN.md          ★ 地端移轉計畫（現況/目標架構/分工/資料與附件移轉/時程/回退）
  AUTH-PLAN.md               ★ 權限規畫（SSO/ERP 權限來源/角色判定規則/驗收情境）
  DEPLOYMENT.md                地端部署手冊（給 IT）
  milestones/                  迭代節點文件（背景/決策/驗證）
  ops-log.md                   營運紀錄（去識別化）

netlify.toml                   ⚠ publish / functions / edge_functions **三個路徑都明示**
scripts/build-config.mjs       建置時由環境變數產生 frontend/config.local.js
README.md                      導覽入口（三大項說明）
CHANGELOG.md                   版本摘要
```

> **改動目錄結構時**：`netlify.toml` 的三個路徑、`scripts/build-config.mjs` 的輸出路徑、
> 工作資料夾 `.claude/launch.json` 的 `--directory` 必須同步——漏改會部署出空站或 API 404。

## 已知限制與擱置項目

- 同筆紀錄並發：409 保護下仍是「後確認者重填」；無合併編輯
- 無使用者身分/操作軌跡（單一共用帳密）；審計需求要升級含登入的後端
- 鎖單/刪除保護/管理員皆前端管控；成控稽核頁（v13）對工地端為 UI 層隱藏，資料層面 audits 仍隨單據 JSON 傳輸——真正權限隔離待地端個人登入
- 擱置待議：清單狀態快篩、總覽跨工地待回報名單、逐人計價明細 CSV 匯出
