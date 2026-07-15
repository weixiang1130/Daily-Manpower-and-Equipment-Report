# 節點 18：SQL 交付包——資料表設計與遷移工具（實測於 SQL Server）

**日期**：2026-07-07
**狀態**：已完成開發與 LocalDB 實測；**依部署凍結規範僅在分支，未合併**（純文件與工具，不影響執行中系統）

## 背景

資訊處回覆：現行架構要上公司系統，需由使用者端「重新編寫後端」。使用者裁示：SQL 建表等能先做的先做好，連同其他交付物一起移交資訊處。開發機恰有 SQL Server LocalDB＋sqlcmd（無 .NET SDK、無 Node），因此採取「**資料層全部做完並實測，API 薄層留給資訊處用其標準實作**」的分工。

## 交付內容（docs/sql/）

1. **DB-SCHEMA.sql**：8 表＋4 VIEW（SQL Server 方言）
   - 表：sites / site_options（7 類名單池共用）/ labor_records / labor_reports（1:1）/ labor_report_worktypes（1:N 工種）/ equip_records / equip_reports / equip_report_usage
   - VIEW：點工與機具的「歷程明細」「計價彙總」各一，對應系統現有兩張報表
   - 設計對應 API-CONTRACT §4 欄位字典：分段加班、v12 唯讀自辦欄、legacy_* 歷史欄、多值欄位 JSON 過渡、`is_active` 支援專案退場
2. **backup-json-to-sql.py**：完整備份 JSON → INSERT 腳本轉換器（資料遷移工具；utf-8-sig 輸出配 sqlcmd -f 65001）
3. **README.md**：給資訊處的實作指引——7 op ↔ SQL 對照、409 並發的條件式 UPDATE 寫法（已實測）、遷移四步、驗收方式、兩個免費改良機會（總覽輕量端點、報表下推資料庫）

## 驗證紀錄（LocalDB，正式站真實資料）

- DDL 一次執行通過（8 表 4 VIEW）
- 以**正式站當日完整備份**（16 工地、1,353 個選項、92 筆點工單、32 份回報、42 列工種明細）經轉換器產生 1,540 行 SQL，匯入**零錯誤**
- 對帳：筆數 5 項（sites/options/records/reports/worktypes）SQL vs JSON 全數一致；計價彙總 3 項總數（總出工 89、前 2 小時加班 189、逾 2 小時 177）與 JSON 獨立計算**分毫不差**
- 中文編碼抽查正確（NVARCHAR＋utf-8-sig＋`-f 65001` 鏈路完整）
- 409 並發模式實測：`UPDATE ... WHERE id=@id AND v=@baseV` 版本不符影響 0 列、相符影響 1 列並遞增
- 敏感資料紀律：真實備份與產出的 import.sql 僅存於本機暫存區，repo 內全部檔案去識別化

## 設計決策 / 取捨

- **API 薄層不代寫**：開發機無 .NET SDK 無從實測，且資訊處的框架/認證（AD?）標準未知——交「已實測的資料層＋合約＋對照表」比交「沒跑過的程式」對雙方都負責
- **多值欄位 JSON 過渡**：遷移成本最低且合約允許；正規化留給資訊處依報表需求決定
- 本機留有 KG_AUDIT_STAGING 資料庫（LocalDB）供向資訊處展示
