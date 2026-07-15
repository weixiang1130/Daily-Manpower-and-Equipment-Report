# SQL 交付包 — 給資訊處的資料庫與後端實作指引

> 本資料夾是「後端重寫」的起點包：**資料表已設計好、遷移工具已寫好、且全部在 SQL Server（LocalDB）上以正式站完整資料實測對帳過**。貴部門只需在此之上實作 API 層（語言/框架自選），前端零修改。

## 0. 交付包內容與驗證狀態

| 檔案 | 內容 | 驗證狀態 |
|---|---|---|
| `DB-SCHEMA.sql` | 8 張資料表＋4 個 VIEW（SQL Server 方言，含欄位註解） | ✅ LocalDB 實際建置通過 |
| `backup-json-to-sql.py` | 系統備份 JSON → INSERT 腳本轉換器（資料遷移用） | ✅ 以正式站完整備份實測：16 工地／1,353 選項／92 筆單據匯入零錯誤 |
| 對帳驗證 | 筆數 5 項與計價彙總 3 項總數（總出工/分段加班），SQL 端 vs 原始 JSON 獨立計算 | ✅ 全部一致 |
| 並發控制模式 | §3 的條件式 UPDATE | ✅ 版本不符/相符兩情境實測（影響列數 0/1） |

## 1. 整體架構

```
前端（不動） → /api/data（合約：docs/API-CONTRACT.md） → 貴部門的 API 層 → 本 SCHEMA
```

- **API 合約**是唯一規格來源：7 個操作的 request/response、驗證規則、欄位字典都在 `docs/API-CONTRACT.md`
- 完成後用現行前端直接驗收（合約 §5.6 驗收清單）

## 2. 七個操作 ↔ SQL 對照（實作提示）

| op | 對應 SQL |
|---|---|
| `GET ?site=` | 該站 `labor_records`+`labor_reports`+`labor_report_worktypes`（equip 同構）組回合約 JSON 形狀 |
| `GET ?scope=all` | 同上跑全部啟用工地（**建議改良**：前端僅總覽需要彙總數字，可另供輕量統計端點——見 §4） |
| `op:master` | upsert `sites`（名單順序寫 `sort_order`；移除的站建議設 `is_active=0` 而非刪除） |
| `op:config` | 整包覆蓋該站 `site_options`（delete+insert 交易）＋更新 `sites.lock_date` |
| `op:record` | **§3 的並發模式**；父表 upsert＋回報 1:1/1:N 子表 delete+insert，同一交易 |
| `op:addOption` | `IF NOT EXISTS ... INSERT site_options`（唯一鍵已擋重複） |
| `op:deleteRecord` | 刪父列（FK CASCADE 自動帶走回報與明細） |
| `op:clearSite` / `clearAll` | 建議**加上伺服器端管理權限**後才開放（合約允許強化） |

## 3. 樂觀並發（409）— 已實測的寫法

```sql
-- 更新既有紀錄：帶前端送來的 baseV 當條件
UPDATE dbo.labor_records
   SET v = v + 1, updated_at = SYSDATETIME() /* , ...其他欄位... */
 WHERE id = @id AND v = @baseV;

IF @@ROWCOUNT = 0
    -- 紀錄存在但版本不符→409 modified；紀錄不存在且 baseV>0→409 deleted
    -- （新增情境：baseV=0 且不存在 → INSERT，v=1）
```
語意詳見合約 §3.3，**不可省略**——這是多人同時編輯不互相覆蓋的基礎。

## 4. 送給貴部門的兩個免費改良機會

換成資料庫後，順手就能解掉現行架構的兩個已知天花板：
1. **總覽/開站不必載全量**：總覽只需 `v_*_pricing_summary` 等彙總數字；單據明細等使用者進到該工地再查。前端已預留 `apiBase` 可配置，端點微調時可協調
2. **報表直接下推資料庫**：期間/廠商/工種任意切法都是 VIEW＋WHERE 的事，不再受 6MB/全量限制

## 5. 資料遷移步驟（切換日）

```bash
# 1) 舊系統：設定頁 → 管理員 → 下載完整備份（JSON）
# 2) 轉換
python backup-json-to-sql.py 完整備份.json import.sql
# 3) 建庫後匯入（-f 65001 = UTF-8）
sqlcmd -S <伺服器> -d <資料庫> -f 65001 -i DB-SCHEMA.sql
sqlcmd -S <伺服器> -d <資料庫> -f 65001 -i import.sql
# 4) 對帳（與本包驗證方式相同）：
--   各表 COUNT 對備份 JSON 筆數；
--   SELECT SUM(total_work), SUM(total_ot_first2h), SUM(total_ot_over2h)
--     FROM v_labor_pricing_summary;  對系統畫面「計價彙總」
```

## 6. 注意事項

- 日期欄位一律本地日期字串（YYYY-MM-DD），**勿做時區轉換**（合約 §5.3）
- `conclusion` 不限字數（NVARCHAR(MAX)）；`self_done_*`／`legacy_*` 為唯讀歷史欄位，新寫入僅承繼
- 舊制多值欄位以 `*_json` 過渡，正規化與否由貴部門依報表需求決定（合約 §5.5）
