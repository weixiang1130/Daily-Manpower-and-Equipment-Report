/* ==========================================================================
   點工機具稽核系統 — 地端 API（.NET 8 Minimal API）

   這是 docs/API-CONTRACT.md 的地端實作。前端（frontend/）完全不需修改，
   只要把 config.local.js 的 apiBase 指向本服務即可。

   ⚠ 合約是唯一權威：任何回應形狀的疑義以 docs/API-CONTRACT.md 為準，
     不可依這裡的實作反推。另有兩份可對照的實作：
       backend/cloud/functions/api.mjs（雲端現行版）
       backend/onprem/server.mjs（Node 參考版）

   目前進度：**階段 A＋B** —— 唯讀端點與寫入
     ✅ GET /api/data?scope=all      全量讀取（開站／備份）        合約 §2.1
     ✅ GET /api/data?site=<工地>     單一工地（編輯前抓最新）      合約 §2.2
     ✅ op:record（含 409 樂觀並發）                              合約 §3.3
     ✅ op:master / op:config / op:addOption / op:deleteRecord     合約 §3.1/§3.2/§3.4/§3.5
     ⬜ 階段 C：附件上下載、行情通報費率書                        合約 §3.6/§3.7/§3.9/§3.10/§3.8
     ⬜ 階段 D：SSO／權限過濾（見 docs/AUTH-PLAN.md）

   尚未實作的操作一律回 501，**不可默默回 200**——前端的 await-first 紀律
   會把 200 當成寫入成功而清掉表單，資料就真的不見了。
   ========================================================================== */
using System.Data;
using System.Text;
using System.Text.Json;
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
    await using var cn = new SqlConnection(ConnStr());
    await cn.OpenAsync();

    switch (op)
    {
        case "master": return await OpMaster(cn, body);
        case "config": return await OpConfig(cn, body);
        case "record": return await OpRecord(cn, body);
        case "addOption": return await OpAddOption(cn, body);
        case "deleteRecord": return await OpDeleteRecord(cn, body);

        // 階段 C／D 尚未實作。**必須明確回 501**：前端 await-first，
        // 收到 2xx 就會清空表單，若這裡默默回 200 使用者的資料會直接消失。
        case "uploadAttachment":
        case "deleteAttachment":
        case "rateBook":
        case "deleteRateBook":
        case "clearSite":
        case "clearAll":
            return Results.Json(new { error = "not implemented", reason = $"op:{op} 於階段 C 實作" }, statusCode: 501);

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
        await Exec(cn, tx,
            @"INSERT INTO dbo.attachments (attachment_id, site_id, parent_kind, parent_id, name,
                  content_type, size_bytes, uploaded_at, file_path)
              VALUES (@aid,@s,@pk,@pid,@nm,@ct,@sz,@up,@fp)",
            ("@aid", aid), ("@s", sid), ("@pk", parentKind), ("@pid", parentId), ("@nm", Trunc(name, 200)),
            ("@ct", Trunc(Sx(a, "type") ?? "application/octet-stream", 50)), ("@sz", (int)D0(a, "size")),
            ("@up", Sx(a, "uploadedAt")), ("@fp", path));
    }
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
}
