/* ==========================================================================
   升級腳本 v24.4 — 機具月租
   ==========================================================================
   適用對象：**已依先前版本建好資料庫**的環境。
             全新建置請直接用最新的 DB-SCHEMA.sql，不需要執行本腳本。

   背景：現場約 24% 的機具是月租（吊卡／吊車／山貓水車…）。舊結構只認
         「一天一單」，工地被迫每天開單、在工作內容裡手寫「包月-1、-2、-3…」
         自己編流水號。本次把月租變成一張單，施工軌跡改記在逐日使用紀錄。

   本腳本只**新增**欄位與資料表，不改動也不刪除任何既有資料：
     • equip_records  ＋ billing（預設「日租」，既有單自動視為日租）／rent_from／rent_to
     • equip_reports  ＋ on_site_days（月租的在場天數；日租為 NULL）
     • 新增 equip_usage_log（月租的逐日使用紀錄，一天一筆）

   執行方式（旗標與建庫時相同）：
     sqlcmd -S <伺服器> -d <資料庫> -f 65001 -x -b -C -i ALTER-v244-monthly-rental.sql
   ========================================================================== */

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

PRINT '--- v24.4 機具月租升級開始 ---';
GO

/* 1. 機具申請單：計費方式與租期 */
IF COL_LENGTH('dbo.equip_records', 'billing') IS NULL
    ALTER TABLE dbo.equip_records ADD
        billing   NVARCHAR(10) NOT NULL CONSTRAINT DF_equip_billing DEFAULT N'日租',
        rent_from DATE NULL,
        rent_to   DATE NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_equip_billing')
    ALTER TABLE dbo.equip_records ADD CONSTRAINT CK_equip_billing
        CHECK (billing IN (N'日租', N'月租'));
GO

/* 2. 機具回報：在場天數（月租＝逐日使用紀錄筆數） */
IF COL_LENGTH('dbo.equip_reports', 'on_site_days') IS NULL
    ALTER TABLE dbo.equip_reports ADD on_site_days INT NULL;
GO

/* 3. 逐日使用紀錄（月租專用；筆數＝在場天數，供廠商排名） */
IF OBJECT_ID('dbo.equip_usage_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.equip_usage_log (
        log_row_id  INT IDENTITY(1,1) CONSTRAINT PK_equip_usage_log PRIMARY KEY,
        record_id   VARCHAR(64) NOT NULL CONSTRAINT FK_equip_usage_log
                    REFERENCES dbo.equip_reports(record_id) ON DELETE CASCADE,
        use_date    DATE NOT NULL,
        note        NVARCHAR(MAX) NULL,
        hours       DECIMAL(6,2) NULL,
        CONSTRAINT UQ_equip_usage_log UNIQUE (record_id, use_date)
    );
    CREATE INDEX IX_equip_usage_log_record ON dbo.equip_usage_log(record_id);
END
GO

/* ---- 驗收 ---- */
SELECT '欄位' AS [項目], t.name AS [資料表], c.name AS [欄位], 'OK' AS [結果]
FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
WHERE (t.name = 'equip_records' AND c.name IN ('billing','rent_from','rent_to'))
   OR (t.name = 'equip_reports' AND c.name = 'on_site_days')
UNION ALL
SELECT '資料表', 'equip_usage_log', '(整張表)',
       CASE WHEN OBJECT_ID('dbo.equip_usage_log','U') IS NOT NULL THEN 'OK' ELSE '**缺少**' END;
GO

PRINT '--- v24.4 升級完成（上表應為 5 列 OK）---';
GO
