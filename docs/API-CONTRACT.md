# API 合約規格書（前後端接縫）

> **本文件的目的**：前端（`app.js`）與後端之間只有一個接縫——`/api/data`。
> 未來以公司標準技術（任何語言／資料庫）重寫後端時，只要新後端實作本合約，**前端零修改**。
> 本合約有兩份參考實作可對照：`netlify/functions/api.mjs`（雲端版）與 `server/server.mjs`（地端版），行為一致。

**合約版本**：1（對應系統 v12，2026-07；v12 異動——selfDone* 六→表單移除轉唯讀承繼、conclusion 取消字數上限，見 §4.3 註記）
**變更紀律**：任何欄位/操作的增修都必須先更新本文件，並保持向下相容（新增欄位可選、不刪除既有欄位語意）。

---

## 1. 傳輸與驗證

| 項目 | 規格 |
|---|---|
| 端點 | 單一端點；預設路徑 `/api/data`，前端可經 `config.local.js` 的 `apiBase` 改指其他路徑 |
| 方法 | `GET`（讀取）、`POST`（寫入，以 body 的 `op` 分派） |
| 格式 | JSON（UTF-8）；回應 `content-type: application/json; charset=utf-8` |
| 驗證 | HTTP Basic Auth，與站台同一組帳密；失敗回 `401` ＋ `WWW-Authenticate: Basic` |
| 跨域 | 前端預設同源呼叫。若公司後端掛在不同網域，後端需回應 CORS 標頭且允許 `Authorization`（建議仍以同源／反向代理處理，避免跨域複雜度） |
| 錯誤格式 | 非 2xx 時 body 為 `{ "error": "<訊息>", "reason"?: "<細節>" }`；前端只依 **HTTP 狀態碼** 行為（特別是 409），不解析錯誤字串 |

## 2. 讀取（GET）

### 2.1 `GET ?scope=all` — 全量讀取（開站／重新整理／備份）

回應：
```json
{
  "master": { "sites": ["工地A", "工地B"] },
  "stores": {
    "工地A": { "config": { ...見§4.2... }, "labor": [ ...紀錄... ], "equipment": [ ...紀錄... ] },
    "工地B": { "config": null, "labor": [], "equipment": [] }
  }
}
```
- `master` 不存在時回 `null`（前端會種入預設清單）
- `config` 不存在時該站回 `null`

### 2.2 `GET ?site=<工地名>` — 單一工地（編輯前抓最新）

回應：`{ "config": {...}|null, "labor": [...], "equipment": [...] }`

## 3. 寫入（POST，body 以 `op` 分派）

### 3.1 `op:"master"` — 覆蓋工地清單
```json
{ "op":"master", "sites":["工地A","工地B"] }
```
- `sites` 必須為非空陣列，否則 `400`。成功回 `{ "ok": true }`

### 3.2 `op:"config"` — 整包覆蓋單站設定（管理員批次儲存用）
```json
{ "op":"config", "site":"工地A", "config":{ ...見§4.2... } }
```
- 成功回 `{ "ok": true }`

### 3.3 `op:"record"` — 寫入單筆紀錄（含樂觀並發控制）★核心
```json
{ "op":"record", "site":"工地A", "kind":"labor"|"equipment",
  "record":{ ...見§4.3/§4.4，含 id... }, "baseV": 0 }
```
規則（缺一不可）：
1. `record.id` 必須符合 `^[A-Za-z0-9_-]{1,64}$`，否則 `400`
2. **版本檢查**：`baseV`＝前端載入當下的版本
   - 現存紀錄的 `v` ≠ `baseV` → `409 { "error":"conflict", "reason":"modified" }`
   - 紀錄不存在但 `baseV` > 0 → `409 { "error":"conflict", "reason":"deleted" }`
3. 通過後：後端以 `v = baseV + 1`、`updatedAt = 現在時間(ISO 8601)` 覆寫整筆
4. 成功回 `{ "ok":true, "v":<新版本>, "updatedAt":"<ISO>" }`

> 409 是前端「兩人同時編輯不互相覆蓋」的基礎，**語意不可改**。

### 3.4 `op:"addOption"` — 新增單一選項（伺服器端合併）
```json
{ "op":"addOption", "site":"工地A", "pool":"vendors", "value":"新選項" }
```
- `pool` 白名單：`vendors | locations | categories | equipTypes | people | workers | laborTypes`
- 後端 **read-merge-write**：讀該站 config → 值不存在才 push → 寫回（兩人同時新增不互蓋）
- 成功回 `{ "ok":true, "pool":[...合併後完整清單...] }`（前端會以此覆蓋本地快取）

### 3.5 `op:"deleteRecord"` — 刪除單筆
```json
{ "op":"deleteRecord", "site":"工地A", "kind":"labor", "id":"abc123" }
```
- `id` 同 §3.3 格式驗證。成功回 `{ "ok": true }`（不存在也回 ok，冪等）

### 3.6 `op:"clearSite"` / `op:"clearAll"` — 清空（危險操作）
- `clearSite`：刪除該站全部**紀錄**（不含 config）。`clearAll`：刪除全部資料
- 回 `{ "ok":true, "deleted":<筆數> }`
- ⚠ 現行合約對此二 op 無額外權限檢查（已知限制）；公司後端重寫時**建議加上伺服器端管理權限**，此屬合約的允許強化（前端行為不受影響）

## 4. 資料模型（欄位字典）

### 4.1 master
`{ "sites": string[] }` — 全域工地清單，順序即顯示順序。

### 4.2 config（每工地一份）
| 欄位 | 型別 | 說明 |
|---|---|---|
| vendors | string[] | 分包商/機具廠商名單 |
| locations | string[] | 工作地點 |
| categories | string[] | 工作內容類別（點工申請用） |
| equipTypes | string[] | 機具類型 |
| people | string[] | 工程師名單（申請人/簽單責任工程師） |
| workers | string[] | 點工人員名單（**v11 起前端不再使用**，保留相容） |
| laborTypes | string[] | 出工工種（v11 新增；缺少時前端補預設 粗工/技術工/打石工/其他） |
| lockDate | string("YYYY-MM-DD")\|"" | 計價鎖定日期；該日（含）以前單據前端禁止非管理員增修刪 |

### 4.3 點工紀錄（kind=labor）
父層（申請）：
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string `^[A-Za-z0-9_-]{1,64}$` | 前端產生（base36 時戳+亂數） |
| date | "YYYY-MM-DD" | 出工日期（**本地時區**；計價月份歸屬依據） |
| vendor | string | 分包商 |
| applicant | string | 申請人（工程師） |
| required | number | 需求工數（可 0.5） |
| workers | string[] | 預計進場人員（**v11 起新單為空陣列**，舊單保留） |
| locations | string[] | 工作地點（多選） |
| categories | string[] | 工作內容類別（多選） |
| categoryNote | string | 內容補充 |
| status | "待回報"\|"已回報" | 生命週期狀態 |
| report | object\|null | 子層回報（見下） |
| v, updatedAt | number, string | 後端維護（版本/時間），前端唯讀 |

子層 `report`（回報覆核）：
| 欄位 | 型別 | 說明 |
|---|---|---|
| reportedAt | "YYYY-MM-DD" | 回報日 |
| engineer | string | 簽單責任工程師（必填） |
| checkFace / checkCard / checkToolbox | boolean | 三道查核依據 |
| workTypes | {type,work,ot2,otOver}[] | **v11**：逐工種明細；work=出工數、ot2=加班前2小時、otOver=第3小時起（單位小時） |
| attendance | {name,present,work,ot,added?}[] | 舊制逐人明細（v11 前）；新寫入時原樣保留舊值 |
| actual | number | 簽單實際出工數（=Σ workTypes.work 或手填） |
| ot2Total / otOverTotal | number | 分段加班總計（v11） |
| totalOT | number | 加班合計（=ot2Total+otOverTotal；舊單只有此欄） |
| diff | number | actual − required |
| zeroWork | boolean | 0 工確認（true 時 workTypes 為空、actual=0） |
| signReturnDate | string\|"" | 簽單繳回日 |
| selfDoneWork / selfDoneHours / selfDoneNote | number\|null, number\|null, string | 根基自辦 工數/時數/備註（v10 新增；**v12 起表單移除**——未填代辦即為自辦。前端寫入時將舊值原樣承繼，僅舊資料非空；報表欄位保留顯示） |
| vendorDoneWork / vendorDoneHours / vendorDoneNote | 同上 | 廠商代辦 |
| selfDone / vendorDone | string | v10 前的單一文字欄（僅舊單存在；顯示時 fallback 至備註） |
| conclusion | string | 現場查核回饋（v12 起不限字數；後端請勿設過短的欄位長度上限，建議 TEXT/NVARCHAR(MAX) 級） |

### 4.4 機具紀錄（kind=equipment）
父層：id/date/vendor/applicant/status/report/v/updatedAt 同上，另有 `types:string[]`（機具類型）、`model:string`、`requiredQty:number`（需求數量=預計使用時數）、`contracted:"是"|"否"`、`locations:string[]`、`content:string`。
子層 `report`：`checker`（簽單責任工程師）、`usage:{type,present,hours}[]`（逐台）、`actualHours`、`diff`、`zeroUse`、`signReturnDate`、自辦/代辦六欄（同 4.3）。

## 5. 給後端重寫者的相容須知

1. **整筆覆寫語意**：`op:record` 是整筆取代（除 v/updatedAt 由後端蓋上）。改用關聯式資料庫時可正規化儲存，但回傳給前端時必須組回上述 JSON 形狀
2. **未知欄位保留**：前端送什麼就存什麼；後端不得剝除未列於本文件的欄位（前端以整筆讀-改-寫工作，剝除即資料遺失）
3. **時區**：所有日期為「YYYY-MM-DD」本地日期字串，後端**不得**轉 UTC 重格式化
4. **排序**：前端自行以 id 排序，後端回傳順序不拘
5. **參考的資料表設計**（供 IT 起步，非強制）：`sites`(name) / `site_config`(site, pool, value) / `labor_records`(id, site, date, vendor, …, status, v, updated_at) / `labor_report`(record_id 1:1, engineer, actual, ot2_total, …) / `labor_report_worktypes`(record_id, type, work, ot2, ot_over) / `equipment_records` + `equipment_usage` 同構；`report` 也可先以 JSON 欄位整包存（過渡成本最低）
6. **驗收方式**：新後端完成後，直接以現行前端跑 `DEPLOYMENT.md` §4 的驗證清單，再加測「兩個瀏覽器同時編輯同一筆 → 後送出者收到 409」
