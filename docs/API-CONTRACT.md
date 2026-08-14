# API 合約規格書（前後端接縫）

> **本文件的目的**：前端（`app.js`）與後端之間只有一個接縫——`/api/data`。
> 未來以公司標準技術（任何語言／資料庫）重寫後端時，只要新後端實作本合約，**前端零修改**。
> 本合約有兩份參考實作可對照：`backend/cloud/functions/api.mjs`（雲端版）與 `backend/onprem/server.mjs`（地端版），行為一致。

**合約版本**：1（對應系統 v18，2026-07；v17/v17.1 異動——名單池不再帶種子/自動補值（§4.2 laborTypes 註記）；v18 異動——前端 baseV 快照紀律（§3.3 補充）；v12 異動——selfDone* 六→表單移除轉唯讀承繼、conclusion 取消字數上限，見 §4.3 註記；v13 異動——紀錄新增 `audits[]` 成控現場稽核陣列，見 §4.5；v14 異動——附件：新增 §2.3 下載、§3.6/§3.7 上傳刪除、§4.6 描述資料，deleteRecord/clearSite 連動清附件）
**變更紀律**：任何欄位/操作的增修都必須先更新本文件，並保持向下相容（新增欄位可選、不刪除既有欄位語意）。
> ⚠ **合約與 DDL 是同一件事的兩面**：動了欄位就必須同步改 `backend/sql/DB-SCHEMA.sql`
> 與 `backup-json-to-sql.py`。節點 34 只改了合約沒改 DDL，若照原樣移轉會**靜默遺失**
> 費率相關的三樣資料（前端讀不到綁定＝全部變成「未能計價」，但不會報錯）。

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

### 2.4 `GET ?rates=1` — 行情通報費率書（v22.8）

回應：`{ "labor": [ ...季別... ], "equipment": [ ...季別... ] }`，季別結構見 §4.8。

- 儲存為**一個 kind 一把 key**（`rates:labor`／`rates:equipment`）——兩者同放一把時，
  同時匯入租工與機具會是兩個「讀整包→改→寫整包」互相覆蓋，後寫的把先寫的那一半無聲蓋掉
- **刻意不放進 `scope=all`**：一季 1,500 列、多季累積數 MB，塞進開站的全量讀取會拖慢每個人。
  前端只在「設定頁」與「歷程報表」需要時才抓，抓到後快取於記憶體。
- 尚未匯入任何費率書時回 `{ "labor": [], "equipment": [] }`（非 404）

### 2.3 `GET ?site=<工地名>&attachment=<附件id>` — 附件下載（v14）

- 回應為**二進位內容**（非 JSON）：`Content-Type` 為上傳時的原始型別、`Content-Disposition: inline; filename*=UTF-8''<檔名>`
- 附件 id 格式同紀錄 id（`^[A-Za-z0-9_-]{1,64}$`），不符回 `400`；不存在回 `404`
- 附件內容不可變（同 id 不會被覆蓋為不同內容），後端可下 `Cache-Control: private, max-age=86400`

## 3. 寫入（POST，body 以 `op` 分派）

### 3.1 `op:"master"` — 覆蓋工地清單
```json
{ "op":"master", "sites":["工地A","工地B"], "adminDepartments":["成本管理部"] }
```
- `sites` 必須為非空陣列，否則 `400`。成功回 `{ "ok": true }`
- **`adminDepartments`（v23.2，選填）**：省略時**保留既有值**，不是清空。
  這一點與 `sites` 的整包覆蓋語意刻意不同——舊版前端與其他呼叫端只送 `sites`，
  若比照覆蓋會把管理員設定一起洗掉。要清空請明確送空陣列（語意見 §4.1）

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
2. **版本檢查**：`baseV`＝前端載入當下的版本。**v18 補充（前端紀律）**：表單開啟當下即快照 baseV，之後任何背景刷新都不得更新該快照——送出一律用快照值，確保「使用者所見版本」與「宣告基準版本」一致，背景刷新不會讓寫入繞過 409
   - 現存紀錄的 `v` ≠ `baseV` → `409 { "error":"conflict", "reason":"modified" }`
   - 紀錄不存在但 `baseV` > 0 → `409 { "error":"conflict", "reason":"deleted" }`
3. 通過後：後端以 `v = baseV + 1`、`updatedAt = 現在時間(ISO 8601)` 覆寫整筆
4. 成功回 `{ "ok":true, "v":<新版本>, "updatedAt":"<ISO>" }`

> 409 是前端「兩人同時編輯不互相覆蓋」的基礎，**語意不可改**。

### 3.4 `op:"addOption"` — 新增單一選項（伺服器端合併）
```json
{ "op":"addOption", "site":"工地A", "pool":"vendors", "value":"新選項" }
```
- `pool` 白名單：`vendors | locations | categories | equipTypes | people | workers | laborTypes`（**本行是白名單的正準定義**；api.mjs／server.mjs／SQL 交付包中的複本以此為準，增減池別先改這裡）
- **v15.1**：`pool="people"` 時 `value` 僅接受**單一人名**——含分隔符（`+ ＋ / ／ \ 、 , ， ; ； : ： 空白`）回 `400 { "error":"person name must be a single name" }`（回報覆核限一位工程師代表，名單源頭即堵住多人並列）
- 後端 **read-merge-write**：讀該站 config → 值不存在才 push → 寫回（兩人同時新增不互蓋）
- 成功回 `{ "ok":true, "pool":[...合併後完整清單...] }`（前端會以此覆蓋本地快取）

### 3.5 `op:"deleteRecord"` — 刪除單筆
```json
{ "op":"deleteRecord", "site":"工地A", "kind":"labor", "id":"abc123" }
```
- `id` 同 §3.3 格式驗證。成功回 `{ "ok": true }`（不存在也回 ok，冪等）

### 3.6 `op:"uploadAttachment"` — 上傳附件（v14）
```json
{ "op":"uploadAttachment", "site":"工地A", "id":"<前端產生的附件id>",
  "name":"簽單.jpg", "type":"image/jpeg", "data":"<base64 檔案內容>" }
```
- `type` 白名單：`image/jpeg | image/png | image/webp | application/pdf`（**正準定義**），其餘 `400`
- 解碼後大小上限 **4MB**（前端已將圖片壓縮至長邊 1600px／JPEG 0.8，遠小於此；PDF 為原檔），超過 `400`
- `id` 格式同紀錄 id；`name` 截斷至 200 字
- 檔案本體獨立儲存（**不進**單據 JSON）；描述資料由前端寫入單據的 `attachments[]`（§4.6）
- 成功回 `{ "ok":true, "id":"...", "size":<bytes> }`

### 3.7 `op:"deleteAttachment"` — 刪除附件（v14）
```json
{ "op":"deleteAttachment", "site":"工地A", "id":"<附件id>" }
```
- 冪等，成功回 `{ "ok":true }`
- 前端紀律：**單據儲存成功後**才對被移除的附件呼叫本 op（表單取消不誤刪）

### 3.9 `op:"rateBook"` — 匯入一季行情通報（v22.8）
```json
{ "op":"rateBook", "kind":"labor"|"equipment",
  "label":"115Q3", "effectiveFrom":"2026-07-01", "rows":[ ...見 §4.8... ] }
```
- `effectiveFrom` 必須是 `YYYY-MM-DD`，`rows` 必須是非空陣列，否則 `400`
- **以 `effectiveFrom` 為鍵整季覆蓋**：同一生效日重匯即取代（可重複匯入修正檔），
  不同生效日則並存——計價要能回查歷史季別
- 每個 kind 最多保留 `RATE_BOOK_MAX = 12` 季（三年）；超過時**丟棄最舊的**並在回應中告知
- 成功回 `{ "ok":true, "kind":..., "books":[{label,effectiveFrom,importedAt,rowCount}...], "dropped":<被丟棄的季數> }`

### 3.10 `op:"deleteRateBook"` — 刪除某一季（v22.8）
```json
{ "op":"deleteRateBook", "kind":"labor", "effectiveFrom":"2026-07-01" }
```
- 冪等，成功回 `{ "ok":true, "books":[...] }`

### 3.8 `op:"clearSite"` / `op:"clearAll"` — 清空（危險操作）
- `clearSite`：刪除該站全部**紀錄與附件**（不含 config）。`clearAll`：刪除全部資料
- 回 `{ "ok":true, "deleted":<筆數> }`
- v14 起 `deleteRecord` 亦須連同該單引用的全部附件（含各稽核紀錄的附件）一併刪除，避免孤兒檔案
- ⚠ 現行合約對清空二 op 無額外權限檢查（已知限制）；公司後端重寫時**建議加上伺服器端管理權限**，此屬合約的允許強化（前端行為不受影響）

## 4. 資料模型（欄位字典）

### 4.1 master
`{ "sites": string[], "adminDepartments"?: string[] }` — 全域設定。
`sites` 為工地清單，順序即顯示順序。

**`adminDepartments`（v23.2）**：管理員部門白名單，供**地端權限模組**判定「系統管理者」
（AUTH-PLAN §2.4 規則 1）。放在 master 而非各站 config，是因為它是跨工地的全域設定。

- 雲端過渡期**不使用**這個欄位（雲端沒有個人身分驗證），但仍原樣儲存與回傳——
  設定要能在切換到地端**之前**就先維護好，切換日才不必重設一次
- 比對是**逐字元完全相符**人資 API 回傳的 `deptName`（含全半形與空白）
- 未提供或空陣列 → 地端回退到 `appsettings` 的 `Auth:AdminDepartments`。
  **這是刻意的保險**：避免有人在後台清空後把所有管理者一起鎖在門外

> **與 SQL 交付包 `sites.is_active` 欄位的關係**：`is_active` 是資料庫內部治理欄位（軟退場、保留已結案專案的歷史紀錄），**不屬於本合約的線上格式**。合約行為不變：`scope=all` 仍以 master.sites 全清單回應、`op:master` 仍為整包覆蓋——後端可在 op:master 時把「自清單消失的站」標記 is_active=0 而非刪除資料，但不得據此過濾合約回應。

### 4.2 config（每工地一份）
| 欄位 | 型別 | 說明 |
|---|---|---|
| vendors | string[] | 分包商/機具廠商名單 |
| locations | string[] | 工作地點 |
| categories | string[] | 工作內容類別（點工申請用） |
| equipTypes | string[] | 機具類型 |
| people | string[] | 工程師名單（申請人/簽單責任工程師） |
| workers | string[] | 點工人員名單（**v11 起前端不再使用**，保留相容） |
| laborTypes | string[] | 出工工種（v11 新增；**v17.1 起前端不再自動補預設**——各工地自行建立，空陣列即為空） |
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
| audits | object[]（可缺省） | **v13**：成控現場稽核紀錄陣列（一單可多次稽核），元素結構見 4.5；沿用 `op:record` 整筆覆寫與版本檢查，無獨立 op |
| attachments | object[]（可缺省） | **v14**：簽單掃描檔/附件的描述資料陣列（檔案本體獨立存放），元素結構見 4.6 |
| v, updatedAt | number, string | 後端維護（版本/時間），前端唯讀 |

子層 `report`（回報覆核）：
| 欄位 | 型別 | 說明 |
|---|---|---|
| reportedAt | "YYYY-MM-DD" | 回報日 |
| engineer | string | 簽單責任工程師（必填） |
| checkFace / checkCard / checkToolbox | boolean | 三道查核依據 |
| workTypes | {type,work,ot2,otOver}[] | **v11**：逐工種明細；work=出工數、ot2=加班前2小時、otOver=第3小時起（單位小時） |
| （歸段規則） | — | **僅有 totalOT 的舊單（v11 前），其加班一律歸入「前 2 小時」段**（ot2 視為 totalOT、otOver 視為 0）。前端彙總、SQL 遷移與所有報表實作皆須遵循此規則，勿各自詮釋 |
| attendance | {name,present,work,ot,added?}[] | 舊制逐人明細（v11 前）；新寫入時原樣保留舊值 |
| actual | number | 簽單實際出工數（=Σ workTypes.work 或手填） |
| ot2Total / otOverTotal | number | 分段加班總計（v11） |
| totalOT | number | 加班合計（=ot2Total+otOverTotal；舊單只有此欄） |
| diff | number | actual − required |
| zeroWork | boolean | 0 工確認（true 時 workTypes 為空、actual=0） |
| signReturnDate | string\|"" | 簽單繳回日。**v22.7 起強制 `date ≤ signReturnDate ≤ date + 20 天`**（見 §4.7 日期防呆） |
| selfDoneWork / selfDoneHours / selfDoneNote | number\|null, number\|null, string | 根基自辦 工數/時數/備註（v10 新增；**v12 起表單移除**——未填代辦即為自辦。前端寫入時將舊值原樣承繼，僅舊資料非空；報表欄位保留顯示） |
| vendorDoneWork / vendorDoneHours / vendorDoneNote | 同上 | 廠商代辦（**v23 起表單移除**，改用 `agentItems`；舊值原樣承繼並在報表保留顯示，見 §4.10） |
| selfDone / vendorDone | string | v10 前的單一文字欄（僅舊單存在；顯示時 fallback 至備註） |
| agentItems | {vendor,type,work,ot2,otOver,note}[] | **v23 代辦逐筆**：一張單可代辦多家。`vendor`＝責任歸屬廠商、`type`＝工種（**必須是本單 `workTypes` 出現過的工種**）、`work`／`ot2`／`otOver`＝歸屬該廠商的工數與分段加班時數。空陣列＝全數自辦。詳見 §4.10 |
| conclusion | string | 現場查核回饋（v12 起不限字數；後端請勿設過短的欄位長度上限，建議 TEXT/NVARCHAR(MAX) 級） |

### 4.4 機具紀錄（kind=equipment）

父層：id/date/applicant/status/report/audits/v/updatedAt 同上，另有：

| 欄位 | 型別 | 說明 |
|---|---|---|
| types | string[] | 機具類型 |
| model | string | 型號 |
| requiredQty | number | **需求數量（台數）**。v22.6 前的欄位說明誤寫為「預計使用時數」，實際一直是台數 |
| plannedHours | number\|null | **預定使用時數**（v22.6 新增）。與回報的 `actualHours` 相減才是有意義的差異；舊單為 null，差異顯示空白 |
| applyNote | string | **申請備註**（v22.6 新增）。包月機具等計價前提寫在這裡；支援自動列點（節點 31） |
| contracted | "是"\|"否" | 是否為合約廠商 |
| locations | string[] | 工作地點 |
| content | string | 工作內容（申請時的預計內容） |
| vendor | string | 機具廠商。**v22.6 起申請表單不再填**——工地統一叫車後才配車，廠商於回報時填。舊單保留原值，新單為空字串 |

子層 `report`：

| 欄位 | 型別 | 說明 |
|---|---|---|
| checker | string | 簽單責任工程師 |
| usage | {type,present,hours}[] | 逐台到場與時數 |
| actualHours | number | 實際使用時數 |
| diff | number\|null | **`actualHours − plannedHours`**（v22.6 起）。`plannedHours` 為 null 的舊單則為 null（無從比較）。**v22.6 前是 `actualHours − requiredQty`＝時數減台數，本就無意義** |
| vendor | string | **回報廠商**（v22.6 新增）。實際配到的車行 |
| days | number | **出工天數**（v22.6 新增）。可填 0.5／1／2…；舊單視為 0 |
| otHours | number | **加班時數**（v22.6 新增）。**單一欄不分段**——點工的「前 2 小時／第 3 小時起」分段規則**不適用於機具**（2026-08-10 裁示） |
| workContent | string | **實際工作內容**（v22.6 新增）。支援自動列點 |
| zeroUse | boolean | 0 使用確認 |
| signReturnDate | string\|"" | 簽單繳回日。**v22.7 起強制 `date ≤ signReturnDate ≤ date + 20 天`**（見 §4.7 日期防呆） |
| 自辦/代辦六欄 | 同 4.3 | |
| agentItems | {vendor,qty,note}[] | **v23 代辦逐筆**：一張單可代辦多家。`vendor`＝責任歸屬廠商、`qty`＝歸屬該廠商的數量。**`qty` 的單位由主品項的 `chargeType` 決定**（全天→天、時租→小時），與 §4.9 的計價數量同源。空陣列＝全數自辦。詳見 §4.10 |

> **有效廠商（計價與報表分組依據）＝ `report.vendor || vendor`**。
> 回報填了就以回報為準，沒填才回頭用申請單上的（僅舊單會有）。
> 清單、歷程報表、計價彙總、稽核紀錄一律走這個規則，勿各自實作。

### 4.5 稽核紀錄（`audits[]` 元素；v13，點工/機具通用）
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | 前端產生（同 record id 格式） |
| auditedAt | "YYYY-MM-DD" | 稽核日期（本地時區）；編輯既有紀錄時**不變** |
| editedAt | "YYYY-MM-DD"（可缺省） | 最近一次編輯日；僅編輯過的紀錄存在此欄 |
| auditor | string | 稽核人（必填） |
| applied | number | 稽核當下的申請數快照（點工=required；機具=requiredQty **台數**，非時數） |
| actualCount | number | 現場實點數（人數/台數） |
| diff | number | actualCount − applied |
| items | {text,ok,reason}[] | 逐項查核結果：text=項目文字、ok=相符(true)/不相符(false)、reason=不符原因（ok=false 時必填，否則空字串） |
| note | string | 現場狀況說明（不限字數，建議 NVARCHAR(MAX) 級） |
| statusAtAudit | string | 稽核當下的單據狀態快照（"待回報"/"已回報"） |
| attachments | object[]（可缺省） | **v14**：現場照片/附件描述資料（結構見 4.6；照片會嵌入稽核 PDF 報告） |

> 查核項目文字由前端設定檔（config.local.js `auditItems`）決定，後端一律照存 `items[].text`，不得以固定清單驗證。稽核功能為前端管理員（成控）限定；資料層面 audits 隨單據一起讀寫，後端無需額外權限邏輯（地端若導入個人登入，可於 API 層加稽核角色檢查）。

### 4.6 附件描述資料（`attachments[]` 元素；v14，申請單／稽核紀錄通用）
| 欄位 | 型別 | 說明 |
|---|---|---|
| id | string | 前端產生（同 record id 格式）；即 §2.3/§3.6 的附件 id |
| name | string | 顯示檔名（圖片壓縮後為 `.jpg`） |
| type | string | MIME 型別（§3.6 白名單之一） |
| size | number | 位元組數（壓縮後實際大小） |
| uploadedAt | "YYYY-MM-DD" | 上傳日（本地時區） |

> **檔案本體與描述資料分離**是本設計的鐵則：單據 JSON 永遠只含描述資料，`scope=all` 全量載入與管理員 JSON 備份都不含檔案本體。**因此 JSON 備份不等於完整備份**——地端切換日必須另以 §2.3 逐一下載附件檔案（見 DEPLOYMENT.md 切換流程與 backend/sql/README.md 附件搬運節）。地端後端建議：描述資料入 `attachments` 資料表、檔案本體存檔案系統（路徑欄位記錄），不建議存 DB BLOB。

### 2.5 `GET ?candidates=1` — 可納管的工地候選（v23.3；地端限定）

回 `{ "candidates":[ { "projectCode","projectName","engineers","leads" } ], "reason"?:string }`

- 僅列出「ERP 有本公司人員掛**工地角色**（工程師／主任）、而本系統 `sites.project_code`
  尚未使用該代碼」的專案；`engineers`／`leads` 為人數
- **限系統管理者**（`Auth:Mode≠Off` 時；Off 時由整站 Basic Auth 把守）
- 無 ERP 連線時回 `{ "candidates": [], "reason": "..." }`——**不是錯誤**，
  讓畫面能說明「此環境無法列出候選」而不是顯示失敗

### 3.11 `op:"adoptSite"` — 納管一個工地（v23.3；地端限定）

```json
{ "op":"adoptSite", "projectCode":"151D", "site":"工地顯示名稱" }
```

- **單一交易內**完成三件事：建立工地（或更新既有同名工地）、寫入
  `sites.project_code`、把該專案的工程師姓名併入該站人員池（`people`）
- 成功回 `{ "ok":true, "site":"...", "projectCode":"...", "peopleAdded":N }`
- `projectCode` 已被其他工地使用 → `409`（一個專案代碼只能對應一個工地）
- 雲端無 ERP 連線 → **`501`**（不可默默回 200：前端 await-first 會當成成功）
- 人員池採**併入不覆蓋**：既有名單保留，只補進尚未存在的姓名

> 納管後仍需人工建立的：分包商、工種、工作地點、機具類型——
> 這些 ERP 沒有，且各站差異大，維持各站自建（§4.2 的設計）。

### 4.8 行情通報費率書（v22.8）

一個「季別」（book）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| label | string | 季別標示，例 `115Q3`（僅供顯示） |
| effectiveFrom | "YYYY-MM-DD" | **生效日；同時是這一季的唯一鍵** |
| importedAt | "YYYY-MM-DD" | 匯入日 |
| rows | object[] | 費率列（見下） |

費率列（兩種 kind 的共同欄位）：

| 欄位 | 說明 |
|---|---|
| vendorCode | 供應商編號（**綁定用的穩定鍵**，公司全名可能改寫、編號不會） |
| vendorName | 供應商名稱（公司全名） |
| region | 區域別（北區／中區／南區／全省） |
| note | 說明欄，例「打石工-一般工地」——**租工綁定的關鍵**，區分同廠商同工種的不同適用工地 |
| item | 品項原文 |
| unit | 單位（工／天／HR／月／趟） |
| price | 單位價格 |

`kind=labor` 另有（自 `item` 文字解析而來）：

| 欄位 | 說明 |
|---|---|
| work / ot2 / otOver | 每工單價／加班前 2 小時／第 3 小時起（元）。**對應 §4.3 的分段口徑** |
| otParsed | boolean | 品項文字是否真的載明加班費率。**false 時 ot2/otOver 的 0 代表「沒寫」而非「免費」**——有加班時數的單必須擋下，不可用 0 元計價 |

> 來源檔把費率寫在品項文字裡，且有三種寫法：`加班前2hr=N`、`第3hr起=N`、`加班N元/HR`。
> 沒寫「第 3 小時起」者視為不分段（`otOver = ot2`）。非費率列（如「各工種每工統一加保加價費」）
> 於匯入時就濾掉，不進 rows。

`kind=equipment` 另有：

| 欄位 | 說明 |
|---|---|
| chargeType | `全天`／`半天`／`時租`／`加班`／`月租`／`趟次`，由品項文字與單位判定 |

#### 綁定（存於各站 `config.rateBindings`）

| 欄位 | 說明 |
|---|---|
| labor | `{ "<系統廠商>\|<工種>": { vendorCode, note } }` — 綁到「供應商＋說明」。**不可綁品項文字**：租工的品項含價格，每季都會變 |
| equipment | `{ "<系統廠商>": "<vendorCode>" }` — **只綁到廠商層級**；實際品項由工程師回報時從該廠商清單挑（2026-08-10 裁示） |

機具回報因此新增兩個欄位（§4.4 子層）：`rateItem`（主品項原文）、`rateOtItem`（加班費率品項原文）。
單據**只存挑了哪一項，不存金額**——計價時依出工日期回查當季費率（見 §4.9）。

### 4.9 計價金額（v22.8；前端計算，不落庫）

- **費率書的選用**：取 `effectiveFrom ≤ 出工日期` 之中最新的一季。查無適用季別時金額顯示「—」，
  **不可當作 0**——0 會被讀成「免費」
- 點工：`Σ 各工種( 出工數×work ＋ 前2h×ot2 ＋ 第3h起×otOver )`
- 機具：數量依主品項的 `chargeType` 決定，**不是一律乘天數**——
  `全天`＝出工天數×單價、`時租`＝實際使用時數×單價；
  `半天`／`月租`／`趟次` 系統目前沒有對應的數量欄位（幾個半天／幾個月／幾趟），一律擋下並說明。
  加班另計：`加班時數×加班品項單價`
- 匯入時即濾掉單價 ≤ 0 的列：`rateNum` 會把空白與文字收斂成 0，放行等於在計價表上印「免費」
- 未綁定、綁定失效（該季查無該供應商／該說明）、或工程師未挑品項時，同樣顯示「—」並在報表標示原因

### 4.10 代辦與代扣（v23；點工/機具回報通用）

「代辦」＝根基向本單廠商叫了工／機具，但這筆成本**應歸屬給另一家廠商**（例：幫某分包商叫吊卡），
計價時要從該廠商的款項中扣回。v22 以前只有「代辦工數／時數／備註」三欄，責任歸屬廠商寫在
自由文字備註裡（例「○○公司扣 2 工，扣款 4200」）——**無法自動統計**，正是要消除的人工作業。

**資料**：`report.agentItems[]`，一張單可列多家（§4.3／§4.4 的欄位表）。空陣列＝全數自辦。

**代扣金額的算法（唯一權威）**：

- **費率一律取「本單廠商」的費率，不是責任歸屬廠商的**。
  理由：代扣的是我們**實際付出去的錢**——那是付給本單廠商的價；責任歸屬廠商只是歸屬對象，
  拿它的費率算會得出一個從未發生過的金額。
- 點工：`Σ 各代辦列( work×rate.work ＋ ot2×rate.ot2 ＋ otOver×rate.otOver )`，
  `rate` 的查找與 §4.9 完全相同（本單廠商＋該工種的綁定）。
- 機具：`qty × 主品項單價`，單位同 §4.9（全天→天、時租→小時）。
- 查無費率時**該列金額為 null 並記原因**，與 §4.9 一致，**不可退化為 0**。

**約束**（前端強制，後端建議比照）：

- 代辦列的 `type` 必須是本單 `workTypes` 出現過的工種——否則費率查找沒有依據
- 同一工種的代辦工數合計 **不得超過**該工種的回報工數（代辦是回報量的一部分，不是額外量）；
  加班時數同理
- `vendor`（責任歸屬廠商）為**自由文字**，不限於 `vendors` 名單池（v23.5 起）——
  代扣對象常是**施工廠商**，本來就不在點工／機具廠商名單裡。前端以 datalist 提供
  「名單池 ∪ 本站已用過的代辦廠商」作為建議並自動 trim，但不做白名單驗證

**與舊欄位的關係**：`vendorDoneWork`／`vendorDoneHours`／`vendorDoneNote` 自 v23 起表單不再填寫，
既有值原樣承繼並在報表保留顯示。**新舊不相加**——報表分開兩欄呈現，避免重複計算。

### 4.11 工地納管（v23.3；地端限定）

新工地目前要人工做三件事：加進工地清單、建立名單池、填 `sites.project_code`。
第三項漏做**不會報錯**，只會讓該站「除了管理員以外沒人看得到」——最難察覺。

納管功能把前兩步與第三步合併成一次操作：系統比對 ERP，列出「**有本公司人員掛
工地角色、但本系統尚未建立**」的專案供管理員勾選，勾選即自動建站、填入
`project_code`、並把該專案的工程師帶進人員池。

- **刻意不做全自動同步**：ERP 權限檢視表涵蓋約 317 個專案，本系統只需其中十餘個。
  全自動會把大量無關專案灌進工地選單
- **僅地端可用**：需要 ERP 權限檢視表連線。雲端無此連線——
  `GET ?candidates=1` 回空清單並附 `reason`；`op:adoptSite` 回 **501**
- 工程師姓名取自權限檢視表的 `UserName`，**不需要人資 API**
  （人資 API 只能以 AD 帳號單筆查詢，列不出整個專案的成員）

### 4.7 日期防呆（v22.7；點工/機具回報通用）

兩條規則都是**硬性擋下**，因為這兩個欄位最容易被拿來製造「有按時出工／按時繳回」的假象：

| 規則 | 條件 | 理由 |
|---|---|---|
| 回報時機 | 送出回報時 `record.date ≤ 今天` | 回報是「這天實際做了什麼」的紀錄；出工日還沒到就先回報，紀錄本身沒有意義 |
| 簽單繳回日 | `date ≤ signReturnDate ≤ date + 20 天` | 早於出工日不可能；晚於 20 天視為逾期不予採計，避免無限拖延。繳回日**可以是未來日期**（簽單尚未收回先預定），只要在 20 天內 |

- 期限天數為前端常數 `SIGN_RETURN_MAX_DAYS = 20`；日期選擇器同步設定 `min`／`max`，
  送出時的檢查是最後一道而非唯一一道。
- **目前僅前端強制**。地端 API 應在伺服器端重做同樣檢查——前端驗證擋得住誤填，
  擋不住直接打 API。
- 既有資料不受影響（不會回頭改寫）；但若編輯一張違反規則的舊單，儲存時會被擋下並要求修正。

## 5. 給後端重寫者的相容須知

1. **整筆覆寫語意**：`op:record` 是整筆取代（除 v/updatedAt 由後端蓋上）。改用關聯式資料庫時可正規化儲存，但回傳給前端時必須組回上述 JSON 形狀
2. **未知欄位保留**：前端送什麼就存什麼；後端不得剝除未列於本文件的欄位（前端以整筆讀-改-寫工作，剝除即資料遺失）
3. **時區**：所有日期為「YYYY-MM-DD」本地日期字串，後端**不得**轉 UTC 重格式化
4. **排序**：前端自行以 id 排序，後端回傳順序不拘
5. **參考的資料表設計**（供 IT 起步，非強制）：`sites`(name) / `site_config`(site, pool, value) / `labor_records`(id, site, date, vendor, …, status, v, updated_at) / `labor_report`(record_id 1:1, engineer, actual, ot2_total, …) / `labor_report_worktypes`(record_id, type, work, ot2, ot_over) / `equipment_records` + `equipment_usage` 同構；`report` 也可先以 JSON 欄位整包存（過渡成本最低）
6. **驗收方式**：新後端完成後，直接以現行前端跑 `DEPLOYMENT.md` §4 的驗證清單，再加測「兩個瀏覽器同時編輯同一筆 → 後送出者收到 409」
