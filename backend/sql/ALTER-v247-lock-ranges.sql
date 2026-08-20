/* ==========================================================================
   ALTER v24.7：鎖檔區間 ＋ 月租逐日簽認工程師
   --------------------------------------------------------------------------
   適用對象：已依 v24.4（含）之前的 DB-SCHEMA.sql 建過庫、且已有資料的環境。
   全新建庫者不需要執行本檔——DB-SCHEMA.sql 已包含這些定義。

   內容：
     1. 新增 dbo.site_lock_ranges（鎖檔區間，取代單一切點 sites.lock_date）
     2. dbo.equip_usage_log 新增 signer 欄（月租逐日簽認工程師）

   兩項都是**新增**，不改既有欄位型別、不搬移資料，可線上執行；
   重複執行安全（有存在性檢查）。

   執行：
     sqlcmd -S <server> -d <db> -E -f 65001 -b -i ALTER-v247-lock-ranges.sql
   ⚠ -f 65001 不可省略——本檔含中文註解，少了會以 ANSI 解讀而報錯。
   ========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/* ---------- 1. 鎖檔區間 ---------- */
IF OBJECT_ID('dbo.site_lock_ranges', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.site_lock_ranges (
        lock_id      INT IDENTITY(1,1) CONSTRAINT PK_site_lock_ranges PRIMARY KEY,
        site_id      INT NOT NULL CONSTRAINT FK_lock_site REFERENCES dbo.sites(site_id),
        client_id    VARCHAR(64) NULL,
        date_from    DATE NULL,
        date_to      DATE NULL,
        effective_at DATETIME2(0) NULL,
        is_enabled   BIT NOT NULL CONSTRAINT DF_lock_enabled DEFAULT 1,
        note         NVARCHAR(200) NULL,
        updated_at   DATETIME2(0) NOT NULL CONSTRAINT DF_lock_upd DEFAULT SYSDATETIME()
    );
    CREATE INDEX IX_site_lock_ranges_site ON dbo.site_lock_ranges(site_id);
    PRINT '已建立 dbo.site_lock_ranges';
END
ELSE PRINT 'dbo.site_lock_ranges 已存在，略過';
GO

/* 既有的 sites.lock_date 一律**原樣保留**——應用層仍會讀它，
   等同一條 date_to = lock_date 的規則。不在此處自動轉檔：
   自動轉會產生兩份等效規則，日後管理員刪掉其中一份卻沒解鎖，最難查。 */

/* ---------- 2. 月租逐日簽認工程師 ---------- */
IF COL_LENGTH('dbo.equip_usage_log', 'signer') IS NULL
BEGIN
    ALTER TABLE dbo.equip_usage_log ADD signer NVARCHAR(100) NULL;
    PRINT '已新增 dbo.equip_usage_log.signer';
END
ELSE PRINT 'dbo.equip_usage_log.signer 已存在，略過';
GO

/* ---------- 驗收 ---------- */
SELECT
    (SELECT COUNT(*) FROM sys.tables WHERE name = 'site_lock_ranges')            AS lock_table_ok,   -- 應為 1
    (SELECT COUNT(*) FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.equip_usage_log') AND name = 'signer')    AS signer_col_ok,   -- 應為 1
    (SELECT COUNT(*) FROM dbo.site_lock_ranges)                                  AS lock_rows;       -- 新裝為 0
GO
