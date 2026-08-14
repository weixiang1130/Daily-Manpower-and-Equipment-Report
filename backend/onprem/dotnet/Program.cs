/* ==========================================================================
   點工機具稽核系統 — 地端 API（.NET 8 Minimal API）

   這是 docs/API-CONTRACT.md 的地端實作。前端（frontend/）完全不需修改，
   只要把 config.local.js 的 apiBase 指向本服務即可。

   ⚠ 合約是唯一權威：任何回應形狀的疑義以 docs/API-CONTRACT.md 為準，
     不可依這裡的實作反推。另有兩份可對照的實作：
       backend/cloud/functions/api.mjs（雲端現行版）
       backend/onprem/server.mjs（Node 參考版）

   目前進度：**階段 A＋B＋C＋D** —— 合約全部端點皆已實作，權限機制亦已內建
     ✅ GET ?scope=all / ?site= / ?attachment= / ?rates=1          合約 §2.1～§2.4
     ✅ op:record（含 409 樂觀並發）                              合約 §3.3
     ✅ op:master / op:config / op:addOption / op:deleteRecord     合約 §3.1/§3.2/§3.4/§3.5
     ✅ op:uploadAttachment / op:deleteAttachment                 合約 §3.6/§3.7
     ✅ op:rateBook / op:deleteRateBook / op:clearSite / clearAll  合約 §3.9/§3.10/§3.8
     ✅ 階段 D：身分與權限過濾（見 Auth.cs 與 docs/AUTH-PLAN.md）
        —— **預設關閉**（Auth:Mode=Off），不設定就維持現行行為

   若日後有尚未實作的分支，一律回 501，**不可默默回 200**——前端的 await-first
   紀律會把 200 當成寫入成功而清掉表單，資料就真的不見了。

   環境變數：KGAUDIT_CONNECTION（連線字串）、KGAUDIT_ERP_CONNECTION（ERP 權限檢視表）、
             ATTACH_DIR（附件根目錄）、STATIC_DIR（前端靜態根）、
             SITE_AUTH_USER/PASS（Basic Auth）、Auth__Mode（Off／Windows／Dev）
   ========================================================================== */
using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Server.HttpSys;
using System.Text.Json;
using System.Text.Json.Nodes;
using KgAudit.Api;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);

/* ---------- Windows 整合驗證的主機層（v23.4；opt-in） ----------
   身分一律由**主機層**提供，本程式只讀已驗證的 HttpContext.User
   （刻意不引 Microsoft.AspNetCore.Authentication.Negotiate，見 .csproj 註解）。
   主機有兩條路：
     • **IIS 託管**：不需要這段程式碼——在 IIS 啟用 Windows 驗證、停用匿名即可
     • **Windows 服務／自主控管**：需要 HTTP.sys 提供 Negotiate/NTLM ← 這段

   ⚠ 先前 DEPLOYMENT §4.5 就是這樣寫給資訊處的，但程式沒有這個設定點，
     照文件做會找不到地方設。**預設關閉**，不設環境變數則行為完全不變。
   ⚠ HttpSys 僅 Windows 可用；非 Windows 設了也會略過，不讓服務起不來。 */
if (OperatingSystem.IsWindows()
    && Environment.GetEnvironmentVariable("KGAUDIT_HTTPSYS") == "1")
{
    builder.WebHost.UseHttpSys(o =>
    {
        o.Authentication.Schemes = AuthenticationSchemes.Negotiate | AuthenticationSchemes.NTLM;
        /* **必須停用匿名**：只開驗證卻仍允許匿名，未登入者會以匿名身分進來、
           Identity.Name 為空字串，本系統一律回 401——功能不會壞，但使用者
           看到的是「無法辨識您的網域帳號」而不是瀏覽器的登入提示。 */
        o.Authentication.AllowAnonymous = false;
    });
}

/* Results.Json(...) 走的是框架的序列化設定（本檔有 50 多處），
   一併改成不逃脫非 ASCII——理由與 Wr.JsonOpts 相同：
   錯誤訊息是中文，逃脫後既難讀、又與雲端 api.mjs 的輸出格式不一致。 */
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping);

/* ---------- 權限設定（階段 D，見 Auth.cs 與 docs/AUTH-PLAN.md） ----------
   預設 Mode=Off：**不設定就完全維持現行行為**，部署新版不會突然把人擋在外面。 */
var authOpt = builder.Configuration.GetSection("Auth").Get<AuthOptions>() ?? new AuthOptions();

var app = builder.Build();

/* ---------- 靜態前端 ----------
   與 server.mjs 同樣的部署形態：同一個服務同時供應前端與 API，
   前端因此是同源呼叫，不需要 CORS。
   ⚠ 靜態根必須是 frontend/，**不可指向 repo 根或 backend/**
     ——那會把後端原始碼與 SQL DDL 一併對外提供下載。 */
var staticRoot = Environment.GetEnvironmentVariable("STATIC_DIR")
    // bin/Debug/net8.0 → dotnet → onprem → backend → repo 根（六層），再進 frontend
    ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "frontend"));

string ConnStr() =>
    Environment.GetEnvironmentVariable("KGAUDIT_CONNECTION")
    ?? app.Configuration.GetConnectionString("KgAudit")
    ?? throw new InvalidOperationException(
        "未設定連線字串：請設環境變數 KGAUDIT_CONNECTION 或 appsettings 的 ConnectionStrings:KgAudit");

/* ---------- 統一的例外出口（必須掛在最前面才攔得到後面全部中介層） ----------
   沒有這一層時：Production 回一個空白 500，維運從回應完全查不到原因；
   Development 則會把完整堆疊與 SQL 陳述式直接回給瀏覽器——整站 Basic Auth
   之後的任何使用者都看得到。這裡一律寫伺服器端日誌、只回固定形狀的 JSON。 */
app.UseExceptionHandler(b => b.Run(async ctx =>
{
    var ex = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
    app.Logger.LogError(ex, "未處理的例外：{Method} {Path}", ctx.Request.Method, ctx.Request.Path);
    ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
    ctx.Response.ContentType = "application/json; charset=utf-8";
    await ctx.Response.WriteAsync(new JsonObject { ["error"] = "server error" }.ToJsonString(Wr.JsonOpts));
}));

/* ---------- Basic Auth（與 auth.ts／api.mjs 同一邏輯） ----------
   未設定密碼＝不啟用（僅限本機開發；正式環境務必設定）。 */
app.Use(async (ctx, next) =>
{
    var user = Environment.GetEnvironmentVariable("SITE_AUTH_USER") ?? "kg";
    var pass = Environment.GetEnvironmentVariable("SITE_AUTH_PASS") ?? "";
    if (pass.Length == 0) { await next(); return; }

    var expected = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{user}:{pass}"));
    if (ctx.Request.Headers.Authorization.ToString() != expected)
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        ctx.Response.Headers.WWWAuthenticate = "Basic realm=\"KG Manpower\"";
        await ctx.Response.WriteAsync("Unauthorized");
        return;
    }
    await next();
});

/* ---------- 小工具 ---------- */

// 資料庫存的是 JSON 陣列字串，必須**原樣嵌回 JSON**而不是變成字串值。
// 空陣列要保留為 []：合約 §4.3 型別是 string[]，塌成 null 會讓前端 .map 爆炸。
static JsonNode JsonArrayOf(object? raw)
{
    if (raw is null or DBNull) return new JsonArray();
    try { return JsonNode.Parse((string)raw) as JsonArray ?? new JsonArray(); }
    catch { return new JsonArray(); }
}

static JsonNode? Num(object? v) => v is null or DBNull ? null : JsonValue.Create((decimal)v);
static string? Str(object? v) => v is null or DBNull ? null : (string)v;
static bool Bit(object? v) => v is not (null or DBNull) && (bool)v;

/* 日期一律輸出本地日期字串（合約：YYYY-MM-DD）。**不可經 UTC 轉換**——
   UTC 會把台灣早上記成前一天，直接改變計價月份歸屬（計價紅線 2）。

   ⚠ 格式化一律指定 InvariantCulture。`yyyy` 取的是 CurrentCulture 的行事曆年份，
     而 Windows 區域設定可以把 zh-TW 的行事曆改成「中華民國曆」——那樣
     2026-08-12 會輸出成 0115-08-12，整批日期靜默錯誤且不會拋任何例外。 */
static string? DateStr(object? v) =>
    v is null or DBNull ? null : ((DateTime)v).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

// updatedAt：帶時區位移的 ISO 8601。資料庫存的是本地時間，若當成 UTC 輸出會整整差 8 小時。
static string? StampStr(object? v) => v is null or DBNull
    ? null
    : new DateTimeOffset((DateTime)v, TimeZoneInfo.Local.GetUtcOffset((DateTime)v))
        .ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);

static async Task<List<Dictionary<string, object?>>> Query(SqlConnection cn, string sql, params (string, object?)[] ps)
    => await QueryTx(cn, null, sql, ps);

/* 交易內的讀取要走同一個交易，否則會被自己持有的 UPDLOCK 擋住而逾時。
   （區域函式不能多載，所以另取名字而不是寫成 Query 的第二個版本。） */
static async Task<List<Dictionary<string, object?>>> QueryTx(SqlConnection cn, SqlTransaction? tx, string sql, params (string, object?)[] ps)
{
    var rows = new List<Dictionary<string, object?>>();
    await using var cmd = new SqlCommand(sql, cn, tx);
    foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
    await using var rd = await cmd.ExecuteReaderAsync();
    while (await rd.ReadAsync())
    {
        var row = new Dictionary<string, object?>(rd.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < rd.FieldCount; i++) row[rd.GetName(i)] = rd.IsDBNull(i) ? null : rd.GetValue(i);
        rows.Add(row);
    }
    return rows;
}

/* ---------- 由扁平資料表重組成合約的巢狀 JSON ---------- */

// 自辦/代辦六欄＋舊制兩欄（labor/equip 共用，杜絕複本漂移）
static void AddDoneCols(JsonObject rep, Dictionary<string, object?> r)
{
    rep["selfDoneWork"] = Num(r["self_done_work"]);
    rep["selfDoneHours"] = Num(r["self_done_hours"]);
    rep["selfDoneNote"] = Str(r["self_done_note"]) ?? "";
    rep["vendorDoneWork"] = Num(r["vendor_done_work"]);
    rep["vendorDoneHours"] = Num(r["vendor_done_hours"]);
    rep["vendorDoneNote"] = Str(r["vendor_done_note"]) ?? "";
    rep["selfDone"] = Str(r["legacy_self_done"]) ?? "";
    rep["vendorDone"] = Str(r["legacy_vendor_done"]) ?? "";
}

static JsonArray BuildAttachments(List<Dictionary<string, object?>> atts) =>
    new(atts.Select(a => (JsonNode)new JsonObject
    {
        ["id"] = Str(a["attachment_id"]),
        ["name"] = Str(a["name"]),
        ["type"] = Str(a["content_type"]),
        ["size"] = JsonValue.Create(Convert.ToInt32(a["size_bytes"] ?? 0)),
        ["uploadedAt"] = DateStr(a["uploaded_at"])
    }).ToArray());

static JsonArray BuildAudits(List<Dictionary<string, object?>> auds,
                             ILookup<string, Dictionary<string, object?>> attsByParent)
{
    var arr = new JsonArray();
    foreach (var a in auds)
    {
        var id = (string)a["audit_id"]!;
        var o = new JsonObject
        {
            ["id"] = id,
            ["auditedAt"] = DateStr(a["audited_at"]),
            ["auditor"] = Str(a["auditor"]),
            ["applied"] = Num(a["applied"]),
            ["actualCount"] = Num(a["actual_count"]),
            ["diff"] = Num(a["diff"]),
            ["items"] = JsonArrayOf(a["items_json"]),
            ["note"] = Str(a["note"]) ?? "",
            ["statusAtAudit"] = Str(a["status_at_audit"]),
            ["attachments"] = BuildAttachments(attsByParent[id].ToList())
        };
        // editedAt 只有編輯過的紀錄才有這個鍵——沒編輯過就不該出現（合約 §4.5）
        var edited = DateStr(a["edited_at"]);
        if (edited is not null) o["editedAt"] = edited;
        arr.Add(o);
    }
    return arr;
}

/* 稽核紀錄只給成控與管理者。
   v13 的「成控現場稽核」對工地端是**前端隱藏**，資料照樣傳到瀏覽器；
   這裡把它降級為真隔離——工地使用者的回應裡根本沒有 audits 內容。
   仍保留空陣列而不是刪掉鍵：合約 §4.5 的型別是陣列，塌成 null 會讓前端 .map 爆炸。 */
static void StripAudits(JsonNode? store, Authz? az)
{
    if (az is null || az.CanSeeAudits || store is null) return;
    foreach (var kind in new[] { "labor", "equipment" })
        foreach (var r in (store[kind] as JsonArray) ?? new JsonArray())
            if (r is JsonObject o && o.ContainsKey("audits")) o["audits"] = new JsonArray();
}

/* ---------- 讀取整站資料 ---------- */
static async Task<JsonObject> ReadStores(SqlConnection cn, string? onlySite)
{
    var siteFilter = onlySite is null ? "" : " WHERE s.name = @site";
    var p = onlySite is null ? Array.Empty<(string, object?)>() : new (string, object?)[] { ("@site", onlySite) };

    var sites = await Query(cn,
        $"SELECT s.site_id, s.name, s.lock_date, s.sort_order, s.is_active FROM dbo.sites s{siteFilter} ORDER BY s.sort_order", p);
    var idToName = sites.ToDictionary(s => Convert.ToInt32(s["site_id"]), s => (string)s["name"]!);

    var opts = await Query(cn,
        $"SELECT o.site_id, o.pool, o.value FROM dbo.site_options o JOIN dbo.sites s ON s.site_id=o.site_id{siteFilter} ORDER BY o.option_id", p);
    var binds = await Query(cn,
        $"SELECT b.site_id, b.kind, b.bind_key, b.vendor_code, b.note FROM dbo.site_rate_bindings b JOIN dbo.sites s ON s.site_id=b.site_id{siteFilter}", p);

    var lab = await Query(cn, $"SELECT r.* FROM dbo.labor_records r JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var labRep = await Query(cn, $"SELECT rp.* FROM dbo.labor_reports rp JOIN dbo.labor_records r ON r.id=rp.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var labWt = await Query(cn, $"SELECT w.* FROM dbo.labor_report_worktypes w JOIN dbo.labor_records r ON r.id=w.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY w.worktype_row_id", p);
    var labAud = await Query(cn, $"SELECT a.* FROM dbo.labor_audits a JOIN dbo.labor_records r ON r.id=a.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY a.audited_at", p);
    // v23 代辦逐筆（合約 §4.10）
    var labAgent = await Query(cn, $"SELECT g.* FROM dbo.labor_agent_items g JOIN dbo.labor_records r ON r.id=g.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY g.agent_row_id", p);

    var eq = await Query(cn, $"SELECT r.* FROM dbo.equip_records r JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var eqRep = await Query(cn, $"SELECT rp.* FROM dbo.equip_reports rp JOIN dbo.equip_records r ON r.id=rp.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var eqUse = await Query(cn, $"SELECT u.* FROM dbo.equip_report_usage u JOIN dbo.equip_records r ON r.id=u.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY u.usage_row_id", p);
    var eqAud = await Query(cn, $"SELECT a.* FROM dbo.equip_audits a JOIN dbo.equip_records r ON r.id=a.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY a.audited_at", p);
    var eqAgent = await Query(cn, $"SELECT g.* FROM dbo.equip_agent_items g JOIN dbo.equip_records r ON r.id=g.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY g.agent_row_id", p);

    var atts = await Query(cn, $"SELECT a.* FROM dbo.attachments a JOIN dbo.sites s ON s.site_id=a.site_id{siteFilter}", p);
    var attsByParent = atts.ToLookup(a => (string)a["parent_id"]!);

    var repById = labRep.ToDictionary(r => (string)r["record_id"]!);
    var wtBy = labWt.ToLookup(w => (string)w["record_id"]!);
    var labAudBy = labAud.ToLookup(a => (string)a["record_id"]!);
    var labAgentBy = labAgent.ToLookup(g => (string)g["record_id"]!);
    var eqRepById = eqRep.ToDictionary(r => (string)r["record_id"]!);
    var useBy = eqUse.ToLookup(u => (string)u["record_id"]!);
    var eqAudBy = eqAud.ToLookup(a => (string)a["record_id"]!);
    var eqAgentBy = eqAgent.ToLookup(g => (string)g["record_id"]!);

    var stores = new JsonObject();
    foreach (var s in sites)
    {
        var sid = Convert.ToInt32(s["site_id"]);
        var name = (string)s["name"]!;

        var cfg = new JsonObject();
        foreach (var pool in new[] { "vendors", "locations", "categories", "equipTypes", "people", "workers", "laborTypes" })
            cfg[pool] = new JsonArray(opts.Where(o => Convert.ToInt32(o["site_id"]) == sid && (string)o["pool"]! == pool)
                                          .Select(o => (JsonNode)JsonValue.Create((string)o["value"]!)!).ToArray());
        cfg["lockDate"] = DateStr(s["lock_date"]) ?? "";

        // v22.8 費率綁定（合約 §4.8）
        var bl = new JsonObject();
        var be = new JsonObject();
        foreach (var b in binds.Where(b => Convert.ToInt32(b["site_id"]) == sid))
        {
            var key = (string)b["bind_key"]!;
            if ((string)b["kind"]! == "labor")
                bl[key] = new JsonObject { ["vendorCode"] = Str(b["vendor_code"]), ["note"] = Str(b["note"]) ?? "" };
            else
                be[key] = Str(b["vendor_code"]);
        }
        if (bl.Count > 0 || be.Count > 0)
            cfg["rateBindings"] = new JsonObject { ["labor"] = bl, ["equipment"] = be };

        var laborArr = new JsonArray();
        foreach (var r in lab.Where(r => Convert.ToInt32(r["site_id"]) == sid))
        {
            var id = (string)r["id"]!;
            JsonNode? report = null;
            if (repById.TryGetValue(id, out var rp))
            {
                var o = new JsonObject
                {
                    ["reportedAt"] = DateStr(rp["reported_at"]),
                    ["engineer"] = Str(rp["engineer"]) ?? "",
                    ["checkFace"] = Bit(rp["check_face"]),
                    ["checkCard"] = Bit(rp["check_card"]),
                    ["checkToolbox"] = Bit(rp["check_toolbox"]),
                    ["workTypes"] = new JsonArray(wtBy[id].Select(w => (JsonNode)new JsonObject
                    {
                        ["type"] = Str(w["work_type"]),
                        ["work"] = Num(w["work"]),
                        ["ot2"] = Num(w["ot2"]),
                        ["otOver"] = Num(w["ot_over"])
                    }).ToArray()),
                    ["attendance"] = JsonArrayOf(rp["legacy_attendance_json"]),
                    ["actual"] = Num(rp["actual"]),
                    ["ot2Total"] = Num(rp["ot2_total"]),
                    ["otOverTotal"] = Num(rp["ot_over_total"]),
                    ["totalOT"] = Num(rp["total_ot"]),
                    ["diff"] = Num(rp["diff"]),
                    ["zeroWork"] = Bit(rp["zero_work"]),
                    ["signReturnDate"] = DateStr(rp["sign_return_date"]) ?? "",
                    ["conclusion"] = Str(rp["conclusion"]) ?? "",
                    // v23 代辦逐筆（合約 §4.10）
                    ["agentItems"] = new JsonArray(labAgentBy[id].Select(g => (JsonNode)new JsonObject
                    {
                        ["vendor"] = Str(g["vendor"]),
                        ["type"] = Str(g["work_type"]),
                        ["work"] = Num(g["work"]),
                        ["ot2"] = Num(g["ot2"]),
                        ["otOver"] = Num(g["ot_over"]),
                        ["note"] = Str(g["note"]) ?? ""
                    }).ToArray())
                };
                AddDoneCols(o, rp);
                report = o;
            }
            laborArr.Add(new JsonObject
            {
                ["id"] = id,
                ["date"] = DateStr(r["work_date"]),
                ["vendor"] = Str(r["vendor"]) ?? "",
                ["applicant"] = Str(r["applicant"]) ?? "",
                ["required"] = Num(r["required_units"]),
                ["workers"] = JsonArrayOf(r["workers_json"]),
                ["locations"] = JsonArrayOf(r["locations_json"]),
                ["categories"] = JsonArrayOf(r["categories_json"]),
                ["categoryNote"] = Str(r["category_note"]) ?? "",
                ["status"] = Str(r["status"]),
                ["report"] = report,
                ["audits"] = BuildAudits(labAudBy[id].ToList(), attsByParent),
                ["attachments"] = BuildAttachments(attsByParent[id].Where(a => (string)a["parent_kind"]! == "labor").ToList()),
                ["v"] = JsonValue.Create(Convert.ToInt32(r["v"])),
                ["updatedAt"] = StampStr(r["updated_at"])
            });
        }

        var equipArr = new JsonArray();
        foreach (var r in eq.Where(r => Convert.ToInt32(r["site_id"]) == sid))
        {
            var id = (string)r["id"]!;
            JsonNode? report = null;
            if (eqRepById.TryGetValue(id, out var rp))
            {
                var o = new JsonObject
                {
                    ["reportedAt"] = DateStr(rp["reported_at"]),
                    ["checker"] = Str(rp["checker"]) ?? "",
                    ["vendor"] = Str(rp["vendor"]) ?? "",          // v22.6 回報廠商
                    ["usage"] = new JsonArray(useBy[id].Select(u => (JsonNode)new JsonObject
                    {
                        ["type"] = Str(u["equip_type"]),
                        ["present"] = Bit(u["present"]),
                        ["hours"] = Num(u["hours"])
                    }).ToArray()),
                    ["actualHours"] = Num(rp["actual_hours"]),
                    ["diff"] = Num(rp["diff"]),                    // v22.6 可為 null（申請未填預定時數）
                    ["days"] = Num(rp["days"]),
                    ["otHours"] = Num(rp["ot_hours"]),
                    ["workContent"] = Str(rp["work_content"]) ?? "",
                    ["rateItem"] = Str(rp["rate_item"]) ?? "",     // v22.8
                    ["rateOtItem"] = Str(rp["rate_ot_item"]) ?? "",
                    ["zeroUse"] = Bit(rp["zero_use"]),
                    ["signReturnDate"] = DateStr(rp["sign_return_date"]) ?? "",
                    // v23 代辦逐筆（合約 §4.10）；機具綁廠商層級，故無工種欄
                    ["agentItems"] = new JsonArray(eqAgentBy[id].Select(g => (JsonNode)new JsonObject
                    {
                        ["vendor"] = Str(g["vendor"]),
                        ["qty"] = Num(g["qty"]),
                        ["note"] = Str(g["note"]) ?? ""
                    }).ToArray())
                };
                AddDoneCols(o, rp);
                report = o;
            }
            equipArr.Add(new JsonObject
            {
                ["id"] = id,
                ["date"] = DateStr(r["work_date"]),
                ["vendor"] = Str(r["vendor"]) ?? "",               // v22.6 起新單為空，廠商在 report
                ["applicant"] = Str(r["applicant"]) ?? "",
                ["types"] = JsonArrayOf(r["types_json"]),
                ["model"] = Str(r["model"]) ?? "",
                ["requiredQty"] = Num(r["required_qty"]),
                ["plannedHours"] = Num(r["planned_hours"]),        // v22.6，可為 null
                ["applyNote"] = Str(r["apply_note"]) ?? "",
                ["contracted"] = Str(r["contracted"]) ?? "",
                ["locations"] = JsonArrayOf(r["locations_json"]),
                ["content"] = Str(r["content"]) ?? "",
                ["status"] = Str(r["status"]),
                ["report"] = report,
                ["audits"] = BuildAudits(eqAudBy[id].ToList(), attsByParent),
                ["attachments"] = BuildAttachments(attsByParent[id].Where(a => (string)a["parent_kind"]! == "equipment").ToList()),
                ["v"] = JsonValue.Create(Convert.ToInt32(r["v"])),
                ["updatedAt"] = StampStr(r["updated_at"])
            });
        }

        stores[name] = new JsonObject { ["config"] = cfg, ["labor"] = laborArr, ["equipment"] = equipArr };
    }
    return stores;
}

/* ---------- 權限中介層（階段 D） ----------
   只擋 /api：靜態前端一律放行，否則使用者連「你沒有權限」的畫面都載不出來。 */
Func<SqlConnection>? erpDb = null;
var erpConn = Environment.GetEnvironmentVariable("KGAUDIT_ERP_CONNECTION")
              ?? app.Configuration.GetConnectionString("KgAuditErp");
if (!string.IsNullOrWhiteSpace(erpConn)) erpDb = () => new SqlConnection(erpConn);

IIdentitySource? identitySource = authOpt.Mode switch
{
    AuthMode.Dev => new DevIdentitySource(),
    AuthMode.Windows => new WindowsIdentitySource(),
    _ => null
};
/* 身分目錄：config（設定檔查表，預設）｜hrapi（呼叫公司人資 API GetEmployeeByAD）。
   hrapi 一定要包一層快取——否則每個 /api 請求都會同步打一次人資 API。
   config 是記憶體查表，不需要。 */
IEmployeeDirectory directory = authOpt.Directory == "hrapi"
    ? new CachingEmployeeDirectory(
          new HrApiEmployeeDirectory(authOpt.HrApi, new HttpClient { Timeout = TimeSpan.FromSeconds(10) }),
          authOpt.CacheMinutes)
    : new ConfigEmployeeDirectory(authOpt);
var authorizer = new Authorizer(authOpt, () => new SqlConnection(ConnStr()), erpDb);

if (authOpt.Mode != AuthMode.Off)
{
    if (authOpt.Mode == AuthMode.Dev)
        app.Logger.LogWarning("Auth:Mode=Dev —— 身分由 X-Dev-User 標頭指定，**正式環境絕不可使用**");

    /* 啟動時把管理員部門印出來。部門名稱是逐字元比對人資 API 的 deptName，
       寫錯不會報錯、只會讓整個部門被擋在門外——印出來才有機會在上線前用肉眼發現。 */
    app.Logger.LogInformation("管理員部門（需與人資 API 的 deptName 逐字相符）：{Depts}",
        string.Join("／", authOpt.AdminDepartments));

    app.Use(async (ctx, next) =>
    {
        if (!ctx.Request.Path.StartsWithSegments("/api")) { await next(); return; }

        var account = identitySource!.Account(ctx);
        if (account is null) { await Deny(ctx, 401,
                "無法辨識您的網域帳號。若您已在公司內網登入，請確認主機（IIS／HTTP.sys）"
                + "已啟用 Windows 驗證並停用匿名存取"); return; }

        var user = await directory.LookupAsync(account);
        if (user is null) { await Deny(ctx, 403, $"查無「{account}」的員工資料，請洽資訊處"); return; }

        Authz? authz;
        try { authz = await authorizer.ResolveAsync(user); }
        catch (Exception ex)
        {
            /* 授權查詢失敗一律拒絕（fail-closed）。放行比擋住危險得多——
               ERP 一斷線就變成全員全站可見，而且沒有人會發現。 */
            app.Logger.LogError(ex, "權限查詢失敗，已拒絕存取：{Account}", account);
            await Deny(ctx, 503, "無法查詢權限資料，請稍後再試或洽資訊處");
            return;
        }
        if (authz is null)
        {
            /* 把「他實際的部門字串」記下來。管理員判定是逐字元比對，設定寫成「採購處」
               而人資回「採購部」就會落到這裡——沒有這行日誌，現場只會看到一句
               「您在 ERP 尚無任何專案權限」，完全查不出是設定字串對不上。 */
            app.Logger.LogWarning("拒絕存取：{Emp}（{Name}）部門「{Dept}」不在管理員部門清單、且 ERP 無可用專案角色",
                user.EmpId, user.Name, user.DeptName);
            await Deny(ctx, 403, "您在 ERP 尚無任何專案權限，請洽成本管理部");
            return;
        }

        ctx.Items["user"] = user;
        ctx.Items["authz"] = authz;
        // 操作軌跡：單一共用帳密時代做不到的問責，AD 化後自然獲得
        if (ctx.Request.Method == "POST")
            app.Logger.LogInformation("op by {Emp}({Name}/{Role}) {Path}", user.EmpId, user.Name, authz.Role, ctx.Request.Path);
        await next();
    });
}

static async Task Deny(HttpContext ctx, int code, string message)
{
    ctx.Response.StatusCode = code;
    ctx.Response.ContentType = "application/json; charset=utf-8";
    await ctx.Response.WriteAsync(new JsonObject { ["error"] = "forbidden", ["message"] = message }.ToJsonString(Wr.JsonOpts));
}

/* ---------- 靜態檔（在 API 路由之前掛，但 /api 前綴不受影響） ---------- */
if (Directory.Exists(staticRoot))
{
    var files = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(staticRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
}
else
{
    // 靜態根找不到就明講，不要讓使用者對著 404 猜路徑
    app.Logger.LogWarning("靜態前端目錄不存在，只提供 API：{Root}（可用環境變數 STATIC_DIR 指定）", staticRoot);
}

/* ---------- 端點 ---------- */
app.MapGet("/api/data", async (HttpContext ctx) =>
{
    var q = ctx.Request.Query;
    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();

    /* ⚠ authz 必須在**所有**分支之前取得。
       原本附件與費率兩個分支寫在取得 authz 之前就 return，等於這兩條路
       完全沒有經過權限判定——scope=all 那邊辛苦做的 stores 同步過濾與
       StripAudits 真隔離，會被「知道附件 id 就能下載」整個抵銷掉。 */
    var az = ctx.Items["authz"] as Authz;

    // 合約 §2.3：附件下載（回二進位，不是 JSON）
    if (q.ContainsKey("attachment")) return await GetAttachment(cn, q["site"].ToString(), q["attachment"].ToString(), az);

    /* 合約 §2.5：可納管的工地候選（v23.3）。限管理者——這是 ERP 的組織資料，
       不該讓一般工地使用者列舉全公司有哪些專案。 */
    if (q.ContainsKey("candidates"))
    {
        /* ⚠ 這個端點會列出**全公司的 ERP 專案代碼與名稱**——與系統其他端點
           只揭露「本站自己的單據」不是同一個等級的資料。
           Auth:Mode=Off 時伺服器端**沒有辦法**判斷誰是管理員（adminPin 只是
           前端防誤觸），所以在權限模式關閉時一律不提供，而不是靠前端自律。 */
        if (authOpt.Mode == AuthMode.Off)
            return Results.Json(new { candidates = Array.Empty<object>(),
                reason = "工地納管需啟用權限模式（Auth:Mode 不可為 Off）——此端點會列出全公司的 ERP 專案，"
                       + "未啟用個人身分時伺服器端無從判斷操作者是否為管理者" });
        if (az is not null && !az.IsAdmin)
            return Results.Json(new { error = "forbidden", message = "此功能限系統管理者" }, statusCode: 403);
        return await GetCandidates(cn, erpDb, authOpt);
    }

    // 合約 §2.4：費率書。**刻意不放進 scope=all**——一季 1,500 列會拖慢每個人開站
    // 費率書是全域資料（不屬於任何工地），工地使用者的報表也要用它計價，故不另做工地過濾。
    if (q.ContainsKey("rates")) return await GetRates(cn);

    var site = q["site"].ToString();
    if (!string.IsNullOrEmpty(site))
    {
        if (az is not null && !az.CanSee(site))
            return Results.Json(new { error = "forbidden", message = "您沒有這個工地的權限" }, statusCode: 403);
        var one = await ReadStores(cn, site);
        // 合約 §2.2：單站回 { config, labor, equipment }（不含外層工地名）
        if (one.Count == 0) return Results.Json(new JsonObject { ["config"] = null, ["labor"] = new JsonArray(), ["equipment"] = new JsonArray() });
        var first = one.First().Value!;
        StripAudits(first, az);
        return Results.Content(first.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
    }

    // 合約 §2.1：{ master, stores }。master.sites 只列 is_active=1（退場專案保留歷史但不上線）
    var siteRows = await Query(cn, "SELECT name FROM dbo.sites WHERE is_active = 1 ORDER BY sort_order");
    var visible = siteRows.Select(s => (string)s["name"]!).Where(n => az is null || az.CanSee(n)).ToArray();
    var master = new JsonObject
    {
        ["sites"] = new JsonArray(visible.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray())
    };
    // v23.2：管理員部門白名單（合約 §4.1）。存 JSON 字串，原樣嵌回而不是變成字串值
    var deptRow = await Query(cn, "SELECT value_json FROM dbo.app_settings WHERE setting_key = @k",
        ("@k", Wr.AdminDeptKey));
    if (deptRow.Count > 0 && JsonArrayOf(deptRow[0]["value_json"]) is JsonArray da && da.Count > 0)
        master["adminDepartments"] = da;
    var stores = await ReadStores(cn, null);
    if (az is not null)
    {
        // master.sites 與 stores 必須同步過濾：只濾清單而 stores 照給，
        // 等於資料還是送到瀏覽器了，那是「看起來隔離」而不是隔離。
        foreach (var k in stores.Select(kv => kv.Key).Where(k => !az.CanSee(k)).ToList()) stores.Remove(k);
        foreach (var kv in stores) StripAudits(kv.Value, az);
    }
    var payload = new JsonObject { ["master"] = master, ["stores"] = stores };
    return Results.Content(payload.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
});

app.MapPost("/api/data", async (HttpContext ctx) =>
{
    JsonObject body;
    try
    {
        body = (await JsonNode.ParseAsync(ctx.Request.Body)) as JsonObject
               ?? throw new InvalidOperationException();
    }
    catch { return Results.Json(new { error = "bad json" }, statusCode: 400); }

    var op = Sx(body, "op") ?? "";

    /* 寫入端的權限把關（AUTH-PLAN §3 第 2／4 點）。
       ⚠ 只靠前端隱藏按鈕不算數——直接 POST 就繞過去了。

       每個 op 必須在 Wr.OpScopes 裡**明確宣告**所需範圍，未登記的一律拒絕。
       原本的寫法是「body 裡有 site 才檢查」——那是「有宣告才把關」，
       呼叫者只要不送 site 欄位，整段授權就被跳過（附件的上傳與刪除正是
       這樣漏掉的）。改成預設拒絕後，日後新增 op 若忘了登記，會在測試階段
       就被擋下，而不是安靜地取得跨工地權限。 */
    if (ctx.Items["authz"] is Authz az)
    {
        switch (Wr.OpScopes.TryGetValue(op, out var sc) ? sc : OpScope.Deny)
        {
            case OpScope.Admin when !az.IsAdmin:
                return Results.Json(new { error = "forbidden", message = "此操作限系統管理者" }, statusCode: 403);

            case OpScope.Site:
                // 工地是必填：沒有工地就無從判定範圍，擋下而不是放行
                var target = Sx(body, "site");
                if (target is null) return Results.Json(new { error = "site required" }, statusCode: 400);
                if (!az.CanSee(target))
                    return Results.Json(new { error = "forbidden", message = "您沒有這個工地的權限" }, statusCode: 403);
                break;

            case OpScope.Deny:
                return Results.Json(new { error = "unknown op" }, statusCode: 400);
        }
    }

    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();

    switch (op)
    {
        case "master":
        {
            var r = await OpMaster(cn, body);
            /* 工地清單變動會改變授權結果（ComputeAsync 只看 is_active=1 的站），
               不清快取的話新工地對已登入的工地使用者最多 30 分鐘不會出現，
               現場會誤判成「權限沒設好」而重複回報。
               op:config 不需要——它不碰 is_active 與 project_code。 */
            authorizer.Invalidate();
            return r;
        }
        case "config": return await OpConfig(cn, body);
        case "record": return await OpRecord(cn, body);
        case "addOption": return await OpAddOption(cn, body);
        case "deleteRecord": return await OpDeleteRecord(cn, body);
        case "uploadAttachment": return await OpUploadAttachment(cn, body);
        case "deleteAttachment": return await OpDeleteAttachment(cn, body);
        case "rateBook": return await OpRateBook(cn, body);
        case "deleteRateBook": return await OpDeleteRateBook(cn, body);
        case "clearSite": return await OpClear(cn, body, false);
        case "clearAll": return await OpClear(cn, body, true);
        case "adoptSite": return await OpAdoptSite(cn, body, erpDb, authOpt);   // v23.3 工地納管

        default: return Results.Json(new { error = "unknown op" }, statusCode: 400);
    }
});

/* ---------- /whoami：身分鏈診斷（v23.4） ----------
   部署 Windows 驗證時最常見的問題是「不知道卡在哪一段」——主機層沒帶身分？
   帳號取錯？工號查不到？部門字串對不上？這個端點把**四段各自的結果**攤開，
   一眼就看得出斷在哪裡。

   ⚠ 刻意放在 /api 之外：權限中介層只擋 /api，若放進去，授權失敗時會被 403
     擋掉——而那正是最需要診斷的時候。仍受整站 Basic Auth 保護，
     且只回報「呼叫者自己」的身分，不能查別人。 */
app.MapGet("/whoami", async (HttpContext ctx) =>
{
    var o = new JsonObject { ["authMode"] = authOpt.Mode.ToString(), ["directory"] = authOpt.Directory };

    // ① 主機層：Windows 驗證有沒有把身分帶進來
    var idn = ctx.User?.Identity;
    o["hostAuthenticated"] = idn?.IsAuthenticated ?? false;
    o["hostIdentity"] = idn?.Name ?? "";
    o["hostAuthType"] = idn?.AuthenticationType ?? "";

    if (identitySource is null)
    {
        o["note"] = "Auth:Mode=Off——未啟用個人身分，全站共用 Basic Auth";
        return Results.Content(o.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
    }

    // ② 取出 AD 帳號（去掉 DOMAIN\ 前綴）
    var account = identitySource.Account(ctx);
    o["account"] = account ?? "";
    if (account is null)
    {
        o["stoppedAt"] = "① 主機層未提供已驗證的身分——請確認 IIS/HTTP.sys 已啟用 Windows 驗證且**停用匿名**";
        return Results.Content(o.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
    }

    // ③ 目錄：AD 帳號 → 工號＋部門
    UserIdentity? user = null;
    /* ⚠ 只回固定文字，**不可把 ex.Message 回給呼叫者**——SqlException／HttpRequestException
       的訊息通常含伺服器名、執行個體與資料庫名，而本端點是整站 Basic Auth 之後
       人人可打的。細節寫伺服器日誌就好（與「內部識別不外洩」的原則一致）。 */
    try { user = await directory.LookupAsync(account); }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "/whoami 目錄查詢失敗：{Account}", account);
        o["directoryError"] = "目錄查詢失敗，詳見伺服器日誌";
    }
    if (user is null)
    {
        o["stoppedAt"] = $"② 查無「{account}」的員工資料"
            + (authOpt.Directory == "config" ? "（目前用設定檔假名單，正式環境請改 Auth:Directory=hrapi）" : "（人資 API）");
        return Results.Content(o.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
    }
    o["empId"] = user.EmpId; o["name"] = user.Name;
    o["deptName"] = user.DeptName; o["onJob"] = user.OnJob;

    // ④ 授權：角色與可見工地
    Authz? az = null;
    try { az = await authorizer.ResolveAsync(user); }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "/whoami 權限查詢失敗：{Emp}", user.EmpId);
        o["authzError"] = "權限查詢失敗，詳見伺服器日誌（多半是 ERP 連線或權限設定問題）";
    }
    if (az is null)
    {
        o["stoppedAt"] = "③ 無任何權限——部門不在管理員清單，且 ERP 查無工地角色";
        o["hint"] = "若此人應為管理員，請比對上方 deptName 與設定的管理員部門是否**逐字**相同";
        return Results.Content(o.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
    }
    o["role"] = az.Role.ToString();
    o["allSites"] = az.AllSites;
    o["sites"] = new JsonArray(az.Sites.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray());
    o["canSeeAudits"] = az.CanSeeAudits;
    o["isAdmin"] = az.IsAdmin;
    return Results.Content(o.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
});

app.MapGet("/health", async () =>
{
    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();
    var r = await Query(cn, "SELECT COUNT(*) AS n FROM dbo.sites");
    return Results.Json(new { ok = true, sites = Convert.ToInt32(r[0]["n"]) });
});

app.Run();


/* ==========================================================================
   階段 B：寫入端（合約 §3.1～§3.5）
   ========================================================================== */

/* ---------- 讀 JSON 的小工具 ----------
   前端送來的欄位常常「該有卻沒有」（舊單）或「有但是空字串」，
   兩者在合約裡都等於「沒填」。這裡統一收斂，避免各處各自判斷。 */
static string? Sx(JsonNode? o, string k)
{
    var v = o?[k];
    if (v is null) return null;
    var s = v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : v.ToJsonString();
    return string.IsNullOrWhiteSpace(s) ? null : s;
}
static decimal? Dx(JsonNode? o, string k)
{
    var v = o?[k];
    if (v is null) return null;
    if (v.GetValueKind() == JsonValueKind.Number) return v.GetValue<decimal>();
    // JSON 的數字字面一律是 invariant 格式，解析也必須用 invariant——
    // 小數點符號不同的地區設定會把 "8.5" 讀成 null（靜默變成沒填）
    return v.GetValueKind() == JsonValueKind.String
           && decimal.TryParse(v.GetValue<string>(), NumberStyles.Number, CultureInfo.InvariantCulture, out var d)
        ? d : null;
}
static decimal D0(JsonNode? o, string k) => Dx(o, k) ?? 0m;
static bool Bx(JsonNode? o, string k) => o?[k]?.GetValueKind() == JsonValueKind.True;
// 陣列欄位一律存成 JSON 字串；缺漏時存 []（合約型別是陣列，塌成 NULL 會讓前端 .map 爆炸）
static string Jx(JsonNode? o, string k) => ((o?[k]) as JsonArray ?? new JsonArray()).ToJsonString();

static SqlCommand Cmd(SqlConnection cn, SqlTransaction? tx, string sql, params (string, object?)[] ps)
{
    var c = new SqlCommand(sql, cn, tx);
    foreach (var (n, v) in ps) c.Parameters.AddWithValue(n, v ?? DBNull.Value);
    return c;
}
static async Task<int> Exec(SqlConnection cn, SqlTransaction? tx, string sql, params (string, object?)[] ps)
{
    await using var c = Cmd(cn, tx, sql, ps);
    return await c.ExecuteNonQueryAsync();
}
static async Task<object?> Scalar(SqlConnection cn, SqlTransaction? tx, string sql, params (string, object?)[] ps)
{
    await using var c = Cmd(cn, tx, sql, ps);
    var v = await c.ExecuteScalarAsync();
    return v is DBNull ? null : v;
}


/* 工地 id：找不到時建檔。
   雲端版任何工地字串都能直接寫入（blob key 即建即用），這裡不比照的話
   「工地清單還沒同步就先送單」會整筆 400——資料就掉了。
   新建一律 is_active=1，是否上線由 op:master 的清單決定。 */
static async Task<int> SiteId(SqlConnection cn, SqlTransaction? tx, string site)
{
    var id = await Scalar(cn, tx, "SELECT site_id FROM dbo.sites WHERE name = @n", ("@n", site));
    if (id is not null) return Convert.ToInt32(id);
    var newId = await Scalar(cn, tx,
        @"INSERT INTO dbo.sites (name, sort_order, is_active)
          OUTPUT INSERTED.site_id
          VALUES (@n, (SELECT ISNULL(MAX(sort_order), -1) + 1 FROM dbo.sites), 1)", ("@n", site));
    return Convert.ToInt32(newId);
}

/* ---------- §3.1 op:master ---------- */
static async Task<IResult> OpMaster(SqlConnection cn, JsonObject body)
{
    var sites = (body["sites"] as JsonArray)?
        .Select(n => n?.GetValue<string>() ?? "").Where(s => s.Length > 0).ToList() ?? new List<string>();
    if (sites.Count == 0) return Results.Json(new { error = "sites required" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();

    /* v23.2：管理員部門白名單（合約 §3.1）。
       **省略＝保留既有值，不是清空**——舊版前端只送 sites，比照 sites 的整包覆蓋
       會把管理員設定一起洗掉。要清空請明確送空陣列。 */
    if (body["adminDepartments"] is JsonArray depts)
    {
        var vals = depts.Select(d => d?.GetValueKind() == JsonValueKind.String ? d.GetValue<string>().Trim() : null)
            .Where(s => !string.IsNullOrEmpty(s)).Distinct(StringComparer.Ordinal).ToArray();
        await Exec(cn, tx,
            @"MERGE dbo.app_settings AS t
              USING (SELECT @k AS k) AS s ON t.setting_key = s.k
              WHEN MATCHED THEN UPDATE SET value_json = @v, updated_at = SYSDATETIME()
              WHEN NOT MATCHED THEN INSERT (setting_key, value_json) VALUES (@k, @v);",
            ("@k", Wr.AdminDeptKey), ("@v", new JsonArray(vals.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()).ToJsonString(Wr.JsonOpts)));
    }

    // 不在清單裡的工地標為 is_active=0 而**不是刪除**——歷史紀錄必須留著，
    // 退場專案的資料還要供成本部查帳（scope=all 仍會合成 stores 條目）。
    await Exec(cn, tx, "UPDATE dbo.sites SET is_active = 0", Array.Empty<(string, object?)>());
    for (var i = 0; i < sites.Count; i++)
    {
        var sid = await SiteId(cn, tx, sites[i]);
        await Exec(cn, tx, "UPDATE dbo.sites SET is_active = 1, sort_order = @o WHERE site_id = @s",
            ("@o", i), ("@s", sid));
    }
    await tx.CommitAsync();
    return Results.Json(new { ok = true });
}

/* ---------- §3.2 op:config（整包覆蓋，管理員批次儲存） ---------- */
static async Task<IResult> OpConfig(SqlConnection cn, JsonObject body)
{
    var site = Sx(body, "site");
    if (site is null) return Results.Json(new { error = "site required" }, statusCode: 400);
    var cfg = body["config"] as JsonObject;
    if (cfg is null) return Results.Json(new { error = "config required" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    var sid = await SiteId(cn, tx, site);

    await Exec(cn, tx, "UPDATE dbo.sites SET lock_date = @d WHERE site_id = @s",
        ("@d", Sx(cfg, "lockDate")), ("@s", sid));

    await Exec(cn, tx, "DELETE FROM dbo.site_options WHERE site_id = @s", ("@s", sid));
    foreach (var pool in Wr.Pools)
    {
        // 大小寫/前後空白視為同值只取首見——site_options 的 UNIQUE 走 CI 定序，
        // 不去重會整筆交易撞鍵回滾（遷移工具同樣處理，見 backup-json-to-sql.py）
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in (cfg[pool] as JsonArray) ?? new JsonArray())
        {
            var val = n?.GetValueKind() == JsonValueKind.String ? n.GetValue<string>().Trim() : null;
            if (string.IsNullOrEmpty(val) || !seen.Add(val)) continue;
            await Exec(cn, tx, "INSERT INTO dbo.site_options (site_id, pool, value) VALUES (@s, @p, @v)",
                ("@s", sid), ("@p", pool), ("@v", val));
        }
    }

    await WriteRateBindings(cn, tx, sid, cfg["rateBindings"] as JsonObject);
    await tx.CommitAsync();
    return Results.Json(new { ok = true });
}

/* 費率綁定：labor 的鍵是「廠商|工種」值為 {vendorCode,note}，equipment 的鍵是「廠商」值為字串。
   兩種形狀不同是 v22.8 的既定設計（機具綁到廠商層級），不是筆誤。 */
static async Task WriteRateBindings(SqlConnection cn, SqlTransaction tx, int sid, JsonObject? binds)
{
    await Exec(cn, tx, "DELETE FROM dbo.site_rate_bindings WHERE site_id = @s", ("@s", sid));
    if (binds is null) return;

    foreach (var kv in (binds["labor"] as JsonObject) ?? new JsonObject())
    {
        var code = Sx(kv.Value, "vendorCode");
        if (kv.Key.Length == 0 || code is null) continue;
        await Exec(cn, tx,
            "INSERT INTO dbo.site_rate_bindings (site_id, kind, bind_key, vendor_code, note) VALUES (@s,'labor',@k,@c,@n)",
            ("@s", sid), ("@k", Trunc(kv.Key, 400)), ("@c", Trunc(code, 40)), ("@n", Sx(kv.Value, "note")));
    }
    foreach (var kv in (binds["equipment"] as JsonObject) ?? new JsonObject())
    {
        var code = kv.Value?.GetValueKind() == JsonValueKind.String ? kv.Value.GetValue<string>() : null;
        if (kv.Key.Length == 0 || string.IsNullOrWhiteSpace(code)) continue;
        await Exec(cn, tx,
            "INSERT INTO dbo.site_rate_bindings (site_id, kind, bind_key, vendor_code, note) VALUES (@s,'equipment',@k,@c,NULL)",
            ("@s", sid), ("@k", Trunc(kv.Key, 400)), ("@c", Trunc(code!, 40)));
    }
}
static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];

/* ---------- §3.4 op:addOption（伺服器端 read-merge-write） ---------- */
static async Task<IResult> OpAddOption(SqlConnection cn, JsonObject body)
{
    var site = Sx(body, "site");
    var pool = Sx(body, "pool");
    var value = Sx(body, "value")?.Trim();
    if (site is null || pool is null || value is null)
        return Results.Json(new { error = "site/pool/value required" }, statusCode: 400);
    if (!Wr.Pools.Contains(pool)) return Results.Json(new { error = "bad pool" }, statusCode: 400);
    // v15.1：回報覆核限一位工程師代表，名單源頭就堵住多人並列
    if (pool == "people" && Wr.PersonSplit.IsMatch(value))
        return Results.Json(new { error = "person name must be a single name" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    var sid = await SiteId(cn, tx, site);
    // HOLDLOCK：兩人同時新增同一個值時序列化，不會互相覆蓋也不會撞 UNIQUE
    var exists = await Scalar(cn, tx,
        "SELECT 1 FROM dbo.site_options WITH (UPDLOCK, HOLDLOCK) WHERE site_id=@s AND pool=@p AND value=@v",
        ("@s", sid), ("@p", pool), ("@v", value));
    if (exists is null)
        await Exec(cn, tx, "INSERT INTO dbo.site_options (site_id, pool, value) VALUES (@s,@p,@v)",
            ("@s", sid), ("@p", pool), ("@v", value));

    await using var read = Cmd(cn, tx,
        "SELECT value FROM dbo.site_options WHERE site_id=@s AND pool=@p ORDER BY option_id", ("@s", sid), ("@p", pool));
    var list = new List<string>();
    await using (var rd = await read.ExecuteReaderAsync())
        while (await rd.ReadAsync()) list.Add(rd.GetString(0));
    await tx.CommitAsync();

    // 合約 §3.4：回合併後的完整清單，前端會以此覆蓋本地快取
    return Results.Json(new { ok = true, pool = list });
}

/* ---------- §3.5 op:deleteRecord（冪等） ---------- */
static async Task<IResult> OpDeleteRecord(SqlConnection cn, JsonObject body)
{
    var site = Sx(body, "site");
    var kind = Sx(body, "kind");
    var id = Sx(body, "id");
    if (site is null || id is null || (kind != "labor" && kind != "equipment"))
        return Results.Json(new { error = "site/kind/id required" }, statusCode: 400);
    if (!Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    var sid = await SiteId(cn, tx, site);
    await DeleteRecordRows(cn, tx, sid, kind, id);
    await tx.CommitAsync();
    return Results.Json(new { ok = true });
}

/* 刪整筆：子層一律連坐（含 v14 起的附件描述資料，避免孤兒檔案）。
   ⚠ 附件**本體**的刪除在階段 C——實作時要能只憑 attachment_id 刪檔，
     不可依賴這裡的 metadata 列還在。 */
static async Task DeleteRecordRows(SqlConnection cn, SqlTransaction tx, int sid, string kind, string id)
{
    var (recT, repT, childT, childCol, audT, attKind, agentT) = kind == "labor"
        ? ("labor_records", "labor_reports", "labor_report_worktypes", "record_id", "labor_audits", "labor_audit", "labor_agent_items")
        : ("equip_records", "equip_reports", "equip_report_usage", "record_id", "equip_audits", "equip_audit", "equip_agent_items");

    /* ⚠ 跨工地守衛，不可省略。
       單據 id 是**全域主鍵**（DB-SCHEMA.sql：PK_labor / PK_equip 只有 id），
       而下面三張子表只以 record_id 為鍵——父表那道 site_id 條件擋得住父列，
       擋不住子列。少了這道守衛，帶著別站的 id ＋自己有權限的工地名呼叫
       op:deleteRecord，就會刪掉別站的回報、逐工種明細與成控稽核紀錄，
       而且交易正常提交、不報任何錯。
       子表都有 ON DELETE CASCADE 指向父表，所以「父列不在本站」就等於
       「本站沒有任何該刪的東西」，直接返回是安全的。 */
    var owned = await Scalar(cn, tx, $"SELECT 1 FROM dbo.{recT} WHERE id=@id AND site_id=@s", ("@id", id), ("@s", sid));
    if (owned is null) return;

    await Exec(cn, tx,
        $@"DELETE FROM dbo.attachments
           WHERE site_id=@s AND ((parent_kind=@pk AND parent_id=@id)
              OR (parent_kind=@ak AND parent_id IN (SELECT audit_id FROM dbo.{audT} WHERE record_id=@id)))",
        ("@s", sid), ("@pk", kind), ("@id", id), ("@ak", attKind));
    await Exec(cn, tx, $"DELETE FROM dbo.{audT} WHERE record_id=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{childT} WHERE {childCol}=@id", ("@id", id));
    // v23 代辦列：FK 掛在 *_reports 上、有 ON DELETE CASCADE，刪 repT 本來就會連動，
    // 這裡仍明寫一行與其他子表對齊——日後有人改動 FK 時不會靜默留下孤兒列
    await Exec(cn, tx, $"DELETE FROM dbo.{agentT} WHERE record_id=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{repT} WHERE record_id=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{recT} WHERE id=@id AND site_id=@s", ("@id", id), ("@s", sid));
}

/* ---------- 合約 §4.7 日期防呆（伺服器端） ----------
   合約明訂「目前僅前端強制。地端 API 應在伺服器端重做同樣檢查——前端驗證
   擋得住誤填，擋不住直接打 API」。這兩個欄位最容易被拿來製造「有按時出工／
   按時繳回」的假象，是計價會採信的依據。

   ⚠ 只在這次請求**真的改動**了出工日或簽單繳回日時才驗證。原因：
     前端只在「回報送出」那兩處檢查（app.js 的 reportTimingError／signReturnError），
     成控**稽核儲存並不經過**——而稽核儲存同樣是整筆 op:record 覆寫。
     若對每一次寫入都驗，成控就無法對既有的違規舊單建稽核紀錄。
     （正式資料實測：1,120 筆單據中有 1 筆繳回日超期。）
   原樣重送放行、任何想把值設成違規的請求一律擋下，兩邊都顧到。 */
static string? DateGuardError(JsonObject rec, string? storedDate, string? storedSrd)
{
    if (rec["report"] is not JsonObject rep) return null;   // 沒有回報就不適用

    var dateStr = Sx(rec, "date");
    var srdStr = Sx(rep, "signReturnDate");
    if (string.Equals(dateStr, storedDate, StringComparison.Ordinal)
        && string.Equals(srdStr, storedSrd, StringComparison.Ordinal)) return null;

    // 出工日缺漏或格式不符由資料表的 DATE NOT NULL 把關，這裡不重複判斷
    if (!DateOnly.TryParseExact(dateStr ?? "", "yyyy-MM-dd",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var wd)) return null;

    if (wd > DateOnly.FromDateTime(DateTime.Now))
        return $"出工日期（{dateStr}）還沒到，無法回報——回報必須在出工當天或之後";

    if (srdStr is null) return null;
    if (!DateOnly.TryParseExact(srdStr, "yyyy-MM-dd",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out var sd))
        return $"簽單繳回日（{srdStr}）格式不正確";
    if (sd < wd)
        return $"簽單繳回日（{srdStr}）早於出工日期（{dateStr}）——簽單不可能在出工前繳回";

    var deadline = wd.AddDays(Wr.SignReturnMaxDays);
    if (sd > deadline)
        return $"簽單繳回日（{srdStr}）已超過出工日後 {Wr.SignReturnMaxDays} 天的期限"
             + $"（最晚 {deadline.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)}），逾期不予採計";
    return null;
}

/* ---------- §3.3 op:record ★核心（含樂觀並發） ---------- */
static async Task<IResult> OpRecord(SqlConnection cn, JsonObject body)
{
    var site = Sx(body, "site");
    var kind = Sx(body, "kind");
    var rec = body["record"] as JsonObject;
    if (site is null || rec is null || (kind != "labor" && kind != "equipment"))
        return Results.Json(new { error = "site/kind/record required" }, statusCode: 400);

    var id = Sx(rec, "id");
    if (id is null || !Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);
    var baseV = (int)D0(body, "baseV");

    var recT = kind == "labor" ? "labor_records" : "equip_records";
    var repT = kind == "labor" ? "labor_reports" : "equip_reports";

    /* 整段包在一個交易裡。UPDLOCK+HOLDLOCK 讓「讀版本 → 比對 → 覆寫」成為
       不可分割的臨界區：兩人同時送出時後者會等前者提交，讀到新的 v 而正確吃到 409。
       若只做 SELECT 再 UPDATE，兩人可能都讀到舊 v 而雙雙寫入——409 就形同虛設。 */
    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync(IsolationLevel.ReadCommitted);
    var sid = await SiteId(cn, tx, site);
    // 版本與「目前存著的兩個日期」一次讀出來——後者是 §4.7 判斷「這次有沒有改到日期」的基準
    var cur = await QueryTx(cn, tx,
        $@"SELECT r.v, r.work_date, rp.sign_return_date
           FROM dbo.{recT} r WITH (UPDLOCK, HOLDLOCK)
           LEFT JOIN dbo.{repT} rp ON rp.record_id = r.id
           WHERE r.id=@id AND r.site_id=@s", ("@id", id), ("@s", sid));
    var curV = cur.Count == 0 ? null : cur[0]["v"];

    // 合約 §3.3：版本不符→modified；紀錄不存在但宣告基準>0→deleted。語意不可改。
    if (curV is null)
    {
        if (baseV > 0)
        {
            await tx.RollbackAsync();
            return Results.Json(new { error = "conflict", reason = "deleted" }, statusCode: 409);
        }
        /* 這個 id 在別的工地已經存在（id 是全域主鍵）。不擋的話會走到下面的
           INSERT 撞 PK 而丟出 500，訊息對使用者毫無意義；直接講清楚。 */
        var elsewhere = await Scalar(cn, tx, $"SELECT 1 FROM dbo.{recT} WHERE id=@id", ("@id", id));
        if (elsewhere is not null)
        {
            await tx.RollbackAsync();
            return Results.Json(new { error = "conflict", reason = "modified",
                message = "此單據 id 已存在於其他工地" }, statusCode: 409);
        }
    }
    else if (Convert.ToInt32(curV) != baseV)
    {
        await tx.RollbackAsync();
        return Results.Json(new { error = "conflict", reason = "modified" }, statusCode: 409);
    }

    // 合約 §4.7 日期防呆（伺服器端重做，前端擋不住直接打 API）
    var dateErr = DateGuardError(rec,
        cur.Count == 0 ? null : DateStr(cur[0]["work_date"]),
        cur.Count == 0 ? null : DateStr(cur[0]["sign_return_date"]));
    if (dateErr is not null)
    {
        await tx.RollbackAsync();
        return Results.Json(new { error = "invalid date", message = dateErr }, statusCode: 400);
    }

    var newV = baseV + 1;
    var now = DateTime.Now;   // 本地時間；資料庫欄位存本地，讀出時由 StampStr 補時區位移

    // 先整筆清掉再重建：合約語意是「覆寫整筆」，逐欄 diff 反而容易漏掉被移除的子層。
    // 附件描述資料例外——見 SyncAttachments。
    var keepAtt = await SnapshotAttachments(cn, tx, sid, kind, id);
    await DeleteRecordRows(cn, tx, sid, kind, id);

    if (kind == "labor") await InsertLabor(cn, tx, sid, rec, id, newV, now);
    else await InsertEquip(cn, tx, sid, rec, id, newV, now);

    await SyncAttachments(cn, tx, sid, kind, id, rec["attachments"] as JsonArray, keepAtt);
    await InsertAudits(cn, tx, sid, kind, id, rec["audits"] as JsonArray, keepAtt);

    await tx.CommitAsync();
    return Results.Json(new { ok = true, v = newV, updatedAt = StampStr(now) });
}

static async Task InsertLabor(SqlConnection cn, SqlTransaction tx, int sid, JsonObject r, string id, int v, DateTime now)
{
    await Exec(cn, tx,
        @"INSERT INTO dbo.labor_records (id, site_id, work_date, vendor, applicant, required_units,
              locations_json, categories_json, category_note, workers_json, status, v, updated_at)
          VALUES (@id,@s,@d,@ven,@app,@req,@loc,@cat,@cn,@wk,@st,@v,@u)",
        ("@id", id), ("@s", sid), ("@d", Sx(r, "date")), ("@ven", Sx(r, "vendor")), ("@app", Sx(r, "applicant")),
        ("@req", D0(r, "required")), ("@loc", Jx(r, "locations")), ("@cat", Jx(r, "categories")),
        ("@cn", Sx(r, "categoryNote")), ("@wk", Jx(r, "workers")), ("@st", Sx(r, "status")), ("@v", v), ("@u", now));

    if (r["report"] is not JsonObject rep) return;
    await Exec(cn, tx,
        @"INSERT INTO dbo.labor_reports (record_id, reported_at, engineer, check_face, check_card, check_toolbox,
              actual, ot2_total, ot_over_total, diff, zero_work, sign_return_date,
              vendor_done_work, vendor_done_hours, vendor_done_note,
              self_done_work, self_done_hours, self_done_note,
              legacy_self_done, legacy_vendor_done, legacy_attendance_json, conclusion)
          VALUES (@id,@ra,@eng,@cf,@cc,@ct,@act,@ot2,@oto,@dif,@zw,@srd,
                  @vdw,@vdh,@vdn,@sdw,@sdh,@sdn,@lsd,@lvd,@att,@con)",
        ("@id", id), ("@ra", Sx(rep, "reportedAt")), ("@eng", Sx(rep, "engineer")),
        ("@cf", Bx(rep, "checkFace")), ("@cc", Bx(rep, "checkCard")), ("@ct", Bx(rep, "checkToolbox")),
        ("@act", D0(rep, "actual")),
        // 分段加班：舊單（v11 前）只有 totalOT，一律歸前 2 小時段（合約 §4.3、計價紅線 1）
        ("@ot2", Dx(rep, "ot2Total") ?? Dx(rep, "totalOT") ?? 0m),
        ("@oto", D0(rep, "otOverTotal")), ("@dif", D0(rep, "diff")), ("@zw", Bx(rep, "zeroWork")),
        ("@srd", Sx(rep, "signReturnDate")),
        ("@vdw", Dx(rep, "vendorDoneWork")), ("@vdh", Dx(rep, "vendorDoneHours")), ("@vdn", Sx(rep, "vendorDoneNote")),
        ("@sdw", Dx(rep, "selfDoneWork")), ("@sdh", Dx(rep, "selfDoneHours")), ("@sdn", Sx(rep, "selfDoneNote")),
        ("@lsd", Sx(rep, "selfDone")), ("@lvd", Sx(rep, "vendorDone")),
        ("@att", Jx(rep, "attendance")), ("@con", Sx(rep, "conclusion")));

    foreach (var w in (rep["workTypes"] as JsonArray) ?? new JsonArray())
    {
        var type = Sx(w, "type");
        if (type is null) continue;   // 無工種名的列無法計價，比照遷移工具跳過
        await Exec(cn, tx,
            "INSERT INTO dbo.labor_report_worktypes (record_id, work_type, work, ot2, ot_over) VALUES (@id,@t,@w,@a,@b)",
            ("@id", id), ("@t", type), ("@w", D0(w, "work")), ("@a", D0(w, "ot2")), ("@b", D0(w, "otOver")));
    }

    // v23 代辦逐筆（合約 §4.10）。廠商與工種缺任一就無從歸戶／無從查費率，跳過
    foreach (var a in (rep["agentItems"] as JsonArray) ?? new JsonArray())
    {
        var av = Sx(a, "vendor");
        var at = Sx(a, "type");
        if (av is null || at is null) continue;
        await Exec(cn, tx,
            "INSERT INTO dbo.labor_agent_items (record_id, vendor, work_type, work, ot2, ot_over, note) VALUES (@id,@v,@t,@w,@a2,@b,@n)",
            ("@id", id), ("@v", Trunc(av, 200)), ("@t", Trunc(at, 100)),
            ("@w", D0(a, "work")), ("@a2", D0(a, "ot2")), ("@b", D0(a, "otOver")), ("@n", Sx(a, "note")));
    }
}

static async Task InsertEquip(SqlConnection cn, SqlTransaction tx, int sid, JsonObject r, string id, int v, DateTime now)
{
    await Exec(cn, tx,
        @"INSERT INTO dbo.equip_records (id, site_id, work_date, vendor, applicant, types_json, model,
              required_qty, planned_hours, apply_note, contracted, locations_json, content, status, v, updated_at)
          VALUES (@id,@s,@d,@ven,@app,@ty,@mo,@rq,@ph,@an,@co,@loc,@ct,@st,@v,@u)",
        ("@id", id), ("@s", sid), ("@d", Sx(r, "date")),
        // v22.6：廠商改在回報時填（工地統一叫車再配車），申請單允許沒有
        ("@ven", Sx(r, "vendor")), ("@app", Sx(r, "applicant")), ("@ty", Jx(r, "types")), ("@mo", Sx(r, "model")),
        ("@rq", D0(r, "requiredQty")), ("@ph", Dx(r, "plannedHours")), ("@an", Sx(r, "applyNote")),
        ("@co", Sx(r, "contracted")), ("@loc", Jx(r, "locations")), ("@ct", Sx(r, "content")),
        ("@st", Sx(r, "status")), ("@v", v), ("@u", now));

    if (r["report"] is not JsonObject rep) return;
    await Exec(cn, tx,
        @"INSERT INTO dbo.equip_reports (record_id, reported_at, checker, vendor, actual_hours, diff, days, ot_hours,
              work_content, rate_item, rate_ot_item, zero_use, sign_return_date,
              vendor_done_work, vendor_done_hours, vendor_done_note,
              self_done_work, self_done_hours, self_done_note, legacy_self_done, legacy_vendor_done)
          VALUES (@id,@ra,@ck,@ven,@ah,@dif,@dy,@ot,@wc,@ri,@ro,@zu,@srd,
                  @vdw,@vdh,@vdn,@sdw,@sdh,@sdn,@lsd,@lvd)",
        ("@id", id), ("@ra", Sx(rep, "reportedAt")), ("@ck", Sx(rep, "checker")), ("@ven", Sx(rep, "vendor")),
        ("@ah", D0(rep, "actualHours")),
        // diff 可為 NULL（申請單沒填預定時數＝無從比較）。**不可塞 0**——
        // 0 在報表上會被讀成「與預定相符」，是假訊息。
        ("@dif", Dx(rep, "diff")),
        ("@dy", D0(rep, "days")), ("@ot", D0(rep, "otHours")), ("@wc", Sx(rep, "workContent")),
        // v22.8：只存挑了哪一項，金額不落庫（合約 §4.9）——費率書會換季，金額要能回算
        ("@ri", Sx(rep, "rateItem")), ("@ro", Sx(rep, "rateOtItem")),
        ("@zu", Bx(rep, "zeroUse")), ("@srd", Sx(rep, "signReturnDate")),
        ("@vdw", Dx(rep, "vendorDoneWork")), ("@vdh", Dx(rep, "vendorDoneHours")), ("@vdn", Sx(rep, "vendorDoneNote")),
        ("@sdw", Dx(rep, "selfDoneWork")), ("@sdh", Dx(rep, "selfDoneHours")), ("@sdn", Sx(rep, "selfDoneNote")),
        ("@lsd", Sx(rep, "selfDone")), ("@lvd", Sx(rep, "vendorDone")));

    foreach (var u in (rep["usage"] as JsonArray) ?? new JsonArray())
    {
        var type = Sx(u, "type");
        if (type is null) continue;
        await Exec(cn, tx,
            "INSERT INTO dbo.equip_report_usage (record_id, equip_type, present, hours) VALUES (@id,@t,@p,@h)",
            ("@id", id), ("@t", type), ("@p", Bx(u, "present")), ("@h", D0(u, "hours")));
    }

    // v23 代辦逐筆（合約 §4.10）
    foreach (var a in (rep["agentItems"] as JsonArray) ?? new JsonArray())
    {
        var av = Sx(a, "vendor");
        if (av is null) continue;
        await Exec(cn, tx,
            "INSERT INTO dbo.equip_agent_items (record_id, vendor, qty, note) VALUES (@id,@v,@q,@n)",
            ("@id", id), ("@v", Trunc(av, 200)), ("@q", D0(a, "qty")), ("@n", Sx(a, "note")));
    }
}

static async Task InsertAudits(SqlConnection cn, SqlTransaction tx, int sid, string kind, string id,
                               JsonArray? audits, Dictionary<string, string?> keepAtt)
{
    var table = kind == "labor" ? "labor_audits" : "equip_audits";
    var attKind = kind == "labor" ? "labor_audit" : "equip_audit";
    foreach (var a in audits ?? new JsonArray())
    {
        var aid = Sx(a, "id");
        var at = Sx(a, "auditedAt");
        var auditor = Sx(a, "auditor");
        // auditor / auditedAt 是 NOT NULL：缺漏就跳過，不可送出會讓整筆交易回滾的違規列
        if (aid is null || !Wr.IdRe.IsMatch(aid) || at is null || auditor is null) continue;
        var status = Sx(a, "statusAtAudit");
        if (status is null || !Wr.Statuses.Contains(status)) status = null;
        await Exec(cn, tx,
            $@"INSERT INTO dbo.{table} (audit_id, record_id, audited_at, auditor, applied, actual_count,
                   diff, items_json, note, status_at_audit, edited_at)
               VALUES (@aid,@rid,@at,@au,@ap,@ac,@df,@it,@nt,@st,@ed)",
            ("@aid", aid), ("@rid", id), ("@at", at), ("@au", auditor),
            ("@ap", D0(a, "applied")), ("@ac", D0(a, "actualCount")), ("@df", D0(a, "diff")),
            ("@it", Jx(a, "items")), ("@nt", Sx(a, "note")), ("@st", status), ("@ed", Sx(a, "editedAt")));

        await SyncAttachments(cn, tx, sid, attKind, aid, a?["attachments"] as JsonArray, keepAtt);
    }
}

/* 附件描述資料：**不能跟其他子層一樣砍掉重建**。
   file_path 是切換日由附件搬運腳本補填的，砍掉重建會把它抹成 NULL，
   之後就找不到實體檔案了。作法是刪除前先快照，重建時把舊的 file_path 帶回來。 */
static async Task<Dictionary<string, string?>> SnapshotAttachments(SqlConnection cn, SqlTransaction tx, int sid, string kind, string id)
{
    var audT = kind == "labor" ? "labor_audits" : "equip_audits";
    var attKind = kind == "labor" ? "labor_audit" : "equip_audit";
    var map = new Dictionary<string, string?>(StringComparer.Ordinal);
    await using var c = Cmd(cn, tx,
        $@"SELECT attachment_id, file_path FROM dbo.attachments
           WHERE site_id=@s AND ((parent_kind=@pk AND parent_id=@id)
              OR (parent_kind=@ak AND parent_id IN (SELECT audit_id FROM dbo.{audT} WHERE record_id=@id)))",
        ("@s", sid), ("@pk", kind), ("@id", id), ("@ak", attKind));
    await using var rd = await c.ExecuteReaderAsync();
    while (await rd.ReadAsync()) map[rd.GetString(0)] = rd.IsDBNull(1) ? null : rd.GetString(1);
    return map;
}

static async Task SyncAttachments(SqlConnection cn, SqlTransaction tx, int sid, string parentKind, string parentId,
                                  JsonArray? atts, Dictionary<string, string?> keep)
{
    foreach (var a in atts ?? new JsonArray())
    {
        var aid = Sx(a, "id");
        var name = Sx(a, "name");
        if (aid is null || !Wr.IdRe.IsMatch(aid) || name is null) continue;
        keep.TryGetValue(aid, out var path);
        // 前端的順序是「先 uploadAttachment 落檔、再存單」，所以存單當下檔案已經在了，
        // 但描述資料這一列還不存在（快照裡也就沒有）。檔案在就把 file_path 補上，
        // 否則之後下載會誤判成「尚未搬運」。
        if (path is null && File.Exists(Path.Combine(AttachDir(), aid))) path = aid;
        await Exec(cn, tx,
            @"INSERT INTO dbo.attachments (attachment_id, site_id, parent_kind, parent_id, name,
                  content_type, size_bytes, uploaded_at, file_path)
              VALUES (@aid,@s,@pk,@pid,@nm,@ct,@sz,@up,@fp)",
            ("@aid", aid), ("@s", sid), ("@pk", parentKind), ("@pid", parentId), ("@nm", Trunc(name, 200)),
            ("@ct", Trunc(Sx(a, "type") ?? "application/octet-stream", 50)), ("@sz", (int)D0(a, "size")),
            ("@up", Sx(a, "uploadedAt")), ("@fp", path));
    }
}


/* ==========================================================================
   階段 C：附件（合約 §2.3／§3.6／§3.7）、費率書（§2.4／§3.9／§3.10）、清空（§3.8）
   ========================================================================== */

/* 附件本體放檔案系統，不進資料庫：
   幾百 MB 的簽單照片塞進 DB 會讓備份與還原變得又慢又大，而且沒有任何好處
   ——這些檔案上傳後就不再變動，也不需要交易保護。
   ⚠ 檔名一律用已驗證格式的 attachment_id（^[A-Za-z0-9_-]{1,64}$），
     所以不可能出現 ".." 或路徑分隔字元——路徑穿越在來源就被擋掉了。 */
// 解析一次就好，見 Wr.AttachRoot 的說明
static string AttachDir() => Wr.AttachRoot;

/* 附件的跨工地守衛（合約 §3.6／§3.7 的請求都帶 site，但 site 是**宣告**不是憑證）。

   描述資料那一列若存在，它的 site_id 才是唯一權威——宣告的工地對不上就擋下。
   列不存在時放行是刻意的：前端的兩個正常流程都會在「沒有列」的狀態下呼叫這兩個 op
     上傳：先 uploadAttachment 落檔 → 再存單才建立描述資料
     刪除：先存單（被移除的附件當下就從資料表消失）→ 再 deleteAttachment 刪檔
   而要讓**別站**的附件變成「沒有列」，本來就得先有那一站的寫入權限，
   所以這個放行不會成為繞道。 */
static async Task<bool> AttachSiteMismatch(SqlConnection cn, string id, string? site)
{
    if (site is null) return true;   // 合約要求帶 site；沒帶就無從判定，擋下
    var owner = await Scalar(cn, null,
        @"SELECT s.name FROM dbo.attachments a JOIN dbo.sites s ON s.site_id = a.site_id
          WHERE a.attachment_id = @id", ("@id", id));
    return owner is not null && !string.Equals((string)owner, site, StringComparison.Ordinal);
}

static async Task<IResult> GetAttachment(SqlConnection cn, string site, string id, Authz? az)
{
    if (!Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);
    var rows = await Query(cn,
        @"SELECT s.name AS owner_site, a.name, a.content_type, a.file_path FROM dbo.attachments a
          JOIN dbo.sites s ON s.site_id = a.site_id
          WHERE a.attachment_id = @id AND (@site = '' OR s.name = @site)",
        ("@id", id), ("@site", site ?? ""));
    if (rows.Count == 0) return Results.Json(new { error = "not found" }, statusCode: 404);

    var r = rows[0];
    /* 權限一律以**描述資料所記的所屬工地**判定，不可信呼叫者送來的 site：
       上面的 @site 條件允許空字串（前端有些呼叫不帶工地），所以它擋不住
       「不帶 site ＋知道附件 id」這條路。稽核照片只有成控看得到，
       附件是它們的載體，這裡漏掉就等於稽核隔離沒做。 */
    if (az is not null && !az.CanSee(Str(r["owner_site"]) ?? ""))
        return Results.Json(new { error = "forbidden", message = "您沒有這個工地的權限" }, statusCode: 403);

    var rel = Str(r["file_path"]);
    var path = rel is null ? null : Path.Combine(AttachDir(), rel);
    if (path is null || !File.Exists(path))
        // 遷移進來的舊附件只有描述資料、沒有檔案本體（備份 JSON 不含檔案）。
        // 講清楚是「還沒搬運」而不是「不存在」，否則切換日會被誤判成資料遺失。
        return Results.Json(new { error = "not found", reason = "附件本體尚未搬運至地端（file_path 為空或檔案不存在）" }, statusCode: 404);

    var name = Str(r["name"]) ?? id;
    var type = Str(r["content_type"]) ?? "application/octet-stream";
    return new AttachmentResult(await File.ReadAllBytesAsync(path), type, name);
}

/* ---------- §3.6 op:uploadAttachment ---------- */
static async Task<IResult> OpUploadAttachment(SqlConnection cn, JsonObject body)
{
    var id = Sx(body, "id");
    if (id is null || !Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);
    var type = Sx(body, "type") ?? "";
    if (!Wr.AttachTypes.Contains(type)) return Results.Json(new { error = "bad type" }, statusCode: 400);

    byte[] bytes;
    try { bytes = Convert.FromBase64String(Sx(body, "data") ?? ""); }
    catch { return Results.Json(new { error = "bad data" }, statusCode: 400); }
    if (bytes.Length == 0) return Results.Json(new { error = "empty" }, statusCode: 400);
    if (bytes.Length > Wr.AttachMaxBytes)
        return Results.Json(new { error = "too large", limit = Wr.AttachMaxBytes, size = bytes.Length }, statusCode: 400);

    /* ⚠ 落檔是**覆寫**不是新建。少了這道守衛，帶著別站既有的附件 id 上傳，
       就能把該站的簽單照片內容整個換掉，而描述資料（檔名、大小、上傳日）不變
       ——畫面上完全看不出來，對成控稽核等同證據遭竄改且無痕跡。 */
    var site = Sx(body, "site");
    if (await AttachSiteMismatch(cn, id, site))
        return Results.Json(new { error = "forbidden", message = "此附件不屬於指定工地" }, statusCode: 403);

    // 先落檔。描述資料的那一列由後續的 op:record 建立（前端是「先上傳、再存單」），
    // 所以這裡**不碰資料表**——此時還不知道它要掛在哪一張單下。
    await File.WriteAllBytesAsync(Path.Combine(AttachDir(), id), bytes);

    // 若這個 id 的描述資料已經存在（重新上傳同一附件），順手把 file_path 補上
    await Exec(cn, null, "UPDATE dbo.attachments SET file_path = @p WHERE attachment_id = @id",
        ("@p", id), ("@id", id));

    return Results.Json(new { ok = true, id, size = bytes.Length });
}

/* ---------- §3.7 op:deleteAttachment（冪等） ---------- */
static async Task<IResult> OpDeleteAttachment(SqlConnection cn, JsonObject body)
{
    var id = Sx(body, "id");
    if (id is null || !Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);

    /* 描述資料還在的話，先確認它屬於宣告的工地——否則帶著別站的附件 id
       就能連檔案帶描述資料一起刪掉，而且交易正常提交、不報任何錯。 */
    var site = Sx(body, "site");
    if (await AttachSiteMismatch(cn, id, site))
        return Results.Json(new { error = "forbidden", message = "此附件不屬於指定工地" }, statusCode: 403);

    /* ⚠ 過了上面那道之後，這裡**不可依賴描述資料那一列還在**才刪檔。
       前端的順序是「先存單（被移除的附件當下就從資料表消失）、再呼叫本 op」，
       若要先查表才刪檔，那些檔案會全部變成孤兒永遠留在磁碟上。 */
    var path = Path.Combine(AttachDir(), id);
    if (File.Exists(path)) File.Delete(path);
    await Exec(cn, null, "DELETE FROM dbo.attachments WHERE attachment_id = @id", ("@id", id));
    return Results.Json(new { ok = true });
}

/* ==========================================================================
   工地納管（v23.3；合約 §2.5／§3.11／§4.11）

   要解決的問題：新工地要人工做三件事（加清單、建名單池、填 project_code），
   而第三項漏做**不會報錯**，只會讓該站除了管理員以外沒人看得到——最難察覺。

   ⚠ **刻意不做全自動同步**：ERP 權限檢視表涵蓋約 317 個專案，本系統只需十餘個。
     全自動會把大量無關專案灌進工地選單，反而製造新的整理工作。
   ⚠ 工程師姓名取自權限檢視表的 UserName，**不需要人資 API**——
     人資 API 只能以 AD 帳號單筆查詢，列不出整個專案的成員。
   ========================================================================== */

/* 取某專案的工地角色人員（工程師／主任）。回 (姓名清單, 工程師數, 主任數)。

   ⚠ **人數以「人」為單位、不是以列為單位**：同一人在同一專案可能同時掛
     工程師與主任兩個角色（實務上很常見）。若逐列累加，3 個人會顯示成 4 人次，
     而實際帶進人員池的又是去重後的 3 人——兩個數字對不起來，
     管理員正是看這個數字判斷「這個專案規模對不對、要不要納管」。
     一人同時具兩種角色時**歸為主任**（較高者），確保 engineers + leads = 實際人數。 */
static async Task<(List<string> names, int engineers, int leads)> ErpProjectPeople(
    SqlConnection erp, AuthOptions opt, string projectCode)
{
    var eng = opt.SiteUserRoles.Concat(opt.SiteLeadRoles).ToArray();
    var ps = string.Join(",", eng.Select((_, i) => "@r" + i));
    await using var cmd = new SqlCommand(
        $@"SELECT DISTINCT LTRIM(RTRIM(UserName)) AS nm, LTRIM(RTRIM(RoleName)) AS rn
           FROM BI.dbo.vw_Acumatica_Permission
           WHERE LTRIM(RTRIM(ProjectID)) = @p AND LTRIM(RTRIM(RoleName)) IN ({ps})", erp);
    cmd.Parameters.AddWithValue("@p", projectCode);
    for (var i = 0; i < eng.Length; i++) cmd.Parameters.AddWithValue("@r" + i, eng[i]);

    var lead = new HashSet<string>(opt.SiteLeadRoles, StringComparer.OrdinalIgnoreCase);
    var isLead = new Dictionary<string, bool>(StringComparer.Ordinal);   // 姓名 → 是否為主任
    var names = new List<string>();
    await using var rd = await cmd.ExecuteReaderAsync();
    while (await rd.ReadAsync())
    {
        var nm = rd.IsDBNull(0) ? "" : rd.GetString(0);
        if (string.IsNullOrWhiteSpace(nm)) continue;
        if (!isLead.ContainsKey(nm)) { isLead[nm] = false; names.Add(nm); }
        if (lead.Contains(rd.GetString(1))) isLead[nm] = true;
    }
    var l = isLead.Values.Count(x => x);
    return (names, isLead.Count - l, l);
}

static async Task<IResult> GetCandidates(SqlConnection cn, Func<SqlConnection>? erpDb, AuthOptions opt)
{
    if (erpDb is null)
        // 不是錯誤：雲端本來就沒有 ERP 連線。回空清單＋原因，讓畫面能說明而不是顯示失敗
        return Results.Json(new { candidates = Array.Empty<object>(),
            reason = "此環境未設定 ERP 權限檢視表連線（KGAUDIT_ERP_CONNECTION），無法列出候選工地" });

    // 已被使用的專案代碼——在應用程式端相減，因為兩者在不同連線／資料庫
    var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var r in await Query(cn, "SELECT project_code FROM dbo.sites WHERE project_code IS NOT NULL"))
        if (Str(r["project_code"]) is string pc && pc.Trim().Length > 0) used.Add(pc.Trim());

    var roles = opt.SiteUserRoles.Concat(opt.SiteLeadRoles).ToArray();
    var ps = string.Join(",", roles.Select((_, i) => "@r" + i));
    var leadSet = new HashSet<string>(opt.SiteLeadRoles, StringComparer.OrdinalIgnoreCase);

    /* ⚠ **一次查完，不可逐專案再查**。
       改版前是先 GROUP BY 取得專案清單、再對每個候選專案各查一次人員——
       ERP 權限檢視表約 10 萬列／317 個專案，等於管理員每按一次「重新比對」
       就對**共用的正式 ERP** 連發數百次串行查詢。這裡改成一次取回
       (專案, 姓名, 角色) 三元組，在應用程式端分組。 */
    var byProject = new Dictionary<string, (string name, Dictionary<string, bool> people)>(StringComparer.OrdinalIgnoreCase);
    await using (var erp = erpDb())
    {
        await erp.OpenAsync();
        await using var cmd = new SqlCommand(
            $@"SELECT DISTINCT LTRIM(RTRIM(ProjectID))   AS pid,
                               LTRIM(RTRIM(ProjectName)) AS pname,
                               LTRIM(RTRIM(UserName))    AS nm,
                               LTRIM(RTRIM(RoleName))    AS rn
               FROM BI.dbo.vw_Acumatica_Permission
               WHERE LTRIM(RTRIM(RoleName)) IN ({ps})", erp);
        for (var i = 0; i < roles.Length; i++) cmd.Parameters.AddWithValue("@r" + i, roles[i]);

        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            var pid = rd.GetString(0);
            if (used.Contains(pid)) continue;              // 已納管的不再列出
            var nm = rd.IsDBNull(2) ? "" : rd.GetString(2);
            if (string.IsNullOrWhiteSpace(nm)) continue;
            if (!byProject.TryGetValue(pid, out var slot))
                byProject[pid] = slot = (rd.IsDBNull(1) ? "" : rd.GetString(1),
                                         new Dictionary<string, bool>(StringComparer.Ordinal));
            if (!slot.people.ContainsKey(nm)) slot.people[nm] = false;
            if (leadSet.Contains(rd.GetString(3))) slot.people[nm] = true;   // 兼任者歸主任
        }
    }

    // 人數多的排前面——管理員通常先看規模較大的專案
    var list = new JsonArray();
    foreach (var kv in byProject.OrderByDescending(x => x.Value.people.Count))
    {
        var leads = kv.Value.people.Values.Count(x => x);
        list.Add(new JsonObject
        {
            ["projectCode"] = kv.Key, ["projectName"] = kv.Value.name,
            ["engineers"] = kv.Value.people.Count - leads, ["leads"] = leads
        });
    }
    return Results.Content(new JsonObject { ["candidates"] = list }.ToJsonString(Wr.JsonOpts),
        "application/json; charset=utf-8");
}

/* ---------- §3.11 op:adoptSite ---------- */
static async Task<IResult> OpAdoptSite(SqlConnection cn, JsonObject body, Func<SqlConnection>? erpDb, AuthOptions opt)
{
    if (erpDb is null)
        /* ⚠ 這是寫入操作，**必須回 501 而不是 200**——前端的 await-first 紀律
           會把 200 當成寫入成功而清掉畫面狀態。 */
        return Results.Json(new { error = "not implemented",
            message = "此環境未設定 ERP 連線，無法納管工地" }, statusCode: 501);

    /* 權限模式關閉時無從判斷誰是管理者——與 §2.5 候選清單同一理由，
       不可讓「建立工地並寫入專案代碼」這種設定級操作在無身分下執行 */
    if (opt.Mode == AuthMode.Off)
        return Results.Json(new { error = "forbidden",
            message = "工地納管需啟用權限模式（Auth:Mode 不可為 Off）" }, statusCode: 403);

    var code = Sx(body, "projectCode");
    var site = Sx(body, "site");
    if (code is null || site is null)
        return Results.Json(new { error = "projectCode/site required" }, statusCode: 400);
    /* 長度先擋，讓使用者看到「名稱過長」而不是資料庫截斷造成的 500。
       欄位定義：sites.name NVARCHAR(100)、sites.project_code VARCHAR(10) */
    if (site.Length > 100)
        return Results.Json(new { error = "site too long",
            message = $"工地名稱最多 100 字，目前 {site.Length} 字" }, statusCode: 400);
    if (code.Length > 10)
        return Results.Json(new { error = "projectCode too long",
            message = $"專案代碼最多 10 字，目前 {code.Length} 字" }, statusCode: 400);

    // 一個專案代碼只能對應一個工地——重複對映會讓權限判定把兩站混在一起
    var dup = await Scalar(cn, null,
        "SELECT name FROM dbo.sites WHERE project_code = @c AND name <> @n", ("@c", code), ("@n", site));
    if (dup is not null)
        return Results.Json(new { error = "conflict",
            message = $"專案代碼 {code} 已對映到工地「{dup}」" }, statusCode: 409);

    List<string> names;
    await using (var erp = erpDb())
    {
        await erp.OpenAsync();
        (names, _, _) = await ErpProjectPeople(erp, opt, code);
    }

    /* 三件事在同一交易：建站、填 project_code、併入人員池。
       分開做就會出現「建了站但 project_code 沒填」——正是這個功能要根除的狀況。 */
    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    var sid = await SiteId(cn, tx, site);
    await Exec(cn, tx, "UPDATE dbo.sites SET project_code = @c, is_active = 1 WHERE site_id = @s",
        ("@c", code), ("@s", sid));

    // 人員池**併入不覆蓋**：既有名單保留，只補尚未存在的（大小寫視為同值，比照 op:addOption）
    var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    await using (var read = Cmd(cn, tx, "SELECT value FROM dbo.site_options WHERE site_id=@s AND pool='people'", ("@s", sid)))
    await using (var rd = await read.ExecuteReaderAsync())
        while (await rd.ReadAsync()) have.Add(rd.GetString(0));

    var added = 0;
    foreach (var nm in names)
    {
        if (!have.Add(nm)) continue;
        await Exec(cn, tx, "INSERT INTO dbo.site_options (site_id, pool, value) VALUES (@s,'people',@v)",
            ("@s", sid), ("@v", Trunc(nm, 100)));
        added++;
    }
    await tx.CommitAsync();
    return Results.Json(new { ok = true, site, projectCode = code, peopleAdded = added });
}

/* ---------- §2.4 GET ?rates=1 ---------- */
static async Task<IResult> GetRates(SqlConnection cn)
{
    var books = await Query(cn,
        "SELECT rate_book_id, kind, label, effective_from, imported_at FROM dbo.rate_books ORDER BY effective_from DESC");
    var rows = await Query(cn, "SELECT * FROM dbo.rate_book_rows ORDER BY rate_row_id");
    var byBook = rows.ToLookup(r => Convert.ToInt32(r["rate_book_id"]));

    var outp = new JsonObject { ["labor"] = new JsonArray(), ["equipment"] = new JsonArray() };
    foreach (var b in books)
    {
        var kind = (string)b["kind"]!;
        var arr = new JsonArray();
        foreach (var r in byBook[Convert.ToInt32(b["rate_book_id"])])
        {
            var o = new JsonObject
            {
                ["vendorCode"] = Str(r["vendor_code"]),
                ["vendorName"] = Str(r["vendor_name"]),
                ["region"] = Str(r["region"]) ?? "",
                ["note"] = Str(r["note"]) ?? "",
                ["item"] = Str(r["item"]),
                ["unit"] = Str(r["unit"]) ?? "",
                ["price"] = Num(r["price"])
            };
            // 兩種 kind 的專有欄位只在該 kind 出現——多送一堆 null 會讓前端的
            // 「有沒有這個欄位」判斷失準
            if (kind == "labor")
            {
                o["work"] = Num(r["work"]);
                o["ot2"] = Num(r["ot2"]);
                o["otOver"] = Num(r["ot_over"]);
                o["otParsed"] = Bit(r["ot_parsed"]);
            }
            else o["chargeType"] = Str(r["charge_type"]) ?? "";
            arr.Add(o);
        }
        ((JsonArray)outp[kind]!).Add(new JsonObject
        {
            ["label"] = Str(b["label"]),
            ["effectiveFrom"] = DateStr(b["effective_from"]),
            ["importedAt"] = DateStr(b["imported_at"]),
            ["rows"] = arr
        });
    }
    return Results.Content(outp.ToJsonString(Wr.JsonOpts), "application/json; charset=utf-8");
}

/* ---------- §3.9 op:rateBook ---------- */
static async Task<IResult> OpRateBook(SqlConnection cn, JsonObject body)
{
    var kind = Sx(body, "kind");
    if (kind != "labor" && kind != "equipment") return Results.Json(new { error = "bad kind" }, statusCode: 400);
    var eff = Sx(body, "effectiveFrom");
    if (eff is null || !DateTime.TryParseExact(eff, "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out _))
        return Results.Json(new { error = "bad effectiveFrom" }, statusCode: 400);
    if (body["rows"] is not JsonArray rows || rows.Count == 0)
        return Results.Json(new { error = "rows required" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();

    // 以 effectiveFrom 為鍵整季覆蓋：同生效日重匯即取代（可重複匯入修正檔）
    await Exec(cn, tx, "DELETE FROM dbo.rate_books WHERE kind = @k AND effective_from = @e",
        ("@k", kind), ("@e", eff));

    var bookId = Convert.ToInt32(await Scalar(cn, tx,
        @"INSERT INTO dbo.rate_books (kind, label, effective_from, imported_at)
          OUTPUT INSERTED.rate_book_id VALUES (@k, @l, @e, @i)",
        ("@k", kind), ("@l", Trunc(Sx(body, "label") ?? eff, 40)), ("@e", eff),
        ("@i", DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture))));

    var kept = 0;
    foreach (var r in rows)
    {
        var code = Sx(r, "vendorCode");
        var item = Sx(r, "item");
        var price = Dx(r, "price");
        // 匯入時就濾掉沒有單價的列：0 會在計價時被讀成「免費」，
        // 而不是「這一項沒有報價」——後者必須讓使用者看到原因（合約 §4.9）
        if (code is null || item is null || price is null || price <= 0) continue;
        await Exec(cn, tx,
            @"INSERT INTO dbo.rate_book_rows (rate_book_id, vendor_code, vendor_name, region, note,
                  item, unit, price, work, ot2, ot_over, ot_parsed, charge_type)
              VALUES (@b,@vc,@vn,@rg,@nt,@it,@un,@pr,@wk,@o2,@oo,@op,@ct)",
            ("@b", bookId), ("@vc", Trunc(code, 40)), ("@vn", Trunc(Sx(r, "vendorName") ?? code, 200)),
            ("@rg", Sx(r, "region")), ("@nt", Sx(r, "note")), ("@it", Trunc(item, 400)),
            ("@un", Sx(r, "unit")), ("@pr", price),
            ("@wk", kind == "labor" ? Dx(r, "work") : null),
            ("@o2", kind == "labor" ? Dx(r, "ot2") : null),
            ("@oo", kind == "labor" ? Dx(r, "otOver") : null),
            ("@op", kind == "labor" ? (object)Bx(r, "otParsed") : null),
            ("@ct", kind == "equipment" ? Sx(r, "chargeType") : null));
        kept++;
    }

    // 每個 kind 最多留 RATE_BOOK_MAX 季，超過丟最舊的（rows 有 ON DELETE CASCADE）
    var dropped = await Exec(cn, tx,
        @"DELETE FROM dbo.rate_books WHERE rate_book_id IN (
              SELECT rate_book_id FROM dbo.rate_books WHERE kind = @k
              ORDER BY effective_from DESC OFFSET @max ROWS)",
        ("@k", kind), ("@max", Wr.RateBookMax));

    var brief = await BookBrief(cn, tx, kind);
    await tx.CommitAsync();
    return Results.Json(new { ok = true, kind, books = brief, dropped, rowCount = kept });
}

/* ---------- §3.10 op:deleteRateBook（冪等） ---------- */
static async Task<IResult> OpDeleteRateBook(SqlConnection cn, JsonObject body)
{
    var kind = Sx(body, "kind");
    if (kind != "labor" && kind != "equipment") return Results.Json(new { error = "bad kind" }, statusCode: 400);
    var eff = Sx(body, "effectiveFrom");
    if (eff is null) return Results.Json(new { error = "effectiveFrom required" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    await Exec(cn, tx, "DELETE FROM dbo.rate_books WHERE kind = @k AND effective_from = @e",
        ("@k", kind), ("@e", eff));
    var brief = await BookBrief(cn, tx, kind);
    await tx.CommitAsync();
    return Results.Json(new { ok = true, books = brief });
}

static async Task<List<object>> BookBrief(SqlConnection cn, SqlTransaction tx, string kind)
{
    var list = new List<object>();
    await using var c = Cmd(cn, tx,
        @"SELECT b.label, b.effective_from, b.imported_at,
                 (SELECT COUNT(*) FROM dbo.rate_book_rows r WHERE r.rate_book_id = b.rate_book_id) AS n
          FROM dbo.rate_books b WHERE b.kind = @k ORDER BY b.effective_from DESC", ("@k", kind));
    await using var rd = await c.ExecuteReaderAsync();
    while (await rd.ReadAsync())
        list.Add(new
        {
            label = rd.GetString(0),
            effectiveFrom = rd.GetDateTime(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            importedAt = rd.GetDateTime(2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            rowCount = rd.GetInt32(3)
        });
    return list;
}

/* ---------- §3.8 op:clearSite / op:clearAll（危險操作） ----------
   權限：階段 D 起已列入 Wr.OpScopes 的 Admin 範圍，**Auth:Mode≠Off 時限系統管理者**
   ——這正是安審遺留的「破壞性操作無伺服器端權限分級」。
   Auth:Mode=Off（預設／過渡期）時仍與雲端一致由整站 Basic Auth 把守。 */
static async Task<IResult> OpClear(SqlConnection cn, JsonObject body, bool all)
{
    var site = Sx(body, "site");
    if (!all && site is null) return Results.Json(new { error = "site required" }, statusCode: 400);

    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync();
    var where = all ? "" : " WHERE r.site_id = @s";
    var p = all ? Array.Empty<(string, object?)>() : new (string, object?)[] { ("@s", await SiteId(cn, tx, site!)) };

    // 先收集要刪的附件檔名，交易提交後才動磁碟——交易若回滾，檔案不該已經沒了
    var files = new List<string>();
    await using (var c = Cmd(cn, tx,
        all ? "SELECT file_path FROM dbo.attachments WHERE file_path IS NOT NULL"
            : "SELECT file_path FROM dbo.attachments WHERE site_id = @s AND file_path IS NOT NULL", p))
    await using (var rd = await c.ExecuteReaderAsync())
        while (await rd.ReadAsync()) files.Add(rd.GetString(0));

    var deleted = 0;
    foreach (var (recT, repT, childT, audT, agentT) in new[]
             {
                 ("labor_records", "labor_reports", "labor_report_worktypes", "labor_audits", "labor_agent_items"),
                 ("equip_records", "equip_reports", "equip_report_usage", "equip_audits", "equip_agent_items")
             })
    {
        foreach (var t in new[] { audT, childT, agentT, repT })
            await Exec(cn, tx, $"DELETE FROM dbo.{t} WHERE record_id IN (SELECT r.id FROM dbo.{recT} r{where})", p);
        deleted += await Exec(cn, tx, $"DELETE FROM r FROM dbo.{recT} r{where}", p);
    }
    await Exec(cn, tx, all ? "DELETE FROM dbo.attachments" : "DELETE FROM dbo.attachments WHERE site_id = @s", p);

    /* clearSite 到此為止——合約明訂**不含 config**（名單池與鎖單日留著）。
       clearAll 則是整庫清空：雲端版是「列出 store 裡所有 blob 全刪」，
       包含 master、各站 cfg2 與費率書，這裡必須刪到一樣的範圍，
       否則地端清完還留著工地清單與名單池，兩邊行為不一致。 */
    if (all)
    {
        foreach (var t in new[] { "rate_book_rows", "rate_books", "site_rate_bindings", "site_options", "sites" })
            deleted += await Exec(cn, tx, $"DELETE FROM dbo.{t}", Array.Empty<(string, object?)>());
    }
    await tx.CommitAsync();

    foreach (var f in files)
    {
        var path = Path.Combine(AttachDir(), f);
        if (File.Exists(path)) File.Delete(path);
    }
    return Results.Json(new { ok = true, deleted });
}


/* top-level statements 不能宣告靜態欄位，常數集中放這個類別 */
static class Wr
{
    public static readonly System.Text.RegularExpressions.Regex IdRe =
        new("^[A-Za-z0-9_-]{1,64}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /* pool 白名單的正準定義在 docs/API-CONTRACT.md §3.4，本處為複本——增減先改合約 */
    public static readonly string[] Pools =
        { "vendors", "locations", "categories", "equipTypes", "people", "workers", "laborTypes" };

    /* v15.1：回報覆核限一位工程師代表，名單源頭就堵住多人並列 */
    public static readonly System.Text.RegularExpressions.Regex PersonSplit =
        new(@"[+＋/／\\、,，;；:：\s]", System.Text.RegularExpressions.RegexOptions.Compiled);

    /* status_at_audit 欄位有 CHECK 值域限制，只接受這兩個值 */
    public static readonly string[] Statuses = { "待回報", "已回報" };

    /* 附件型別白名單與大小上限的正準定義在 docs/API-CONTRACT.md §3.6 */
    public static readonly string[] AttachTypes =
        { "image/jpeg", "image/png", "image/webp", "application/pdf" };
    public const int AttachMaxBytes = 4 * 1024 * 1024;

    /* 每個 kind 最多保留幾季（合約 §3.9）：三年 */
    public const int RateBookMax = 12;

    /* op → 所需權限範圍。**新增 op 一定要在這裡登記**，否則會被判為 Deny。
       Admin＝全域設定與破壞性操作；Site＝需對 body 的 site 有權限。 */
    public static readonly IReadOnlyDictionary<string, OpScope> OpScopes =
        new Dictionary<string, OpScope>(StringComparer.Ordinal)
        {
            ["master"] = OpScope.Admin,
            ["config"] = OpScope.Admin,
            ["clearSite"] = OpScope.Admin,
            ["clearAll"] = OpScope.Admin,
            ["rateBook"] = OpScope.Admin,
            ["deleteRateBook"] = OpScope.Admin,
            ["record"] = OpScope.Site,
            ["addOption"] = OpScope.Site,
            ["deleteRecord"] = OpScope.Site,
            ["uploadAttachment"] = OpScope.Site,
            ["deleteAttachment"] = OpScope.Site,
            ["adoptSite"] = OpScope.Admin      // v23.3：建站＋填 project_code，限管理者
        };

    /* 簽單繳回日的期限天數（合約 §4.7，與前端常數 SIGN_RETURN_MAX_DAYS 同值） */
    public const int SignReturnMaxDays = 20;

    /* app_settings 的鍵名（v23.2）。Auth.cs 也讀同一把鍵——**改這裡就好，勿各寫一份** */
    public const string AdminDeptKey = "admin_departments";

    /* JSON 輸出設定（v23.2）。
       .NET 的預設編碼器會把所有非 ASCII 逃脫成 \uXXXX——功能上沒錯（JSON 合法、
       前端 JSON.parse 照樣讀得到），但有兩個實際代價：
         ① 正式資料的 scope=all 實測 905KB → 1,077KB，**每次開站多 168KB（+19%）**
         ② 雲端 api.mjs 用 JS 的 JSON.stringify、不逃脫，兩份實作的輸出格式因此不一致；
            資料庫裡的中文也會存成一整片 \uXXXX，資訊處打開表根本讀不出來
       改用 UnsafeRelaxedJsonEscaping：名稱裡的 Unsafe 指的是「不對 HTML 敏感字元
       做額外逃脫」，本 API 一律以 application/json 回應、不把回應嵌進 HTML，
       前端插入 DOM 前也一律走 esc()，故不適用該風險。 */
    public static readonly System.Text.Json.JsonSerializerOptions JsonOpts = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    /* 附件根目錄，**程序生命期內只解析一次**。
       原本每次呼叫 AttachDir() 都做一次 Path.GetFullPath ＋ Directory.CreateDirectory
       系統呼叫，而它被放在逐筆附件的迴圈裡（SyncAttachments 在 op:record 的交易之中），
       等於在持有 UPDLOCK／HOLDLOCK 的臨界區內做多餘的檔案系統 I/O，拉長鎖定時間、
       墊高並發下的等待。目錄在執行期間不會改變，沒有重算的理由。 */
    public static readonly string AttachRoot = InitAttachRoot();

    static string InitAttachRoot()
    {
        var dir = Environment.GetEnvironmentVariable("ATTACH_DIR")
            ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "data", "attachments");
        dir = Path.GetFullPath(dir);
        Directory.CreateDirectory(dir);
        return dir;
    }
}

/* op 的權限範圍。Deny 是預設值——沒登記就是拒絕，不是放行。 */
enum OpScope { Deny, Admin, Site }

/* 合約 §2.3 明訂附件下載要 inline＋UTF-8 檔名，Results.Bytes 沒辦法自訂
   Content-Disposition 的 filename*，所以自己寫一個 IResult。 */
sealed class AttachmentResult(byte[] bytes, string type, string name) : IResult
{
    public async Task ExecuteAsync(HttpContext ctx)
    {
        ctx.Response.ContentType = type;
        ctx.Response.ContentLength = bytes.Length;
        // 附件內容不可變（同 id 不會被改寫成不同內容），可安心長快取
        ctx.Response.Headers.CacheControl = "private, max-age=86400";
        ctx.Response.Headers.ContentDisposition =
            "inline; filename*=UTF-8''" + Uri.EscapeDataString(name);
        await ctx.Response.Body.WriteAsync(bytes);
    }
}
