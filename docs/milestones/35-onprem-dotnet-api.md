# 節點 35：地端 .NET 8 API — 階段 A（唯讀端點）

## 背景

地端遷移的最後一塊拼圖是 API 服務。原本的 `backend/onprem/server.mjs` 需要 Node 執行環境，
但公司主機沒有 Node、只有 .NET 8 SDK，資訊處也建議以 .NET 開發。因此以 .NET 8 Minimal API
重寫同一份合約（`docs/API-CONTRACT.md`），前端一行都不用改。

分階段推進，每階段都要能獨立驗收：

| 階段 | 範圍 | 狀態 |
|---|---|---|
| **A** | `GET ?scope=all`、`GET ?site=`、靜態前端 | ✅ 本節點 |
| B | `op:record`（含 409）、`master`、`config`、`addOption` | ⬜ |
| C | 附件上下載、行情通報費率書 | ⬜ |
| D | SSO／權限過濾（見 `AUTH-PLAN.md`） | ⬜ |

## 先補上 v22.8 的 SQL 缺口

動工前發現 **節點 34 改了合約卻沒改 `DB-SCHEMA.sql`**：`rateItem`／`rateOtItem`、
各站 `rateBindings`、以及費率書本身在 SQL 都沒有落點。若照原樣移轉，這三樣會**靜默消失**
（前端讀不到綁定＝所有計價變成「未能計價」，但不會報錯）。

補上：

- `equip_reports` 增 `rate_item`、`rate_ot_item` 兩欄
- 新增 `rate_books`、`rate_book_rows`、`site_rate_bindings` 三表
- `backup-json-to-sql.py` 同步輸出上述欄位與 `site_rate_bindings`

資料表數量 11 → **14 表 5 VIEW**。

> 教訓：合約與 DDL 是**同一件事的兩面**，改欄位必須兩邊一起改。
> 已在 `API-CONTRACT.md` 開頭加註提醒。

## 實作決策

**不用 EF，直接 ADO.NET（`Microsoft.Data.SqlClient`）。**
合約的 JSON 形狀是固定且巢狀的，ORM 的物件關聯反而要多一層轉換；直接寫 SQL 能逐句對照
`sql/README.md`，出問題時查得動。

**`InvariantGlobalization` 不可開。**
實測設為 `true` 時 `SqlConnection.Open()` 直接丟 `NotSupportedException`。
中文定序與日期格式本來也需要完整 globalization——部署到 Linux 容器記得裝 ICU。
已在 `.csproj` 留註解。

**日期一律本地字串。**
沿用計價紅線第 2 條：`DateStr()` 走 `DateTime` 的本地格式，**絕不 UTC 化**。
UTC 會把台灣早上記成前一天，直接改變計價月份。

**未實作的操作一律回 501，不可默默回 200。**
前端寫入是 await-first：收到 2xx 就清空表單。階段 B 尚未實作的 `POST /api/data`
若默默回 200，使用者填的資料會直接消失。已對 `POST`、`?attachment=`、`?rates=1` 三處明確回 501。

**同一服務供應靜態前端。**
與 `server.mjs` 同樣的部署形態，前端因此是同源呼叫、不需要 CORS。
靜態根寫死指向 `frontend/`，可用環境變數 `STATIC_DIR` 覆寫——
**不可指向 repo 根或 `backend/`**，那會把後端原始碼與 SQL DDL 一併對外提供下載。

## 驗證

**1. 逐欄比對：以正式資料快照為基準，比對地端 API 與雲端 API 的 `scope=all` 回應。**

996 筆單據＋12 站 config 全數逐欄比對。真實差異 **0 處**。
另有兩類「形狀差異」判定為等價並記錄在案：

- 合約標示可缺省的鍵（`audits`／`attachments`／`lockDate`／v22.6 新欄位…）：
  雲端在空值時不輸出，地端一律輸出空值。前端兩者都走 falsy 判斷。
- 某張只有 `totalOT` 的舊單：地端依合約 §4.3 歸段規則把時數明寫進前 2h 段。
  比雲端的隱含更明確，且與計價紅線第 1 條一致。

**2. 端到端開站：把前端指向本服務，實際操作。**

12 工地、683 筆點工、313 筆機具、83 筆附件全數渲染；六個頁籤都正常。

單一工地的計價彙總與 SQL 直查逐項對帳：

| 項目 | 畫面（前端算） | SQL 直查 |
|---|---|---|
| 已回報單數 | 328 | 328 |
| 總出工數 | 1,002 | 1,002 |
| 加班前 2h | 1,704 | 1,704 |
| 加班第 3h 起 | 2,374 | 2,374 |

逐工種加總 = 報表層合計，且 `total_ot` 4,078 = 1,704 + 2,374——分段口徑在 SQL 內自洽。

**3. 路徑外洩檢查**：`/appsettings.json`、`/Program.cs`、`/../backend/sql/DB-SCHEMA.sql` 皆回 404。

## 已知限制

- 目前只有唯讀端點，**不能拿來取代雲端**；階段 B 完成前雲端仍是唯一寫入來源
- Basic Auth 沿用單一共用帳密（與雲端相同），真正的個人身分要等階段 D
- 連線字串預設指向本機 LocalDB 的 `KG_AUDIT_STAGING`（測試庫）；
  正式環境務必以環境變數 `KGAUDIT_CONNECTION` 覆蓋
