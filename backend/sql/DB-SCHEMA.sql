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

/* sqlcmd 預設 QUOTED_IDENTIFIER OFF，而計算欄位（total_ot）要求 ON */
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/* ---------- 1. 工地主檔 ---------- */
CREATE TABLE dbo.sites (
    site_id      INT IDENTITY(1,1) CONSTRAINT PK_sites PRIMARY KEY,
    name         NVARCHAR(100) NOT NULL CONSTRAINT UQ_sites_name UNIQUE,
    project_code VARCHAR(10) NULL,      -- ERP 專案代碼；權限過濾用（見 docs/AUTH-PLAN.md §2.2）
                                        -- NULL＝尚未對映，該站不套用 ERP 權限（僅管理員可見）
    lock_date    DATE NULL,             -- 計價鎖定日（含）以前非管理員不可增修刪
    is_active    BIT NOT NULL CONSTRAINT DF_sites_active DEFAULT 1,  -- 專案退場=0
    sort_order   INT NOT NULL CONSTRAINT DF_sites_sort DEFAULT 0
);
CREATE INDEX IX_sites_project_code ON dbo.sites(project_code) WHERE project_code IS NOT NULL;

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
    id              VARCHAR(64) NOT NULL CONSTRAINT PK_labor PRIMARY KEY
                    CONSTRAINT CK_labor_id CHECK (id NOT LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2),  -- 合約 ^[A-Za-z0-9_-]{1,64}$
    site_id         INT NOT NULL CONSTRAINT FK_labor_site REFERENCES dbo.sites(site_id),
    work_date       DATE NOT NULL,
    vendor          NVARCHAR(200) NOT NULL,
    applicant       NVARCHAR(100) NOT NULL,
    required_units  DECIMAL(6,2) NOT NULL CONSTRAINT DF_labor_req DEFAULT 0,   -- 需求工數(可0.5)
    locations_json  NVARCHAR(MAX) NULL,   -- JSON 陣列，例 ["A區","B區"]
    categories_json NVARCHAR(MAX) NULL,   -- JSON 陣列（工作內容類別）
    category_note   NVARCHAR(MAX) NULL,   -- 前端無字數上限，勿設短欄位
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
    ot2_total        DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 加班·前2小時 總計(v11 分段計價；舊單 totalOT 歸此段)
    ot_over_total    DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 加班·第3小時起 總計
    total_ot         AS (ot2_total + ot_over_total) PERSISTED,  -- 合計＝計算欄位，杜絕三欄漂移
    diff             DECIMAL(6,2) NOT NULL DEFAULT 0,   -- actual - required
    zero_work        BIT NOT NULL DEFAULT 0,            -- 0工確認
    sign_return_date DATE NULL,                          -- 簽單繳回日
    vendor_done_work  DECIMAL(6,2) NULL,   -- 廠商代辦 工數（NULL=未填，與 0 區分）
    vendor_done_hours DECIMAL(6,2) NULL,   -- 廠商代辦 時數
    vendor_done_note  NVARCHAR(MAX) NULL,  -- 前端無字數上限
    self_done_work    DECIMAL(6,2) NULL,   -- 根基自辦（v12 起唯讀歷史；未填代辦=全數自辦）
    self_done_hours   DECIMAL(6,2) NULL,
    self_done_note    NVARCHAR(MAX) NULL,
    legacy_self_done   NVARCHAR(MAX) NULL, -- v10 前單一文字欄，僅舊資料
    legacy_vendor_done NVARCHAR(MAX) NULL,
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
    id              VARCHAR(64) NOT NULL CONSTRAINT PK_equip PRIMARY KEY
                    CONSTRAINT CK_equip_id CHECK (id NOT LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2),
    site_id         INT NOT NULL CONSTRAINT FK_equip_site REFERENCES dbo.sites(site_id),
    work_date       DATE NOT NULL,
    -- v22.6：申請階段不再填廠商（工地統一叫車後才配車），故放寬為可空。
    -- 實際廠商在 equip_reports.vendor；查詢請用 COALESCE(rep.vendor, rec.vendor)（見 vw 定義）
    vendor          NVARCHAR(200) NULL,           -- 機具廠商（僅 v22.6 前的舊單有值）
    applicant       NVARCHAR(100) NOT NULL,
    types_json      NVARCHAR(MAX) NULL,           -- 機具類型 JSON 陣列（可複選）
    model           NVARCHAR(200) NULL,           -- 型號
    required_qty    DECIMAL(8,2) NOT NULL DEFAULT 0,  -- 需求數量（台數）
    planned_hours   DECIMAL(8,2) NULL,            -- v22.6 預定使用時數（NULL=未填，差異不計算）
    apply_note      NVARCHAR(MAX) NULL,           -- v22.6 申請備註（包月等計價前提）
    contracted      NVARCHAR(2) NULL CONSTRAINT CK_equip_contracted CHECK (contracted IN (N'是', N'否')),  -- 合約廠商
    locations_json  NVARCHAR(MAX) NULL,
    content         NVARCHAR(MAX) NULL,           -- 工作內容（文字，前端無字數上限）
    status          NVARCHAR(10) NOT NULL CONSTRAINT CK_equip_status CHECK (status IN (N'待回報', N'已回報')),
    v               INT NOT NULL CONSTRAINT DF_equip_v DEFAULT 1,
    updated_at      DATETIME2(0) NOT NULL CONSTRAINT DF_equip_upd DEFAULT SYSDATETIME()
);
CREATE INDEX IX_equip_site_date ON dbo.equip_records(site_id, work_date);
-- v22.6 起新單的 vendor 在 equip_reports（見該表的 IX_equip_rep_vendor）；
-- 本索引僅對 v22.6 前的舊單有效，保留供歷史查詢
CREATE INDEX IX_equip_vendor    ON dbo.equip_records(site_id, vendor) WHERE vendor IS NOT NULL;

/* ---------- 7. 機具回報（子，1:1） ---------- */
CREATE TABLE dbo.equip_reports (
    record_id        VARCHAR(64) NOT NULL CONSTRAINT PK_equip_rep PRIMARY KEY
                     CONSTRAINT FK_equip_rep REFERENCES dbo.equip_records(id) ON DELETE CASCADE,
    reported_at      DATE NULL,
    checker          NVARCHAR(100) NULL,          -- 簽單責任工程師
    vendor           NVARCHAR(200) NULL,          -- v22.6 實際配到的機具廠商（計價分組依據）
    actual_hours     DECIMAL(8,2) NOT NULL DEFAULT 0,
    -- v22.6：diff = actual_hours - equip_records.planned_hours；
    -- planned_hours 為 NULL 的舊單無從比較，故 diff 亦放寬為可空
    diff             DECIMAL(8,2) NULL,
    days             DECIMAL(6,2) NOT NULL DEFAULT 0,  -- v22.6 出工天數（0.5／1／2…）
    ot_hours         DECIMAL(6,2) NOT NULL DEFAULT 0,  -- v22.6 加班時數（單一欄，機具不分段）
    work_content     NVARCHAR(MAX) NULL,               -- v22.6 實際工作內容
    -- v22.8 行情通報：只存「挑了哪一項」，金額不落庫（計價時依出工日回查當季，合約 §4.9）
    rate_item        NVARCHAR(400) NULL,               -- 主品項原文
    rate_ot_item     NVARCHAR(400) NULL,               -- 加班費率品項原文
    zero_use         BIT NOT NULL DEFAULT 0,
    sign_return_date DATE NULL,
    vendor_done_work  DECIMAL(6,2) NULL,
    vendor_done_hours DECIMAL(6,2) NULL,
    vendor_done_note  NVARCHAR(MAX) NULL,
    self_done_work    DECIMAL(6,2) NULL,
    self_done_hours   DECIMAL(6,2) NULL,
    self_done_note    NVARCHAR(MAX) NULL,
    legacy_self_done   NVARCHAR(MAX) NULL,
    legacy_vendor_done NVARCHAR(MAX) NULL
);
-- v22.6 起計價分組看的是這裡的 vendor（申請層僅舊單有值）
CREATE INDEX IX_equip_rep_vendor ON dbo.equip_reports(vendor) WHERE vendor IS NOT NULL;

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

/* ---------- 9. 成控現場稽核（v13；點工單 1:N） ----------
   對應合約 §4.5：一張申請單可多次稽核；逐項查核結果（items）以 JSON 過渡
   （元素 {text, ok, reason}），與多值欄位設計原則一致 */
CREATE TABLE dbo.labor_audits (
    audit_id        VARCHAR(64) NOT NULL CONSTRAINT PK_labor_audit PRIMARY KEY
                    CONSTRAINT CK_labor_audit_id CHECK (audit_id NOT LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2),
    record_id       VARCHAR(64) NOT NULL CONSTRAINT FK_labor_audit
                    REFERENCES dbo.labor_records(id) ON DELETE CASCADE,
    audited_at      DATE NOT NULL,
    auditor         NVARCHAR(100) NOT NULL,
    applied         DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 稽核當下申請工數快照
    actual_count    DECIMAL(6,2) NOT NULL DEFAULT 0,   -- 現場實點人數
    diff            DECIMAL(6,2) NOT NULL DEFAULT 0,   -- actual_count - applied
    items_json      NVARCHAR(MAX) NULL CONSTRAINT CK_labor_audit_items CHECK (items_json IS NULL OR ISJSON(items_json) = 1),
    note            NVARCHAR(MAX) NULL,                 -- 現場狀況說明（不限字數）
    status_at_audit NVARCHAR(10) NULL                   -- 稽核當下單據狀態快照
                    CONSTRAINT CK_labor_audit_status CHECK (status_at_audit IS NULL OR status_at_audit IN (N'待回報', N'已回報')),
    edited_at       DATE NULL                           -- 最近一次編輯日（未編輯過=NULL）
);
CREATE INDEX IX_labor_audit_record ON dbo.labor_audits(record_id);
CREATE INDEX IX_labor_audit_date   ON dbo.labor_audits(audited_at);

/* ---------- 10. 成控現場稽核（機具單 1:N；結構同上） ---------- */
CREATE TABLE dbo.equip_audits (
    audit_id        VARCHAR(64) NOT NULL CONSTRAINT PK_equip_audit PRIMARY KEY
                    CONSTRAINT CK_equip_audit_id CHECK (audit_id NOT LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2),
    record_id       VARCHAR(64) NOT NULL CONSTRAINT FK_equip_audit
                    REFERENCES dbo.equip_records(id) ON DELETE CASCADE,
    audited_at      DATE NOT NULL,
    auditor         NVARCHAR(100) NOT NULL,
    applied         DECIMAL(8,2) NOT NULL DEFAULT 0,   -- 稽核當下申請台數快照（對齊來源 required_qty 的 8,2 精度）
    actual_count    DECIMAL(8,2) NOT NULL DEFAULT 0,   -- 現場實點台數
    diff            DECIMAL(8,2) NOT NULL DEFAULT 0,
    items_json      NVARCHAR(MAX) NULL CONSTRAINT CK_equip_audit_items CHECK (items_json IS NULL OR ISJSON(items_json) = 1),
    note            NVARCHAR(MAX) NULL,
    status_at_audit NVARCHAR(10) NULL
                    CONSTRAINT CK_equip_audit_status CHECK (status_at_audit IS NULL OR status_at_audit IN (N'待回報', N'已回報')),
    edited_at       DATE NULL
);
CREATE INDEX IX_equip_audit_record ON dbo.equip_audits(record_id);
CREATE INDEX IX_equip_audit_date   ON dbo.equip_audits(audited_at);
GO

/* ---------- 11. 附件描述資料（v14；申請單簽單掃描檔／稽核現場照片） ----------
   對應合約 §4.6：檔案本體「不」入 DB——雲端存 Blobs、地端建議存檔案系統，
   file_path 記錄檔案本體的位置，**相對於附件根目錄**（環境變數 ATTACH_DIR）而非絕對路徑
   ——附件目錄搬家時只要改環境變數，不必回頭改幾百列路徑。
   遷移匯入時為 NULL，切換日附件搬運腳本補填。
   parent 橫跨四種對象故不設 FK（以索引＋應用層維護參照）。 */
CREATE TABLE dbo.attachments (
    attachment_id   VARCHAR(64) NOT NULL CONSTRAINT PK_attachments PRIMARY KEY
                    CONSTRAINT CK_att_id CHECK (attachment_id NOT LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2),
    site_id         INT NOT NULL CONSTRAINT FK_att_site REFERENCES dbo.sites(site_id),
    parent_kind     VARCHAR(12) NOT NULL CONSTRAINT CK_att_parent
                    CHECK (parent_kind IN ('labor','equipment','labor_audit','equip_audit')),
    parent_id       VARCHAR(64) NOT NULL,   -- labor/equipment=單據 id；*_audit=稽核紀錄 audit_id
    name            NVARCHAR(200) NOT NULL,
    content_type    VARCHAR(50) NOT NULL,   -- 合約 §3.6 白名單（image/jpeg|png|webp、application/pdf）
    size_bytes      INT NOT NULL CONSTRAINT DF_att_size DEFAULT 0,
    uploaded_at     DATE NULL,
    file_path       NVARCHAR(400) NULL
);
CREATE INDEX IX_att_parent ON dbo.attachments(parent_kind, parent_id);
GO

/* ---------- 12～14. 行情通報費率（v22.8；合約 §2.4／§3.9／§4.8／§4.9） ----------
   公司按季發布租工／機具行情通報 xlsx，管理員自行匯入，計價時依**出工日期**
   取「生效日 ≤ 出工日」中最新的一季。單據不存金額，只存「挑了哪一項」——
   換季重匯不會改到歷史單據，行情通報事後修正則會自動反映。

   ⚠ **費率書不在備份 JSON 裡**（雲端是獨立的 blob，不進 scope=all）。
   切換日必須比照附件另行搬運：`GET ?rates=1` 匯出 → 匯入下列兩張表。
   見 MIGRATION-PLAN.md 切換流程。 */
CREATE TABLE dbo.rate_books (
    rate_book_id   INT IDENTITY(1,1) CONSTRAINT PK_rate_books PRIMARY KEY,
    kind           VARCHAR(10) NOT NULL CONSTRAINT CK_rate_kind CHECK (kind IN ('labor','equipment')),
    label          NVARCHAR(40) NOT NULL,          -- 季別標示，例 115Q3（僅供顯示）
    effective_from DATE NOT NULL,                  -- 生效日；同時是季別唯一鍵
    imported_at    DATE NOT NULL,
    CONSTRAINT UQ_rate_books UNIQUE (kind, effective_from)   -- 同生效日重匯＝取代
);

CREATE TABLE dbo.rate_book_rows (
    rate_row_id  INT IDENTITY(1,1) CONSTRAINT PK_rate_rows PRIMARY KEY,
    rate_book_id INT NOT NULL CONSTRAINT FK_rate_rows
                 REFERENCES dbo.rate_books(rate_book_id) ON DELETE CASCADE,
    vendor_code  VARCHAR(40) NOT NULL,     -- 供應商編號＝綁定用的穩定鍵（公司全名會改寫，編號不會）
    vendor_name  NVARCHAR(200) NOT NULL,
    region       NVARCHAR(20) NULL,        -- 北區／中區／南區／全省
    note         NVARCHAR(400) NULL,       -- 說明欄，例「打石工-一般工地」；租工綁定的關鍵
    item         NVARCHAR(400) NOT NULL,   -- 品項原文
    unit         NVARCHAR(10) NULL,        -- 工／天／HR／月／趟
    price        DECIMAL(12,2) NOT NULL,   -- 匯入時已濾掉 <= 0 的列（0 會被讀成「免費」）
    -- 租工專有（自品項文字解析；對應合約 §4.3 的前2h／第3h起分段）
    work         DECIMAL(10,2) NULL,
    ot2          DECIMAL(10,2) NULL,
    ot_over      DECIMAL(10,2) NULL,
    ot_parsed    BIT NULL,                 -- 品項是否真的載明加班費率；
                                           -- false 時 ot2/ot_over 的 0 代表「沒寫」而非「免費」
    -- 機具專有
    charge_type  NVARCHAR(10) NULL         -- 全天／半天／時租／加班／月租／趟次
);
CREATE INDEX IX_rate_rows_book   ON dbo.rate_book_rows(rate_book_id);
CREATE INDEX IX_rate_rows_vendor ON dbo.rate_book_rows(rate_book_id, vendor_code);

/* 各工地的費率綁定（合約 §4.8）：
   labor  → bind_key = "<系統廠商>|<工種>"，綁到 (vendor_code, note)
   equip  → bind_key = "<系統廠商>"，只綁 vendor_code（品項由工程師回報時挑） */
CREATE TABLE dbo.site_rate_bindings (
    site_id     INT NOT NULL CONSTRAINT FK_bind_site REFERENCES dbo.sites(site_id),
    kind        VARCHAR(10) NOT NULL CONSTRAINT CK_bind_kind CHECK (kind IN ('labor','equipment')),
    bind_key    NVARCHAR(400) NOT NULL,
    vendor_code VARCHAR(40) NOT NULL,
    note        NVARCHAR(400) NULL,        -- 僅 labor 使用
    CONSTRAINT PK_site_rate_bindings PRIMARY KEY (site_id, kind, bind_key)
);
GO

/* ---------- 15～16. 代辦逐筆（v23；合約 §4.10） ----------
   代辦＝向**本單廠商**叫的工／機具，但成本歸屬另一家廠商，計價時從該廠商扣回。
   v22 以前只有回報上的「代辦工數／時數／備註」三欄，責任歸屬廠商寫在自由文字
   備註裡（例「○○公司扣 2 工，扣款 4200」）——無法自動統計代付代扣。
   舊三欄仍保留在 labor_reports／equip_reports（既有資料承繼），**新舊不相加**。

   ⚠ 金額不落庫，與 §4.9 計價一致：依出工日回查當季費率算。費率會換季，
     金額要能回算；存死了就再也對不回去。
   ⚠ 費率取「本單廠商」的，不是這裡的 vendor——vendor 只是歸屬對象。 */
CREATE TABLE dbo.labor_agent_items (
    agent_row_id INT IDENTITY(1,1) CONSTRAINT PK_labor_agent PRIMARY KEY,
    record_id    VARCHAR(64) NOT NULL CONSTRAINT FK_labor_agent
                 REFERENCES dbo.labor_reports(record_id) ON DELETE CASCADE,
    vendor       NVARCHAR(200) NOT NULL,           -- 責任歸屬廠商
    work_type    NVARCHAR(100) NOT NULL,           -- 必須是本單 workTypes 出現過的工種
    work         DECIMAL(6,2) NOT NULL CONSTRAINT DF_lagent_work DEFAULT 0,
    ot2          DECIMAL(6,2) NOT NULL CONSTRAINT DF_lagent_ot2  DEFAULT 0,
    ot_over      DECIMAL(6,2) NOT NULL CONSTRAINT DF_lagent_oto  DEFAULT 0,
    note         NVARCHAR(MAX) NULL
);
CREATE INDEX IX_labor_agent_vendor ON dbo.labor_agent_items(vendor);

CREATE TABLE dbo.equip_agent_items (
    agent_row_id INT IDENTITY(1,1) CONSTRAINT PK_equip_agent PRIMARY KEY,
    record_id    VARCHAR(64) NOT NULL CONSTRAINT FK_equip_agent
                 REFERENCES dbo.equip_reports(record_id) ON DELETE CASCADE,
    vendor       NVARCHAR(200) NOT NULL,
    -- 數量。**單位由主計價品項的 charge_type 決定**（全天→天、時租→小時），與 §4.9 同源
    qty          DECIMAL(8,2) NOT NULL CONSTRAINT DF_eagent_qty DEFAULT 0,
    note         NVARCHAR(MAX) NULL
);
CREATE INDEX IX_equip_agent_vendor ON dbo.equip_agent_items(vendor);
GO

/* ---------- 17. 全域設定（v23.2；合約 §4.1 master.adminDepartments） ----------
   目前只放「管理員部門白名單」——讓成控自己在系統後台增減管理員部門，
   不必每次請資訊處改 appsettings 並重啟服務。

   做成通用鍵值表而不是專用欄位，是因為日後還會有別的全域設定（例如角色白名單），
   每次加一張表並不划算。

   ⚠ 值一律存 **JSON 字串**（與合約的陣列形狀一致），不可用逗號分隔——
     部門名稱本身可能含逗號或全形標點，切字串會切錯。
   ⚠ 這張表為空時，權限模組回退到 appsettings 的 Auth:AdminDepartments。
     這是刻意的保險：避免有人在後台清空後把所有管理者一起鎖在門外。 */
CREATE TABLE dbo.app_settings (
    setting_key VARCHAR(64) NOT NULL CONSTRAINT PK_app_settings PRIMARY KEY,
    value_json  NVARCHAR(MAX) NULL,
    updated_at  DATETIME2(0) NOT NULL CONSTRAINT DF_app_settings_upd DEFAULT SYSDATETIME()
);
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
    SUM(ISNULL(rep.self_done_hours, 0))   AS self_done_hours,
    /* 工作內容彙集（對應前端計價彙總最後一欄；聚合該廠商所有已回報單的類別，去重） */
    (SELECT STRING_AGG(d.val, N'、')
       FROM (SELECT DISTINCT j.value AS val
               FROM dbo.labor_records r2
               CROSS APPLY OPENJSON(r2.categories_json) j
              WHERE r2.site_id = r.site_id AND r2.vendor = r.vendor
                AND r2.status = N'已回報') d) AS categories
FROM dbo.labor_records r
JOIN dbo.sites s ON s.site_id = r.site_id
JOIN dbo.labor_reports rep ON rep.record_id = r.id
WHERE r.status = N'已回報'
GROUP BY s.name, r.site_id, r.vendor;
GO

/* 機具歷程明細
   ⚠ v22.6：廠商一律取 COALESCE(rep.vendor, r.vendor)——工地統一叫車後才配車，
   廠商改於回報時填；舊單的值仍在申請層。**勿直接讀 r.vendor**，會漏掉全部新單。 */
CREATE VIEW dbo.v_equip_detail AS
SELECT
    s.name AS site,
    r.work_date,
    COALESCE(rep.vendor, r.vendor) AS vendor,        -- 有效廠商（合約 §4.4）
    r.types_json, r.model, r.required_qty, r.planned_hours, r.apply_note, r.contracted,
    r.applicant, r.status, r.content, r.locations_json,
    rep.sign_return_date, rep.actual_hours, rep.diff,
    rep.days, rep.ot_hours, rep.work_content,
    rep.zero_use, rep.checker,
    rep.vendor_done_work, rep.vendor_done_hours, rep.vendor_done_note,
    rep.self_done_work, rep.self_done_hours, rep.self_done_note,
    r.id AS record_id, r.v, r.updated_at
FROM dbo.equip_records r
JOIN dbo.sites s ON s.site_id = r.site_id
LEFT JOIN dbo.equip_reports rep ON rep.record_id = r.id;
GO

/* 機具計價彙總
   v22.6：機具計價的組成是「出工天數＋加班時數」，兩者各出一欄；
   實際使用時數保留供對帳。分組鍵同樣是有效廠商。 */
CREATE VIEW dbo.v_equip_pricing_summary AS
WITH e AS (
    SELECT r.site_id, r.id, r.types_json, r.status,
           COALESCE(rep.vendor, r.vendor) AS vendor,
           rep.zero_use, rep.actual_hours, rep.days, rep.ot_hours,
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

/* 成控現場稽核清單（v13；點工＋機具合併平面化，= 前端「稽核紀錄」清單） */
CREATE VIEW dbo.v_audit_log AS
SELECT
    N'點工' AS kind, s.name AS site, a.audited_at, a.auditor,
    r.work_date, r.vendor, a.applied, a.actual_count, a.diff,
    /* ISNULL：元素缺 ok 鍵或值為 null 時 OPENJSON 回 SQL NULL，NULL=0 為 UNKNOWN
       會被 WHERE 排除而低估不符數——形狀異常的資料寧可計入不符也不可誤報全數相符 */
    (SELECT COUNT(*) FROM OPENJSON(a.items_json)
      WITH (ok BIT '$.ok') j WHERE ISNULL(j.ok, 0) = 0)  AS mismatch_count,
    a.items_json, a.note, a.status_at_audit, a.edited_at,
    a.audit_id, a.record_id
FROM dbo.labor_audits a
JOIN dbo.labor_records r ON r.id = a.record_id
JOIN dbo.sites s ON s.site_id = r.site_id
UNION ALL
SELECT
    N'機具', s.name, a.audited_at, a.auditor,
    r.work_date, r.vendor, a.applied, a.actual_count, a.diff,
    (SELECT COUNT(*) FROM OPENJSON(a.items_json)
      WITH (ok BIT '$.ok') j WHERE ISNULL(j.ok, 0) = 0),
    a.items_json, a.note, a.status_at_audit, a.edited_at,
    a.audit_id, a.record_id
FROM dbo.equip_audits a
JOIN dbo.equip_records r ON r.id = a.record_id
JOIN dbo.sites s ON s.site_id = r.site_id;
GO
