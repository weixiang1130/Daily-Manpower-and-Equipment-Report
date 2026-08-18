/* ==========================================================================
   升級腳本 v24 — 工數欄位精度 DECIMAL(6,2) → DECIMAL(8,4)
   ==========================================================================
   適用對象：**已依交付版 DB-SCHEMA.sql 建好資料庫**的環境。
             全新建置請直接用最新的 DB-SCHEMA.sql，不需要執行本腳本。

   為什麼要改：
     工地端改為填「實際工作時數」，系統以 8 小時＝1 工換算
     （例：5 小時 ＝ 0.625 工）。DECIMAL(6,2) 只有 2 位小數，
     0.625 會被**四捨五入成 0.63**（實測），反推回去變成 5.04 小時，
     計價金額與時數對不回來。

   為什麼加班欄位不動：
     ot2 / ot_over / ot_hours 存的是「時數」本身，以 0.5 為級距直接輸入、
     不經換算，2 位小數已足夠。

   安全性：
     - 只放寬精度（6,2 → 8,4），**不會遺失任何既有資料**（0.5 仍是 0.5000）
     - 這些欄位沒有索引、沒有 SCHEMABINDING 檢視表，ALTER 不會被擋
     - DEFAULT 條件約束會保留，NOT NULL 屬性在下列語句中明確重述

   執行方式（與 DB-SCHEMA.sql 相同的旗標）：
     sqlcmd -S <伺服器> -d <資料庫> -f 65001 -x -b -C -i ALTER-v24-work-precision.sql
   ========================================================================== */

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT '--- v24 工數精度升級開始 ---';
GO

/* 1. 點工申請單：需求工數 */
ALTER TABLE dbo.labor_records         ALTER COLUMN required_units DECIMAL(8,4) NOT NULL;
GO

/* 2. 點工回報：實際出工數、差異 */
ALTER TABLE dbo.labor_reports         ALTER COLUMN actual         DECIMAL(8,4) NOT NULL;
GO
ALTER TABLE dbo.labor_reports         ALTER COLUMN diff           DECIMAL(8,4) NOT NULL;
GO

/* 3. 逐工種明細：出工數（時數÷8 的換算值落在這裡） */
ALTER TABLE dbo.labor_report_worktypes ALTER COLUMN work          DECIMAL(8,4) NOT NULL;
GO

/* 4. 代辦逐筆：代辦工數（只代扣幾小時的情形，例 3 小時＝0.375 工） */
ALTER TABLE dbo.labor_agent_items     ALTER COLUMN work           DECIMAL(8,4) NOT NULL;
GO

/* 5. 成控稽核：申請工數快照、實點、差異（applied 取自 required_units，精度須一致） */
ALTER TABLE dbo.labor_audits          ALTER COLUMN applied        DECIMAL(8,4) NOT NULL;
GO
ALTER TABLE dbo.labor_audits          ALTER COLUMN actual_count   DECIMAL(8,4) NOT NULL;
GO
ALTER TABLE dbo.labor_audits          ALTER COLUMN diff           DECIMAL(8,4) NOT NULL;
GO

/* ---- 驗收：8 個欄位都應為 numeric(8,4) ---- */
SELECT t.name AS [資料表], c.name AS [欄位],
       CONCAT(ty.name, '(', c.precision, ',', c.scale, ')') AS [型別],
       CASE WHEN c.precision = 8 AND c.scale = 4 THEN 'OK' ELSE '**未升級**' END AS [結果]
FROM sys.columns c
JOIN sys.tables  t ON t.object_id = c.object_id
JOIN sys.types  ty ON ty.user_type_id = c.user_type_id
WHERE (t.name = 'labor_records'          AND c.name = 'required_units')
   OR (t.name = 'labor_reports'          AND c.name IN ('actual','diff'))
   OR (t.name = 'labor_report_worktypes' AND c.name = 'work')
   OR (t.name = 'labor_agent_items'      AND c.name = 'work')
   OR (t.name = 'labor_audits'           AND c.name IN ('applied','actual_count','diff'))
ORDER BY t.name, c.name;
GO

PRINT '--- v24 工數精度升級完成（上表 8 列應全為 OK）---';
GO
