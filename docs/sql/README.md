# SQL 交付包 — 給資訊處的資料庫與後端實作指引

> 本資料夾是「後端重寫」的起點包：**資料表已設計好、遷移工具已寫好、且經過多代理程式審查與兩輪實測**（正式站完整備份＋含髒資料/機具情境的合成備份）。貴部門只需在此之上實作 API 層（語言/框架自選），前端零修改。

## 0. 交付包內容與驗證狀態

| 檔案 | 內容 | 驗證狀態 |
|---|---|---|
| `DB-SCHEMA.sql` | 10 資料表＋5 VIEW（SQL Server 方言，含欄位註解、id/狀態 CHECK、計算欄位；v13 新增 labor_audits／equip_audits 稽核兩表＋v_audit_log） | ✅ LocalDB 實建 |
| `backup-json-to-sql.py` | 備份 JSON → INSERT 腳本轉換器（含髒資料防護與計數、時區正規化、預期筆數對帳註腳） | ✅ 兩組備份實測 |

**實測涵蓋**（SQL Server LocalDB）：
- 正式站完整備份：16 工地／1,353 選項／92 點工單匯入零錯誤；計價彙總三項總數與來源 JSON 獨立計算一致
- 合成備份（補足正式資料尚無的情境）：**機具三表＋兩機具 VIEW**、孤兒工地（已移除但留有紀錄→自動建檔 `is_active=0`、紀錄保留）、壞 id／壞日期／壞狀態／缺工種名（跳過＋計數）、大小寫重複選項（去重）、600 字備註、多行回饋（換行原樣保留）、`$(PATH)` 文字（不被替換）、空陣列欄位（保留 `[]` 不塌成 NULL）、UTC 時間戳轉本地
- 樂觀並發 SQL 模式（§3）：版本不符/相符兩情境實測（影響列數 0/1）
- 產出腳本含 `SET XACT_ABORT ON`：任何錯誤整批回滾，實測杜絕「部分匯入卻回報成功」

## 1. 整體架構

```
前端（不動） → /api/data（合約：docs/API-CONTRACT.md） → 貴部門的 API 層 → 本 SCHEMA
```

- **API 合約**是唯一規格來源；完成後用現行前端直接驗收（合約 §5.6）
- 部署總覽與切換流程屬 [`DEPLOYMENT.md`](../../DEPLOYMENT.md)；本文件只管資料層

## 2. 操作 ↔ SQL 對照（7 個 op ＋ 2 個 GET 讀取）

| 操作 | 對應 SQL |
|---|---|
| `GET ?site=` | 該站 records＋reports＋明細組回合約 JSON 形狀 |
| `GET ?scope=all` | 同上跑全部工地（**注意**：合約 §2.1 規定回傳 master 全清單，`is_active` 只是 DB 治理欄位，不得用來過濾合約回應——除非未來合約改版） |
| `op:master` | upsert `sites`（順序寫 `sort_order`；自清單移除的站建議僅設 `is_active=0` 保留歷史） |
| `op:config` | 整包覆蓋該站 `site_options`（delete+insert 交易）＋更新 `sites.lock_date` |
| `op:record` | **§3 並發模式**；父表 upsert＋回報 1:1/1:N 子表 delete+insert，同一交易。**v13 起紀錄含 `audits[]`（合約 §4.5）**：同交易內對 `labor_audits`/`equip_audits` delete+insert（無獨立 op，隨整筆覆寫語意處理） |
| `op:addOption` | `IF NOT EXISTS ... INSERT`（唯一鍵擋重複；注意 CI 定序下大小寫視為同值） |
| `op:deleteRecord` | 刪父列（FK CASCADE 帶走子表） |
| `op:clearSite` / `clearAll` | 建議**加伺服器端管理權限**後才開放（合約允許強化） |

## 3. 樂觀並發（409）— 已實測的寫法

```sql
UPDATE dbo.labor_records
   SET v = v + 1, updated_at = SYSDATETIME() /* , ...其他欄位... */
 WHERE id = @id AND v = @baseV;

IF @@ROWCOUNT = 0
    -- 存在但版本不符→409 modified；不存在且 baseV>0→409 deleted
    -- （新增：baseV=0 且不存在 → INSERT，v=1）
```
語意見合約 §3.3，**不可省略**。時間欄位一律本地時間（遷移工具已把歷史 UTC 時間戳轉為本地，請勿再用 UTC 函式造成同欄混基準）。

## 4. 兩個免費改良機會

1. **總覽/開站不必載全量**：總覽只需 `v_*_pricing_summary` 彙總數字；明細等進站再查（前端 `apiBase` 可配置，端點微調可協調）
2. **報表直接下推資料庫**：期間/廠商/工種任意切法＝VIEW＋WHERE；彙總 VIEW 已含「工作內容/機具類型」彙集欄（`categories`/`equip_types`），與現行 UI 計價彙總欄位一一對應

## 5. 資料遷移步驟（切換日）

> 完整切換流程（停機公告、驗證清單、舊站退場）以 **DEPLOYMENT.md §4** 為準；以下僅為其中「資料轉移」段的具體指令。

```bash
# 0) 於目標 SQL Server 建立空資料庫（名稱自訂，例）
sqlcmd -S <伺服器> -x -b -C -Q "CREATE DATABASE KG_AUDIT;"

# 1) 舊系統：設定頁 → 管理員 → 下載完整備份（JSON）
# 2) 轉換（會列出各表預期筆數與跳過統計）
python backup-json-to-sql.py 完整備份.json import.sql

# 3) 建表 + 匯入
sqlcmd -S <伺服器> -d KG_AUDIT -f 65001 -x -b -C -i DB-SCHEMA.sql
sqlcmd -S <伺服器> -d KG_AUDIT -f 65001 -x -b -C -i import.sql
```

**旗標缺一不可**：`-f 65001`＝UTF-8；`-x`＝停用 $() 變數替換（防環境變數被注入自由文字欄）；`-b`＝遇錯即停且回傳非零結束碼；`-C`＝信任伺服器憑證（ODBC 18 預設強制加密，自簽憑證環境沒有 -C 會直接拒連）。

**步驟 4）對帳**（於 SSMS 或 sqlcmd 執行下列 SQL）：

```sql
-- 各表 COUNT 對照轉換器輸出的「各表筆數」與 import.sql 檔尾的預期筆數註解
SELECT 'labor_records' AS t, COUNT(*) AS n FROM dbo.labor_records
UNION ALL SELECT 'labor_reports', COUNT(*) FROM dbo.labor_reports
UNION ALL SELECT 'labor_report_worktypes', COUNT(*) FROM dbo.labor_report_worktypes
UNION ALL SELECT 'equip_records', COUNT(*) FROM dbo.equip_records;

-- 彙總三數對照系統畫面「計價彙總」
SELECT SUM(total_work) AS 總出工, SUM(total_ot_first2h) AS 前2小時, SUM(total_ot_over2h) AS 第3小時起
  FROM dbo.v_labor_pricing_summary;
```

若轉換器回報「⚠ 跳過 N 筆不合格資料」，先依分類（id/日期/狀態/工種名/重複選項）回頭檢視備份內容再決定是否修復重轉。

## 6. 注意事項

- 日期欄位一律本地日期字串（YYYY-MM-DD），**勿做時區轉換**（合約 §5.3）；`updated_at` 由遷移工具統一為本地時間
- `conclusion` 與各備註欄不限字數（NVARCHAR(MAX)，前端無上限）
- `total_ot` 為計算欄位（＝ot2_total＋ot_over_total），後端**不要**嘗試寫入；重組 JSON 時直接讀取即可
- 舊制欄位（`legacy_*`、`self_done_*`）為唯讀歷史；多值欄位以 `*_json` 過渡，正規化與否由貴部門依報表需求決定（合約 §5.5）
