/* ==========================================================================
   點工機具稽核系統 — 地端 API（.NET 8 Minimal API）

   這是 docs/API-CONTRACT.md 的地端實作。前端（frontend/）完全不需修改，
   只要把 config.local.js 的 apiBase 指向本服務即可。

   ⚠ 合約是唯一權威：任何回應形狀的疑義以 docs/API-CONTRACT.md 為準，
     不可依這裡的實作反推。另有兩份可對照的實作：
       backend/cloud/functions/api.mjs（雲端現行版）
       backend/onprem/server.mjs（Node 參考版）

   目前進度：**階段 A** —— 唯讀端點
     ✅ GET /api/data?scope=all      全量讀取（開站／備份）        合約 §2.1
     ✅ GET /api/data?site=<工地>     單一工地（編輯前抓最新）      合約 §2.2
     ⬜ 階段 B：op:record（含 409 樂觀並發）、master、config、addOption
     ⬜ 階段 C：附件上下載、行情通報費率書
     ⬜ 階段 D：SSO／權限過濾（見 docs/AUTH-PLAN.md）

   尚未實作的操作一律回 501，**不可默默回 200**——前端的 await-first 紀律
   會把 200 當成寫入成功而清掉表單，資料就真的不見了。
   ========================================================================== */
using System.Data;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);
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

    // 尚未實作的讀取分支一律 501，不可回空資料裝作正常
    if (q.ContainsKey("attachment")) return Results.Json(new { error = "not implemented (階段 C)" }, statusCode: 501);
    if (q.ContainsKey("rates")) return Results.Json(new { error = "not implemented (階段 C)" }, statusCode: 501);

    var site = q["site"].ToString();
    if (!string.IsNullOrEmpty(site))
    {
        var one = await ReadStores(cn, site);
        // 合約 §2.2：單站回 { config, labor, equipment }（不含外層工地名）
        if (one.Count == 0) return Results.Json(new JsonObject { ["config"] = null, ["labor"] = new JsonArray(), ["equipment"] = new JsonArray() });
        var first = one.First().Value!;
        return Results.Content(first.ToJsonString(), "application/json; charset=utf-8");
    }

    // 合約 §2.1：{ master, stores }。master.sites 只列 is_active=1（退場專案保留歷史但不上線）
    var siteRows = await Query(cn, "SELECT name FROM dbo.sites WHERE is_active = 1 ORDER BY sort_order");
    var master = new JsonObject
    {
        ["sites"] = new JsonArray(siteRows.Select(s => (JsonNode)JsonValue.Create((string)s["name"]!)!).ToArray())
    };
    var stores = await ReadStores(cn, null);
    var payload = new JsonObject { ["master"] = master, ["stores"] = stores };
    return Results.Content(payload.ToJsonString(), "application/json; charset=utf-8");
});

// 寫入端點尚未實作（階段 B）。**必須明確回 501**：前端 await-first，
// 收到 2xx 就會清空表單，若這裡默默回 200 使用者的資料會直接消失。
app.MapPost("/api/data", () => Results.Json(
    new { error = "not implemented", reason = "寫入操作於階段 B 實作，詳見 docs/API-CONTRACT.md §3" },
    statusCode: 501));

app.MapGet("/health", async () =>
{
    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();
    var r = await Query(cn, "SELECT COUNT(*) AS n FROM dbo.sites");
    return Results.Json(new { ok = true, sites = Convert.ToInt32(r[0]["n"]) });
});

app.Run();
