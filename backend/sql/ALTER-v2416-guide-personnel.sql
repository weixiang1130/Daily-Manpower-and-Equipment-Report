/* ==========================================================================
   ALTER v24.16：機具回報「引導人員」欄位（節點 64）
   --------------------------------------------------------------------------
   適用對象：已依 v24.15（含）之前的 DB-SCHEMA.sql 建過庫、且已有資料的環境。
   全新建庫者不需要執行本檔——DB-SCHEMA.sql 已包含這些定義。

   背景：堆高機等機具實務上常配一位引導（指揮）人員，屬「人」的口徑，
   加班沿用點工的前2小時／第3小時起分段（費率不同，合併就無法按段扣款）。
   四欄一律 NULL＝未填——與 0 有別（0 是「有此需求但當日為 0」），
   報表端據此決定該格留白或印 0。

   內容：dbo.equip_reports 新增四欄（guide_work / guide_ot2 / guide_ot_over /
   guide_note），並重建 v_equip_detail 與 v_equip_pricing_summary 兩個 VIEW
   讓新欄跟著出現。

   純**新增**，不改既有欄位型別、不搬移資料，可線上執行；
   重複執行安全（有存在性檢查；VIEW 用 CREATE OR ALTER）。

   執行：
     sqlcmd -S <server> -d <db> -E -f 65001 -b -i ALTER-v2416-guide-personnel.sql
   ⚠ -f 65001 不可省略——本檔含中文註解，少了會以 ANSI 解讀而報錯。
   ========================================================================== */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/* ---------- 1. equip_reports 四欄 ---------- */
IF COL_LENGTH('dbo.equip_reports', 'guide_work') IS NULL
BEGIN
    ALTER TABLE dbo.equip_reports ADD
        guide_work    DECIMAL(6,2) NULL,   -- 引導人員出工數(工)；NULL＝未填
        guide_ot2     DECIMAL(6,2) NULL,   -- 引導人員加班時數(前2小時)
        guide_ot_over DECIMAL(6,2) NULL,   -- 引導人員加班時數(第3小時起)
        guide_note    NVARCHAR(MAX) NULL;  -- 引導人員備註（自由文字一律 MAX，同 vendor_done_note 慣例）
    PRINT '已新增 dbo.equip_reports 引導人員四欄';
END
ELSE PRINT 'dbo.equip_reports.guide_work 已存在，略過';
GO

/* 1b. 曾以本腳本較早版本（guide_note NVARCHAR(400)）建過欄者：放寬為 MAX。
   400 上限只靠前端 maxlength 防守，直接打 API 的超長備註會讓整筆回報 INSERT 500、
   遷移時整批回滾（MAX 審查）。COL_LENGTH 對 NVARCHAR(MAX) 回 -1。 */
IF COL_LENGTH('dbo.equip_reports', 'guide_note') NOT IN (-1)
BEGIN
    ALTER TABLE dbo.equip_reports ALTER COLUMN guide_note NVARCHAR(MAX) NULL;
    PRINT '已放寬 dbo.equip_reports.guide_note 為 NVARCHAR(MAX)';
END
ELSE PRINT 'dbo.equip_reports.guide_note 已為 MAX（或不存在），略過';
GO

/* ---------- 2. 重建兩個 VIEW（帶入新欄） ---------- */
/* 內容須與 DB-SCHEMA.sql 的定義逐字一致——兩份是同一件事的兩面 */
CREATE OR ALTER VIEW dbo.v_equip_detail AS
SELECT
    s.name AS site,
    r.work_date,
    COALESCE(rep.vendor, r.vendor) AS vendor,        -- 有效廠商（合約 §4.4）
    r.types_json, r.model, r.required_qty, r.planned_hours, r.apply_note, r.contracted,
    r.applicant, r.status, r.content, r.locations_json,
    rep.sign_return_date, rep.actual_hours, rep.diff,
    rep.days, rep.ot_hours, rep.work_content,
    rep.guide_work, rep.guide_ot2, rep.guide_ot_over, rep.guide_note,   -- 節點 64 引導人員
    rep.zero_use, rep.checker,
    rep.vendor_done_work, rep.vendor_done_hours, rep.vendor_done_note,
    rep.self_done_work, rep.self_done_hours, rep.self_done_note,
    r.id AS record_id, r.v, r.updated_at
FROM dbo.equip_records r
JOIN dbo.sites s ON s.site_id = r.site_id
LEFT JOIN dbo.equip_reports rep ON rep.record_id = r.id;
GO

CREATE OR ALTER VIEW dbo.v_equip_pricing_summary AS
WITH e AS (
    SELECT r.site_id, r.id, r.types_json, r.status,
           COALESCE(rep.vendor, r.vendor) AS vendor,
           rep.zero_use, rep.actual_hours, rep.days, rep.ot_hours,
           rep.guide_work, rep.guide_ot2, rep.guide_ot_over,
           rep.vendor_done_work, rep.vendor_done_hours,
           rep.self_done_work, rep.self_done_hours
      FROM dbo.equip_records r
      JOIN dbo.equip_reports rep ON rep.record_id = r.id
     WHERE r.status = N'已回報'
)
SELECT
    s.name AS site,
    e.vendor,
    COUNT(*) AS reported_count,
    SUM(CASE WHEN e.zero_use = 1 THEN 1 ELSE 0 END) AS zero_use_count,
    SUM(ISNULL(e.days, 0))     AS total_days,      -- 總出工天數
    SUM(ISNULL(e.ot_hours, 0)) AS total_ot_hours,  -- 總加班時數
    /* 節點 64 引導人員：人（工）的口徑，與機具的天數／時數分欄並存，不相加。
       ⚠ 刻意**不包 ISNULL**（MAX 審查）：guide_* 是本表第一組「可空且 NULL 有語意」
       的數值欄（NULL＝未填≠0）。SUM 本來就跳過 NULL；包了 ISNULL 會把
       「整組全未填」壓成 0，與「真的填了 0」無法區分——前端明細刻意留白 vs 印 0，
       兩個權威出口不能互相矛盾。days/ot_hours 是 NOT NULL DEFAULT 0，其 ISNULL 無害。 */
    SUM(e.guide_work)    AS guide_work,
    SUM(e.guide_ot2)     AS guide_ot2,
    SUM(e.guide_ot_over) AS guide_ot_over,
    SUM(e.actual_hours) AS total_hours,
    SUM(ISNULL(e.vendor_done_work, 0))  AS vendor_done_work,
    SUM(ISNULL(e.vendor_done_hours, 0)) AS vendor_done_hours,
    SUM(ISNULL(e.self_done_work, 0))    AS self_done_work,
    SUM(ISNULL(e.self_done_hours, 0))   AS self_done_hours,
    /* 機具類型彙集（對應前端計價彙總最後一欄） */
    (SELECT STRING_AGG(d.val, N'、')
       FROM (SELECT DISTINCT j.value AS val
               FROM e e2
               CROSS APPLY OPENJSON(e2.types_json) j
              WHERE e2.site_id = e.site_id AND e2.vendor = e.vendor) d) AS equip_types
FROM e
JOIN dbo.sites s ON s.site_id = e.site_id
GROUP BY s.name, e.site_id, e.vendor;
GO

/* ---------- 驗收 ---------- */
SELECT
    (SELECT COUNT(*) FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.equip_reports')
        AND name IN ('guide_work','guide_ot2','guide_ot_over','guide_note')) AS guide_cols_ok,  -- 應為 4
    (SELECT COUNT(*) FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.v_equip_detail') AND name = 'guide_work')          AS view_detail_ok,   -- 應為 1
    (SELECT COUNT(*) FROM sys.columns
      WHERE object_id = OBJECT_ID('dbo.v_equip_pricing_summary') AND name = 'guide_work') AS view_summary_ok;  -- 應為 1
GO
