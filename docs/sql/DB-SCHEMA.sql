/* ==========================================================================
   點工機具稽核系統 — 關聯式資料庫建表草稿（SQL Server 方言）
   ==========================================================================
   用途：交付資訊處，作為地端後端重寫時的資料層起點。
   對應規格：docs/API-CONTRACT.md（前後端接縫合約；欄位語意以合約為準）
   驗證狀態：已於 SQL Server LocalDB 實際建置，並以正式站完整備份 JSON
             經 backup-json-to-sql.py 匯入驗證（筆數與彙總數字對帳一致）。

   設計原則：
   1. 一張申請單（父）＝ labor_records / equip_records 一列；
      回報（子）拆 1:1 主檔＋1:N 明細，對應合約 §4.3/§4.4
   2. 多值欄位（地點/類別/機具類型/舊人員名單）先以 JSON 字串過渡
      （合約 §5 允許），資訊處可視報表需求再正規化成子表
   3. 樂觀並發：v 欄位 + 條件式 UPDATE（範例見 README.md §3），
      合約的 409 語意不可省略
   4. 舊制欄位（legacy_*）僅承載歷史資料，新寫入不再產生
   5. 全部文字欄用 NVARCHAR（繁中）；日期一律 DATE（本地日期，勿轉時區）
   ========================================================================== */

/* ---------- 1. 工地主檔 ---------- */
CREATE TABLE dbo.sites (
    site_id     INT IDENTITY(1,1) CONSTRAINT PK_sites PRIMARY KEY,
    name        NVARCHAR(100) NOT NULL CONSTRAINT UQ_sites_name UNIQUE,
    lock_date   DATE NULL,              -- 計價鎖定日（含）以前非管理員不可增修刪
    is_active   BIT NOT NULL CONSTRAINT DF_sites_active DEFAULT 1,  -- 專案退場=0
    sort_order  INT NOT NULL CONSTRAINT DF_sites_sort DEFAULT 0
);

/* ---------- 2. 名單池（廠商/地點/類別/機具類型/工程師/工種…共用一張） ---------- */
CREATE TABLE dbo.site_options (
    option_id   INT IDENTITY(1,1) CONSTRAINT PK_site_options PRIMARY KEY,
    site_id     INT NOT NULL CONSTRAINT FK_opt_site REFERENCES dbo.sites(site_id),
    pool        VARCHAR(20) NOT NULL CONSTRAINT CK_opt_pool CHECK (pool IN
                ('vendors','locations','categories','equipTypes','people','workers','laborTypes')),
    value       NVARCHAR(200) NOT NULL,
    CONSTRAINT UQ_site_options UNIQUE (site_id, pool, value)
);

/* ---------- 3. 點工申請單（父） ---------- */
CREATE TABLE dbo.labor_records (
    id              VARCHAR(64) NOT NULL CONSTRAINT PK_labor PRIMARY KEY,  -- 合約 ^[A-Za-z0-9_-]{1,64}$
    site_id         INT NOT NULL CONSTRAINT FK_labor_site REFERENCES dbo.sites(site_id),
    work_date       DATE NOT NULL,
    vendor          NVARCHAR(200) NOT NULL,
    applicant       NVARCHAR(100) NOT NULL,
    required_units  DECIMAL(6,2) NOT NULL CONSTRAINT DF_labor_req DEFAULT 0,   -- 需求工數(可0.5)
    locations_json  NVARCHAR(MAX) NULL,   -- JSON 陣列，例 ["A區","B區"]
    categories_json NVARCHAR(MAX) NULL,   -- JSON 陣列（工作內容類別）
    category_note   NVARCHAR(500) NULL,
    workers_json    NVARCHAR(MAX) NULL,   -- 舊制人員名單（v11 起新單為空陣列）
    status          NVARCHAR(10) NOT NULL CONSTRAINT CK_labor_status CHECK (status IN (N'待回報', N'已回報')),
    v               INT NOT NULL CONSTRAINT DF_labor_v DEFAULT 1,              -- 樂觀並發版本
    updated_at      DATETIME2(0) NOT NULL CONSTRAINT DF_labor_upd DEFAULT SYSDATETIME()
);
CREATE INDEX IX_labor_site_date ON dbo.labor_records(site_id, work_date);
CREATE INDEX IX_labor_vendor    ON dbo.labor_records(site_id, vendor);

/* ---------- 4. 點工回報（子，1:1） ---------- */
CREATE TABLE dbo.labor_reports (
    record_id        VARCHAR(64) NOT NULL CONSTRAINT PK_labor_rep PRIMARY KEY
                     CONSTRAINT FK_labor_rep REFERENCES dbo.labor_records(id) ON DELETE CASCADE,
    reported_at      DATE NULL,
    engineer         NVARCHAR(100) NULL,          -- 簽單責任工程師
    check_face       BIT NOT NULL DEFAULT 0,      -- 三道查核依據
    check_card       BIT NOT NULL DEFAULT 0,
    check_toolbox    BIT NOT NULL DEFAULT 0,
    actual           DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 簽單實際出工數
    ot2_total        DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 加班·前2小時 總計(v11 分段計價)
    ot_over_total    DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 加班·第3小時起 總計
    total_ot         DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 合計(=ot2+ot_over；舊單只有此值)
    diff             DECIMAL(6,2) NOT NULL DEFAULT 0,   -- actual - required
    zero_work        BIT NOT NULL DEFAULT 0,            -- 0工確認
    sign_return_date DATE NULL,                          -- 簽單繳回日
    vendor_done_work  DECIMAL(6,2) NULL,   -- 廠商代辦 工數（NULL=未填，與 0 區分）
    vendor_done_hours DECIMAL(6,2) NULL,   -- 廠商代辦 時數
    vendor_done_note  NVARCHAR(500) NULL,
    self_done_work    DECIMAL(6,2) NULL,   -- 根基自辦（v12 起唯讀歷史；未填代辦=全數自辦）
    self_done_hours   DECIMAL(6,2) NULL,
    self_done_note    NVARCHAR(500) NULL,
    legacy_self_done   NVARCHAR(500) NULL, -- v10 前單一文字欄，僅舊資料
    legacy_vendor_done NVARCHAR(500) NULL,
    legacy_attendance_json NVARCHAR(MAX) NULL,  -- v11 前逐人明細，原樣保存
    conclusion       NVARCHAR(MAX) NULL          -- 現場查核回饋（v12 起不限字數）
);

/* ---------- 5. 點工回報 工種明細（子，1:N；v11 逐工種覆核） ---------- */
CREATE TABLE dbo.labor_report_worktypes (
    worktype_row_id INT IDENTITY(1,1) CONSTRAINT PK_labor_wt PRIMARY KEY,
    record_id   VARCHAR(64) NOT NULL CONSTRAINT FK_labor_wt
                REFERENCES dbo.labor_reports(record_id) ON DELETE CASCADE,
    work_type   NVARCHAR(100) NOT NULL,          -- 粗工/技術工/打石工…
    work        DECIMAL(6,2) NOT NULL DEFAULT 0, -- 出工數
    ot2         DECIMAL(6,2) NOT NULL DEFAULT 0, -- 加班·前2小時
    ot_over     DECIMAL(6,2) NOT NULL DEFAULT 0  -- 加班·第3小時起
);
CREATE INDEX IX_labor_wt_record ON dbo.labor_report_worktypes(record_id);

/* ---------- 6. 機具申請單（父） ---------- */
CREATE TABLE dbo.equip_records (
    id              VARCHAR(64) NOT NULL CONSTRAINT PK_equip PRIMARY KEY,
    site_id         INT NOT NULL CONSTRAINT FK_equip_site REFERENCES dbo.sites(site_id),
    work_date       DATE NOT NULL,
    vendor          NVARCHAR(200) NOT NULL,       -- 機具廠商（=責任廠商）
    applicant       NVARCHAR(100) NOT NULL,
    types_json      NVARCHAR(MAX) NULL,           -- 機具類型 JSON 陣列（可複選）
    model           NVARCHAR(200) NULL,           -- 型號
    required_qty    DECIMAL(8,2) NOT NULL DEFAULT 0,  -- 需求數量=預計使用時數
    contracted      NVARCHAR(2) NULL,             -- 是/否（合約廠商）
    locations_json  NVARCHAR(MAX) NULL,
    content         NVARCHAR(500) NULL,           -- 工作內容（文字）
    status          NVARCHAR(10) NOT NULL CONSTRAINT CK_equip_status CHECK (status IN (N'待回報', N'已回報')),
    v               INT NOT NULL CONSTRAINT DF_equip_v DEFAULT 1,
    updated_at      DATETIME2(0) NOT NULL CONSTRAINT DF_equip_upd DEFAULT SYSDATETIME()
);
CREATE INDEX IX_equip_site_date ON dbo.equip_records(site_id, work_date);

/* ---------- 7. 機具回報（子，1:1） ---------- */
CREATE TABLE dbo.equip_reports (
    record_id        VARCHAR(64) NOT NULL CONSTRAINT PK_equip_rep PRIMARY KEY
                     CONSTRAINT FK_equip_rep REFERENCES dbo.equip_records(id) ON DELETE CASCADE,
    reported_at      DATE NULL,
    checker          NVARCHAR(100) NULL,          -- 簽單責任工程師
    actual_hours     DECIMAL(8,2) NOT NULL DEFAULT 0,
    diff             DECIMAL(8,2) NOT NULL DEFAULT 0,
    zero_use         BIT NOT NULL DEFAULT 0,
    sign_return_date DATE NULL,
    vendor_done_work  DECIMAL(6,2) NULL,
    vendor_done_hours DECIMAL(6,2) NULL,
    vendor_done_note  NVARCHAR(500) NULL,
    self_done_work    DECIMAL(6,2) NULL,
    self_done_hours   DECIMAL(6,2) NULL,
    self_done_note    NVARCHAR(500) NULL,
    legacy_self_done   NVARCHAR(500) NULL,
    legacy_vendor_done NVARCHAR(500) NULL
);

/* ---------- 8. 機具回報 逐台明細（子，1:N） ---------- */
CREATE TABLE dbo.equip_report_usage (
    usage_row_id INT IDENTITY(1,1) CONSTRAINT PK_equip_usage PRIMARY KEY,
    record_id   VARCHAR(64) NOT NULL CONSTRAINT FK_equip_usage
                REFERENCES dbo.equip_reports(record_id) ON DELETE CASCADE,
    equip_type  NVARCHAR(100) NOT NULL,
    present     BIT NOT NULL DEFAULT 0,
    hours       DECIMAL(6,2) NOT NULL DEFAULT 0
);
CREATE INDEX IX_equip_usage_record ON dbo.equip_report_usage(record_id);
GO

/* ==========================================================================
   VIEW：對應系統現有兩張報表（期間/廠商由查詢端 WHERE 篩選）
   ========================================================================== */

/* 點工歷程明細（= 前端「歷程報表·點工紀錄」的平面化） */
CREATE VIEW dbo.v_labor_detail AS
SELECT
    s.name              AS site,
    r.work_date, r.vendor, r.required_units, r.applicant, r.status,
    r.categories_json, r.locations_json, r.category_note,
    rep.check_face, rep.check_card, rep.check_toolbox,
    rep.sign_return_date, rep.actual, rep.diff, rep.zero_work, rep.engineer,
    rep.ot2_total, rep.ot_over_total, rep.total_ot,
    rep.vendor_done_work, rep.vendor_done_hours, rep.vendor_done_note,
    rep.self_done_work, rep.self_done_hours, rep.self_done_note,
    rep.conclusion,
    r.id AS record_id, r.v, r.updated_at
FROM dbo.labor_records r
JOIN dbo.sites s ON s.site_id = r.site_id
LEFT JOIN dbo.labor_reports rep ON rep.record_id = r.id;
GO

/* 點工計價彙總（= 前端「計價彙總」：依 工地×廠商，只計已回報） */
CREATE VIEW dbo.v_labor_pricing_summary AS
SELECT
    s.name    AS site,
    r.vendor,
    COUNT(*)                                    AS reported_count,
    SUM(CASE WHEN rep.zero_work = 1 THEN 1 ELSE 0 END) AS zero_work_count,
    SUM(rep.actual)        AS total_work,
    SUM(rep.ot2_total)     AS total_ot_first2h,
    SUM(rep.ot_over_total) AS total_ot_over2h,
    SUM(ISNULL(rep.vendor_done_work, 0))  AS vendor_done_work,
    SUM(ISNULL(rep.vendor_done_hours, 0)) AS vendor_done_hours,
    SUM(ISNULL(rep.self_done_work, 0))    AS self_done_work,
    SUM(ISNULL(rep.self_done_hours, 0))   AS self_done_hours
FROM dbo.labor_records r
JOIN dbo.sites s ON s.site_id = r.site_id
JOIN dbo.labor_reports rep ON rep.record_id = r.id
WHERE r.status = N'已回報'
GROUP BY s.name, r.vendor;
GO

/* 機具歷程明細 */
CREATE VIEW dbo.v_equip_detail AS
SELECT
    s.name AS site,
    r.work_date, r.vendor, r.types_json, r.model, r.required_qty, r.contracted,
    r.applicant, r.status, r.content, r.locations_json,
    rep.sign_return_date, rep.actual_hours, rep.diff, rep.zero_use, rep.checker,
    rep.vendor_done_work, rep.vendor_done_hours, rep.vendor_done_note,
    rep.self_done_work, rep.self_done_hours, rep.self_done_note,
    r.id AS record_id, r.v, r.updated_at
FROM dbo.equip_records r
JOIN dbo.sites s ON s.site_id = r.site_id
LEFT JOIN dbo.equip_reports rep ON rep.record_id = r.id;
GO

/* 機具計價彙總 */
CREATE VIEW dbo.v_equip_pricing_summary AS
SELECT
    s.name AS site,
    r.vendor,
    COUNT(*) AS reported_count,
    SUM(CASE WHEN rep.zero_use = 1 THEN 1 ELSE 0 END) AS zero_use_count,
    SUM(rep.actual_hours) AS total_hours,
    SUM(ISNULL(rep.vendor_done_work, 0))  AS vendor_done_work,
    SUM(ISNULL(rep.vendor_done_hours, 0)) AS vendor_done_hours,
    SUM(ISNULL(rep.self_done_work, 0))    AS self_done_work,
    SUM(ISNULL(rep.self_done_hours, 0))   AS self_done_hours
FROM dbo.equip_records r
JOIN dbo.sites s ON s.site_id = r.site_id
JOIN dbo.equip_reports rep ON rep.record_id = r.id
WHERE r.status = N'已回報'
GROUP BY s.name, r.vendor;
GO
