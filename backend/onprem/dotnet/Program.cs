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
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using KgAudit.Api;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);

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

// 日期一律輸出本地日期字串（合約：YYYY-MM-DD）。**不可經 UTC 轉換**——
// UTC 會把台灣早上記成前一天，直接改變計價月份歸屬（計價紅線 2）。
static string? DateStr(object? v) => v is null or DBNull ? null : ((DateTime)v).ToString("yyyy-MM-dd");

// updatedAt：帶時區位移的 ISO 8601。資料庫存的是本地時間，若當成 UTC 輸出會整整差 8 小時。
static string? StampStr(object? v) => v is null or DBNull
    ? null
    : new DateTimeOffset((DateTime)v, TimeZoneInfo.Local.GetUtcOffset((DateTime)v)).ToString("yyyy-MM-ddTHH:mm:sszzz");

static async Task<List<Dictionary<string, object?>>> Query(SqlConnection cn, string sql, params (string, object?)[] ps)
{
    var rows = new List<Dictionary<string, object?>>();
    await using var cmd = new SqlCommand(sql, cn);
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

    var eq = await Query(cn, $"SELECT r.* FROM dbo.equip_records r JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var eqRep = await Query(cn, $"SELECT rp.* FROM dbo.equip_reports rp JOIN dbo.equip_records r ON r.id=rp.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter}", p);
    var eqUse = await Query(cn, $"SELECT u.* FROM dbo.equip_report_usage u JOIN dbo.equip_records r ON r.id=u.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY u.usage_row_id", p);
    var eqAud = await Query(cn, $"SELECT a.* FROM dbo.equip_audits a JOIN dbo.equip_records r ON r.id=a.record_id JOIN dbo.sites s ON s.site_id=r.site_id{siteFilter} ORDER BY a.audited_at", p);

    var atts = await Query(cn, $"SELECT a.* FROM dbo.attachments a JOIN dbo.sites s ON s.site_id=a.site_id{siteFilter}", p);
    var attsByParent = atts.ToLookup(a => (string)a["parent_id"]!);

    var repById = labRep.ToDictionary(r => (string)r["record_id"]!);
    var wtBy = labWt.ToLookup(w => (string)w["record_id"]!);
    var labAudBy = labAud.ToLookup(a => (string)a["record_id"]!);
    var eqRepById = eqRep.ToDictionary(r => (string)r["record_id"]!);
    var useBy = eqUse.ToLookup(u => (string)u["record_id"]!);
    var eqAudBy = eqAud.ToLookup(a => (string)a["record_id"]!);

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
                    ["conclusion"] = Str(rp["conclusion"]) ?? ""
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
                    ["signReturnDate"] = DateStr(rp["sign_return_date"]) ?? ""
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
IEmployeeDirectory directory = new ConfigEmployeeDirectory(authOpt);
var authorizer = new Authorizer(authOpt, () => new SqlConnection(ConnStr()), erpDb);

if (authOpt.Mode != AuthMode.Off)
{
    if (authOpt.Mode == AuthMode.Dev)
        app.Logger.LogWarning("Auth:Mode=Dev —— 身分由 X-Dev-User 標頭指定，**正式環境絕不可使用**");

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
        if (authz is null) { await Deny(ctx, 403, "您在 ERP 尚無任何專案權限，請洽成本管理部"); return; }

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
    await ctx.Response.WriteAsync(new JsonObject { ["error"] = "forbidden", ["message"] = message }.ToJsonString());
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

    // 合約 §2.3：附件下載（回二進位，不是 JSON）
    if (q.ContainsKey("attachment")) return await GetAttachment(cn, q["site"].ToString(), q["attachment"].ToString());

    // 合約 §2.4：費率書。**刻意不放進 scope=all**——一季 1,500 列會拖慢每個人開站
    if (q.ContainsKey("rates")) return await GetRates(cn);

    var az = ctx.Items["authz"] as Authz;

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
        return Results.Content(first.ToJsonString(), "application/json; charset=utf-8");
    }

    // 合約 §2.1：{ master, stores }。master.sites 只列 is_active=1（退場專案保留歷史但不上線）
    var siteRows = await Query(cn, "SELECT name FROM dbo.sites WHERE is_active = 1 ORDER BY sort_order");
    var visible = siteRows.Select(s => (string)s["name"]!).Where(n => az is null || az.CanSee(n)).ToArray();
    var master = new JsonObject
    {
        ["sites"] = new JsonArray(visible.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray())
    };
    var stores = await ReadStores(cn, null);
    if (az is not null)
    {
        // master.sites 與 stores 必須同步過濾：只濾清單而 stores 照給，
        // 等於資料還是送到瀏覽器了，那是「看起來隔離」而不是隔離。
        foreach (var k in stores.Select(kv => kv.Key).Where(k => !az.CanSee(k)).ToList()) stores.Remove(k);
        foreach (var kv in stores) StripAudits(kv.Value, az);
    }
    var payload = new JsonObject { ["master"] = master, ["stores"] = stores };
    return Results.Content(payload.ToJsonString(), "application/json; charset=utf-8");
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
       ⚠ 只靠前端隱藏按鈕不算數——直接 POST 就繞過去了。 */
    if (ctx.Items["authz"] is Authz az)
    {
        // 全域設定與破壞性操作限系統管理者，一併解決「伺服器端無權限分級」的安審遺留
        if (op is "master" or "config" or "clearSite" or "clearAll" or "rateBook" or "deleteRateBook" && !az.IsAdmin)
            return Results.Json(new { error = "forbidden", message = "此操作限系統管理者" }, statusCode: 403);

        // 其餘與單一工地相關的操作：檢查該站是否在權限內
        var target = Sx(body, "site");
        if (target is not null && !az.CanSee(target))
            return Results.Json(new { error = "forbidden", message = "您沒有這個工地的權限" }, statusCode: 403);
    }

    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();

    switch (op)
    {
        case "master": return await OpMaster(cn, body);
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

        default: return Results.Json(new { error = "unknown op" }, statusCode: 400);
    }
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
    return v.GetValueKind() == JsonValueKind.String && decimal.TryParse(v.GetValue<string>(), out var d) ? d : null;
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
    var (recT, repT, childT, childCol, audT, attKind) = kind == "labor"
        ? ("labor_records", "labor_reports", "labor_report_worktypes", "record_id", "labor_audits", "labor_audit")
        : ("equip_records", "equip_reports", "equip_report_usage", "record_id", "equip_audits", "equip_audit");

    await Exec(cn, tx,
        $@"DELETE FROM dbo.attachments
           WHERE site_id=@s AND ((parent_kind=@pk AND parent_id=@id)
              OR (parent_kind=@ak AND parent_id IN (SELECT audit_id FROM dbo.{audT} WHERE record_id=@id)))",
        ("@s", sid), ("@pk", kind), ("@id", id), ("@ak", attKind));
    await Exec(cn, tx, $"DELETE FROM dbo.{audT} WHERE record_id=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{childT} WHERE {childCol}=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{repT} WHERE record_id=@id", ("@id", id));
    await Exec(cn, tx, $"DELETE FROM dbo.{recT} WHERE id=@id AND site_id=@s", ("@id", id), ("@s", sid));
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

    /* 整段包在一個交易裡。UPDLOCK+HOLDLOCK 讓「讀版本 → 比對 → 覆寫」成為
       不可分割的臨界區：兩人同時送出時後者會等前者提交，讀到新的 v 而正確吃到 409。
       若只做 SELECT 再 UPDATE，兩人可能都讀到舊 v 而雙雙寫入——409 就形同虛設。 */
    await using var tx = (SqlTransaction)await cn.BeginTransactionAsync(IsolationLevel.ReadCommitted);
    var sid = await SiteId(cn, tx, site);
    var curV = await Scalar(cn, tx,
        $"SELECT v FROM dbo.{recT} WITH (UPDLOCK, HOLDLOCK) WHERE id=@id AND site_id=@s", ("@id", id), ("@s", sid));

    // 合約 §3.3：版本不符→modified；紀錄不存在但宣告基準>0→deleted。語意不可改。
    if (curV is null)
    {
        if (baseV > 0)
        {
            await tx.RollbackAsync();
            return Results.Json(new { error = "conflict", reason = "deleted" }, statusCode: 409);
        }
    }
    else if (Convert.ToInt32(curV) != baseV)
    {
        await tx.RollbackAsync();
        return Results.Json(new { error = "conflict", reason = "modified" }, statusCode: 409);
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
static string AttachDir()
{
    var dir = Environment.GetEnvironmentVariable("ATTACH_DIR")
        ?? Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "data", "attachments");
    dir = Path.GetFullPath(dir);
    Directory.CreateDirectory(dir);
    return dir;
}

static async Task<IResult> GetAttachment(SqlConnection cn, string site, string id)
{
    if (!Wr.IdRe.IsMatch(id)) return Results.Json(new { error = "bad id" }, statusCode: 400);
    var rows = await Query(cn,
        @"SELECT a.name, a.content_type, a.file_path FROM dbo.attachments a
          JOIN dbo.sites s ON s.site_id = a.site_id
          WHERE a.attachment_id = @id AND (@site = '' OR s.name = @site)",
        ("@id", id), ("@site", site ?? ""));
    if (rows.Count == 0) return Results.Json(new { error = "not found" }, statusCode: 404);

    var r = rows[0];
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

    /* ⚠ 只憑 id 刪實體檔案，**不可依賴描述資料那一列還在**。
       前端的順序是「先存單（被移除的附件當下就從資料表消失）、再呼叫本 op」，
       若這裡要先查表才刪檔，那些檔案會全部變成孤兒永遠留在磁碟上。 */
    var path = Path.Combine(AttachDir(), id);
    if (File.Exists(path)) File.Delete(path);
    await Exec(cn, null, "DELETE FROM dbo.attachments WHERE attachment_id = @id", ("@id", id));
    return Results.Json(new { ok = true });
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
    return Results.Content(outp.ToJsonString(), "application/json; charset=utf-8");
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
        ("@i", DateTime.Now.ToString("yyyy-MM-dd"))));

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
            effectiveFrom = rd.GetDateTime(1).ToString("yyyy-MM-dd"),
            importedAt = rd.GetDateTime(2).ToString("yyyy-MM-dd"),
            rowCount = rd.GetInt32(3)
        });
    return list;
}

/* ---------- §3.8 op:clearSite / op:clearAll（危險操作） ----------
   ⚠ 合約現行版本對這兩個 op **沒有伺服器端權限檢查**，這裡維持相同行為以求
     前後端一致。這是已知的安審遺留項（建議加 ADMIN_TOKEN 或併入階段 D 的
     SSO 權限），**尚待決策**——不在本階段單方面加，否則地端與雲端行為分歧，
     過渡期兩邊並行會出現「同一操作在雲端可以、在地端不行」。 */
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
    foreach (var (recT, repT, childT, audT) in new[]
             {
                 ("labor_records", "labor_reports", "labor_report_worktypes", "labor_audits"),
                 ("equip_records", "equip_reports", "equip_report_usage", "equip_audits")
             })
    {
        foreach (var t in new[] { audT, childT, repT })
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
}

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
