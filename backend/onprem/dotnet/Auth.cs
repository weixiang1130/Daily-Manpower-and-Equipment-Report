/* ==========================================================================
   階段 D：身分與權限（docs/AUTH-PLAN.md）

   三段式，每一段都是可抽換的接縫：

     ① 認證  誰在連線            → IIdentitySource     → AD 帳號
     ② 目錄  AD 帳號是誰         → IEmployeeDirectory  → 工號＋部門名稱
     ③ 授權  這個工號能看哪些站   → Authorizer          → 角色＋可見工地

   ②是唯一還沒定案的一段：權限檢視表的鍵是**工號**不是 AD 帳號，
   中間需要一次對應。兩條路（查 AD 的 employeeID 屬性／呼叫人資 API）
   都只要換掉 IEmployeeDirectory 的實作，①③不受影響。

   ⚠ 預設 Mode=Off——**不設定就完全維持現行行為**（整站 Basic Auth、
     所有人看得到全部工地）。權限隨地端正式上線才由資訊處在設定檔開啟，
     不會因為部署了新版就突然把人擋在外面。
   ========================================================================== */
using System.Globalization;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;          // JsonValueKind：白名單／覆寫的元素逐項判型用
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;

namespace KgAudit.Api;

public enum AuthMode
{
    /// 不啟用權限：維持 Basic Auth，所有人可見全部工地（現行行為，預設）
    Off,
    /// 本機開發：身分由 X-Dev-User 標頭指定。**正式環境絕不可開**
    Dev,
    /// 內網 Windows 整合驗證：身分由**主機層**（IIS 啟用 Windows 驗證並停用匿名，
    /// 或 HTTP.sys 設 Negotiate/NTLM）提供，本程式只讀取已驗證的 HttpContext.User
    Windows
}

/// 本系統的角色（與 ERP 原生角色名是多對一，對應規則見 AUTH-PLAN §2.4）
public enum Role
{
    /// 系統管理者：全部工地＋設定／備份／破壞性操作
    Admin,
    /// 成控稽核：全部工地＋稽核模組，但無破壞性操作
    CostControl,
    /// 工地使用者（主管）：限所屬專案對映的工地
    SiteLead,
    /// 工地使用者：限所屬專案對映的工地
    SiteUser
}

public sealed record UserIdentity(string Account, string EmpId, string Name, string DeptName, bool OnJob)
{
    /* 人資 API 回的原始值，**僅供 /whoami 診斷**，不參與任何判定。
       在職判定為 false 時，沒有這兩個值就分不出「真的離職」與「欄位格式不如預期」。 */
    public string? RawIsOnJob { get; init; }
    public string? RawLeaveDate { get; init; }
}

public sealed record Authz(Role Role, IReadOnlySet<string> Sites, bool AllSites)
{
    /* ERP 權限檢視表回給這個人的專案代碼，以及其中**換不出工地名**的那些。
       **僅供 /whoami 診斷，不參與任何判定。**

       ⚠ 沒有這兩個值就分不出「ERP 根本沒給他這個專案」與「給了、但該工地的
         sites.project_code 還沒填」——兩者的畫面表現一模一樣（少一個工地），
         查修方向卻完全相反：一個要找 ERP 管理者，一個是我們自己的設定沒做完。
         UAT 期間實際踩到：某位主任在 ERP 有 5 個專案，只有 1 個對映得到工地。 */
    public IReadOnlySet<string>? ErpProjects { get; init; }
    public IReadOnlySet<string>? UnmappedProjects { get; init; }

    /* 授權覆寫（v24.12）：ERP 之外由成本管理部額外授予的工地，以及核准註記。
       **同樣僅供 /whoami 診斷，不參與判定**——判定時已經併進 Sites。

       ⚠ 覆寫製造了第三種「為什麼看得到這個工地」的成因（前兩種見上方註解）。
         不把它標出來的話，日後查「他怎麼會看得到 X 站」會先去翻 ERP，
         但 ERP 上根本沒有——查修方向完全錯誤。 */
    public IReadOnlySet<string>? GrantedSites { get; init; }
    public string? GrantNote { get; init; }
    /// 覆寫中對不上任何啟用中工地的項目（打錯字／該站已改名或停用）——僅供 /whoami 診斷
    public IReadOnlySet<string>? GrantsNotMatched { get; init; }

    /* 可刪除該站「已回報單」的工地子集合（v24.15，節點 61）。來源是成本管理部於
       設定頁維護的**主管白名單**（`app_settings.site_leads`），逐站授予、與 ERP 角色無關。
       ⚠ 只在使用者**本來就看得到**的站生效（ComputeAsync 末端與 Sites 取交集）：
         白名單不授予可見性，只把已可見的站升級成「可刪已回報單」。
       ⚠ 不取自 ERP Director：實查顯示該角色含總部幕僚且涵蓋全部工地，語意不符。 */
    public IReadOnlySet<string> LeadSites { get; init; } = new HashSet<string>();

    public bool CanSee(string site) => AllSites || Sites.Contains(site);
    /// 破壞性操作與全域設定限系統管理者——一併解決「伺服器端無權限分級」的安審遺留
    public bool IsAdmin => Role == Role.Admin;
    /// 稽核模組：成控與管理者可見。v13 只在 UI 隱藏，這裡才是真隔離
    public bool CanSeeAudits => Role is Role.Admin or Role.CostControl;
    /* 主管代處理權（節點 65 把節點 61 的語意定為通則）：工地承辦的**超常規操作**——
       刪除已回報單（節點 61）、逾期三日後的回報（節點 65）——一律由**該站主管**代為執行
       （使用者 2026-09-10 裁示：「工地承辦要做什麼，都需要工地主管同意」）。
       同一組人：系統管理者不限站；主管白名單（LeadSites）限自己的站。
       日後再有同類「承辦被擋、主管可代做」的能力，判定一律收斂到這裡，勿另起爐灶。 */
    public bool CanLeadOverride(string site) => IsAdmin || LeadSites.Contains(site);
    /* 刪除「已回報」單（計價依據，節點 61）。鎖檔（結算凍結）另由 LockGuard
       把關且優先——主管能刪的是未鎖檔的已回報單。 */
    public bool CanDeleteReported(string site) => CanLeadOverride(site);
}

public sealed class AuthOptions
{
    public AuthMode Mode { get; set; } = AuthMode.Off;

    /// 部門名稱命中即為系統管理者（AUTH-PLAN §2.4 規則 1）。
    /// 用部門而非 ERP 角色，是因為實查發現部門內有人未掛成控角色，只看角色會漏判。
    ///
    /// ⚠ 比對是 <see cref="StringComparer.Ordinal"/>——**必須與人資 API 回傳的 deptName
    ///   逐字元相符**（含全半形與空白）。寫錯不會報錯，只會讓那個部門的人全部被擋在門外，
    ///   而且從畫面上看不出原因。部署後請照 DEPLOYMENT §4.5 用實際帳號各驗一位。
    public string[] AdminDepartments { get; set; } = { "成本管理部", "採購處", "總經理室" };

    /* ERP 原生角色 → 本系統角色。**寫成設定不寫死**：ERP 日後新增角色時免改版。
       ⚠ 不可用「這人在此專案有幾列」判斷權限——大多數列是公司別角色（如 K02 佔三萬多列）。
         必須只挑白名單內的角色名。 */
    public string[] AdminRoles { get; set; } = { "Administrator" };
    public string[] CostControlRoles { get; set; } = { "Cost_Control", "Cost_Control_Audit", "Audit" };
    public string[] SiteLeadRoles { get; set; } = { "Director" };
    public string[] SiteUserRoles { get; set; } = { "Engineer" };

    /// 授權結果快取分鐘數。權限檢視表約 10 萬列且每日才更新，不必每次呼叫都查
    public int CacheMinutes { get; set; } = 30;

    /// 身分目錄來源：config（設定檔查表，預設，供開發／部署前驗證）｜
    /// hrapi（呼叫公司人資 API GetEmployeeByAD，見 AD_SSO 規格書 §6）
    public string Directory { get; set; } = "config";

    /// 人資 API 連線設定。**實值一律由環境變數帶入，不寫進版控檔**——
    /// 金鑰只由後端持有（規格要求：避免 CORS 且金鑰不落地前端）
    public HrApiOptions HrApi { get; set; } = new();

    /// Dev 模式的假身分表：AD 帳號 → "工號|姓名|部門|在職(1/0，可省略，預設 1)"
    public Dictionary<string, string> DevUsers { get; set; } = new();

    public IEnumerable<string> AllRoles() =>
        AdminRoles.Concat(CostControlRoles).Concat(SiteLeadRoles).Concat(SiteUserRoles);
}

public sealed class HrApiOptions
{
    public string Url { get; set; } = "";      // GetEmployeeByAD 端點（內網）
    public string System { get; set; } = "";   // 呼叫端系統識別名（資訊處配發）
    public string ApiKey { get; set; } = "";    // API 金鑰（資訊處配發，機密）
}

/* ---------- ① 認證 ---------- */
public interface IIdentitySource
{
    /// 回傳 AD 帳號（不含網域）；無法辨識時回 null
    string? Account(HttpContext ctx);
}

public sealed class DevIdentitySource : IIdentitySource
{
    public string? Account(HttpContext ctx)
    {
        var v = ctx.Request.Headers["X-Dev-User"].ToString();
        return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
    }
}

public sealed class WindowsIdentitySource : IIdentitySource
{
    /* 主機層驗過的身分是 DOMAIN\account，取後半段。
       這裡拿到的帳號**經過 Kerberos／NTLM 驗證**，不是前端自稱的字串
       ——所以不存在「POST 別人的帳號冒名登入」的問題（AUTH-PLAN §3 第 7 點）。
       ⚠ 前提是主機真的開了 Windows 驗證且**停用匿名存取**；只開 Windows 驗證
         但保留匿名，未登入者會以匿名身分進來，Identity.Name 為空 → 本系統回 401。 */
    public string? Account(HttpContext ctx)
    {
        var name = ctx.User?.Identity?.Name;
        if (string.IsNullOrWhiteSpace(name)) return null;
        var i = name.LastIndexOf('\\');
        return (i >= 0 ? name[(i + 1)..] : name).Trim();
    }
}

/* ---------- ② 目錄：AD 帳號 → 工號＋部門 ---------- */
public interface IEmployeeDirectory
{
    Task<UserIdentity?> LookupAsync(string account);
}

/// 設定檔查表。給本機開發與資訊處部署前的驗證用；正式環境請改用 HrApiEmployeeDirectory。
public sealed class ConfigEmployeeDirectory(AuthOptions opt) : IEmployeeDirectory
{
    public Task<UserIdentity?> LookupAsync(string account)
    {
        if (!opt.DevUsers.TryGetValue(account, out var v)) return Task.FromResult<UserIdentity?>(null);
        var p = v.Split('|');
        return Task.FromResult<UserIdentity?>(
            new UserIdentity(account, p[0].Trim(), p.ElementAtOrDefault(1) ?? account,
                             p.ElementAtOrDefault(2) ?? "", p.ElementAtOrDefault(3)?.Trim() != "0"));
    }
}

/// 呼叫公司人資 API（GetEmployeeByAD）以 AD 帳號換取工號＋部門（AD_SSO 規格書 §6）。
/// 端點／system／apiKey 一律由設定帶入，**絕不寫死**；金鑰只由後端持有。
/// 回傳的 data[0].userId＝工號（授權查詢的鍵）、deptName＝部門（規則 1 的依據）、
/// isOnJob／leaveDate＝在職判斷（離職者即使 ERP 權限未清也拒絕）。
public sealed class HrApiEmployeeDirectory(HrApiOptions opt, HttpClient http) : IEmployeeDirectory
{
    // JsonNode 讀字串：欄位可能是 null 或非字串，安全取值避免 GetValue 丟例外
    /* JSON 純量 → 字串。

       ⚠ **不可只接受 JSON 字串**。人資 API 的 `isOnJob` 實測回的是布林／數字
         而不是字串 "1"，只認字串會讓 S() 回 null、在職判定一律 false，
         於是**每一個人都被當成離職者拒絕**——UAT 首次部署就踩到：
         `userName`／`deptName` 正常（本來就是字串），只有 `isOnJob` 壞掉，
         症狀是身分鏈看起來全通、卻所有人都沒有權限。 */
    static string? S(JsonObject o, string k)
    {
        if (o[k] is not JsonValue v) return null;
        if (v.TryGetValue<string>(out var s)) return s;
        return v.ToJsonString().Trim('"');      // true／false／1／0 …
    }

    /* 在職欄位的真值判定。**放寬的是表示法，不是語意**——
       未知值一律當成「不在職」而拒絕（fail-closed，離職者不得放行）。 */
    internal static bool OnJobTruthy(string? v) =>
        v is not null && (v == "1"
                       || v.Equals("true", StringComparison.OrdinalIgnoreCase)
                       || v.Equals("Y", StringComparison.OrdinalIgnoreCase));

    /* 離職日是否**真的已經生效**。

       原本的判定是「`leaveDate` 非空即視為離職」，那會誤擋兩種在職者：
         ① **哨兵值**——人資系統常以 `1900-01-01`／`0001-01-01` 這類預設值填未離職者
         ② **預告離職**——已提辭呈但還在職到下個月末日，那段期間仍應可以使用系統

       改成只有「解析得出的日期 ≤ 今天」才算離職。`isOnJob` 仍是權威欄位
       （它為 false 時一律拒絕），這裡只決定 `leaveDate` 要不要**推翻**在職。

       ⚠ 解析不出來時回 false（不推翻）——看不懂的值不該把人擋在門外，
         而是交給 `isOnJob` 決定；原始值會出現在 /whoami 供判讀。
       ⚠ 年份門檻 1990：早於此的日期不可能是現職員工的真實離職日，一律視為哨兵值。 */
    internal static bool LeaveDateEffective(string? v, DateTime today)
    {
        if (string.IsNullOrWhiteSpace(v)) return false;
        if (!DateTime.TryParse(v, CultureInfo.InvariantCulture,
                               DateTimeStyles.None, out var d)) return false;
        if (d.Year < 1990) return false;                 // 哨兵／預設值
        return d.Date <= today.Date;                     // 未來日＝預告離職，尚未生效
    }

    public async Task<UserIdentity?> LookupAsync(string account)
    {
        if (string.IsNullOrWhiteSpace(opt.Url))
            throw new InvalidOperationException("未設定人資 API 端點（Auth:HrApi:Url）");

        var body = new JsonObject
        {
            ["system"] = opt.System,
            ["apiKey"] = opt.ApiKey,
            ["sessionId"] = Guid.NewGuid().ToString("N"),   // 配 log 用，規格 §6.1
            ["id"] = account
        };
        using var req = new HttpRequestMessage(HttpMethod.Post, opt.Url)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json")
        };
        using var resp = await http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
            // 拋出 → 上層 fail-closed 拒絕存取，不會誤放行
            throw new InvalidOperationException($"人資 API 回應 HTTP {(int)resp.StatusCode}");

        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync()) as JsonObject;
        var row = (json?["data"] as JsonArray)?.FirstOrDefault() as JsonObject;
        if (row is null) return null;   // 查無此人（data 為空）

        var empId = S(row, "userId")?.Trim();
        if (string.IsNullOrEmpty(empId)) return null;

        /* 在職＝`isOnJob` 為真，且沒有**已生效**的離職日（見 LeaveDateEffective）。
           原始值一併帶出來供 /whoami 診斷——判定結果是 false 時，
           不看原始值根本查不出是「真的離職」還是「欄位格式不如預期」。 */
        var rawOnJob = S(row, "isOnJob");
        var rawLeave = S(row, "leaveDate");
        var onJob = OnJobTruthy(rawOnJob) && !LeaveDateEffective(rawLeave, DateTime.Now);
        return new UserIdentity(account, empId,
            S(row, "userName") ?? account, S(row, "deptName") ?? "", onJob)
            { RawIsOnJob = rawOnJob, RawLeaveDate = rawLeave };
    }
}

/// 身分目錄的快取層。人資 API 回傳的工號／部門／在職狀態，變動頻率與授權結果相同，
/// 但它落在 Authorizer 的快取**之外**——沒有這一層，每一個 /api 請求都會同步打一次
/// 人資 API（開站的 scope=all 再加上後續每次讀寫各一次）。後果有兩個：
/// 本系統把自己的流量整批放大到人資系統；而人資 API 一慢或一停，本系統立刻全面 503。
public sealed class CachingEmployeeDirectory(IEmployeeDirectory inner, int minutes) : IEmployeeDirectory
{
    private readonly ConcurrentDictionary<string, (DateTime At, UserIdentity Value)> _cache = new();

    public async Task<UserIdentity?> LookupAsync(string account)
    {
        if (_cache.TryGetValue(account, out var hit) &&
            DateTime.UtcNow - hit.At < TimeSpan.FromMinutes(minutes))
            return hit.Value;

        // ⚠ 一律轉呼叫 inner，不可回頭走自己或其他來源
        var v = await inner.LookupAsync(account);
        /* 查無此人不快取（理由同 Authorizer：新到職者不該被一次失敗鎖住）。
           inner 拋出的例外（人資 API 不通）也不會進快取——由上層 fail-closed 處理。 */
        if (v is not null) _cache[account] = (DateTime.UtcNow, v);
        return v;
    }
}

/* ---------- ③ 授權 ---------- */
public sealed class Authorizer(AuthOptions opt, Func<SqlConnection> appDb, Func<SqlConnection>? erpDb)
{
    private readonly ConcurrentDictionary<string, (DateTime At, Authz? Value)> _cache = new();

    /// 授權查詢失敗一律拒絕（fail-closed）。放行比擋住危險得多——
    /// ERP 一斷線就變成全員全站可見，而且沒有人會發現。
    public async Task<Authz?> ResolveAsync(UserIdentity user)
    {
        if (!user.OnJob) return null;   // 離職者即使 ERP 權限資料未清理也拒絕

        if (_cache.TryGetValue(user.EmpId, out var hit) &&
            DateTime.UtcNow - hit.At < TimeSpan.FromMinutes(opt.CacheMinutes))
            return hit.Value;

        var authz = await ComputeAsync(user);
        /* 只快取成功的授權結果。**拒絕的結果不快取**——新到職或剛被加進 ERP 專案的人，
           若在權限生效前先試登入一次，那次的「拒絕」會被記住，之後即使 ERP 端已經
           正確授權，他仍會持續看到「您在 ERP 尚無任何專案權限」直到快取過期，
           而且重登、換瀏覽器都沒用（快取在伺服器端、鍵是工號）。
           拒絕本來就少見，每次重查的成本可以接受。 */
        if (authz is not null) _cache[user.EmpId] = (DateTime.UtcNow, authz);
        return authz;
    }

    public void Invalidate(){ _cache.Clear(); _depts = null; _grants = null; _leads = null; }

    /* ---- 管理員部門白名單（v23.2） ----
       優先讀資料庫的 app_settings，讓成控自己在系統後台增減，不必請資訊處
       改 appsettings 並重啟服務。**資料庫沒有或為空時回退到設定檔**——
       這是刻意的保險：避免有人在後台清空後把所有管理者一起鎖在門外。

       快取到下一次 Invalidate()（op:master 成功後會呼叫），否則每次授權
       都要多打一次資料庫。 */
    private string[]? _depts;

    private async Task<string[]> AdminDeptsAsync()
    {
        if (_depts is not null) return _depts;
        try
        {
            await using var cn = appDb();
            await cn.OpenAsync();
            await using var cmd = new SqlCommand(
                "SELECT value_json FROM dbo.app_settings WHERE setting_key = '" + Wr.AdminDeptKey + "'", cn);
            var raw = await cmd.ExecuteScalarAsync() as string;
            if (!string.IsNullOrWhiteSpace(raw)
                && JsonNode.Parse(raw) is JsonArray arr && arr.Count > 0)
            {
                var vals = arr.Select(x => x?.GetValue<string>()).Where(s => !string.IsNullOrWhiteSpace(s))
                    .Select(s => s!.Trim()).ToArray();
                if (vals.Length > 0) return _depts = vals;
            }
        }
        catch (Exception)
        {
            /* 讀設定失敗不能讓整個授權掛掉——退回設定檔的預設值即可。
               這裡刻意不 fail-closed：管理員部門讀不到只是「少了一條捷徑」，
               ERP 角色那條路仍在，不會有人因此被誤放行。 */
        }
        return _depts = opt.AdminDepartments;
    }

    /* ---- 授權覆寫：工地額外授予（v24.12） ----
       ERP 的專案角色是權限主來源，但它由 ERP 端維護、我方無法即時調整。
       跨工地支援（例如同廠區支援隔壁棟）常常等不及 ERP 流程，因此開一張
       由成本管理部自行維護的覆寫表，**只加不減**。

       存在 app_settings 的 `site_grants` 鍵（沿用 admin_departments 的模式，
       不另建資料表——維運帳號多半只有 db_datareader/db_datawriter，建表要動 DDL）。

       格式：
         { "K0000000": { "sites": ["工地A","工地B"],
                         "by": "核准人", "at": "2026-08-24", "why": "原因" } }
       只有 sites 是必要的；by/at/why 是稽核註記，這張表沒有其他軌跡，請務必填。

       ⚠ 覆寫**只給工地，不升角色**：被授予者在該站的角色仍是 ERP 算出來的那個
         （或無 ERP 工地角色時的 SiteUser），不會因此變成主管或系統管理者。 */
    /* ⚠ 這份快取**必須有 TTL**，不能只靠 Invalidate()。
       管理員部門（_depts）沒有 TTL 是可接受的——它極少變動，且變動時多半
       伴隨 op:master。但覆寫是「加完就要叫那個人馬上試」的操作：若只靠
       Invalidate()，用 SQL 直接改完之後在有人存工地設定之前**永遠不會生效**，
       現場只會回報「你加了我還是看不到」。（實測驗證過這個失敗模式。） */
    private (DateTime At, Dictionary<string, (string[] Sites, string Note)> Map)? _grants;

    /* 工地主管白名單（v24.15，節點 61 改版）。與覆寫同一份資料形狀、同一份快取紀律，
       但語意不同：覆寫給「看得到」，白名單給「刪得掉自己站的已回報單」。
       ⚠ 為什麼不用 ERP 的 Director 角色：實查正式 ERP，20 位具 Director 者中有 4 位
         是總部幕僚（總經理室／業務部／品保部／機電管理部）且涵蓋全部 12 站，
         另有部門與主管站對不上的多筆——ERP 的 Director ≠ 現場工地主任，
         直接採用會把刪除計價依據的權限發給不該有的人。改為成本管理部自行維護。 */
    private (DateTime At, Dictionary<string, (string[] Sites, string Note)> Map)? _leads;

    private async Task<Dictionary<string, (string[] Sites, string Note)>> GrantsAsync()
    {
        var ttl = TimeSpan.FromMinutes(Math.Max(0, opt.CacheMinutes));
        if (_grants is { } c && DateTime.UtcNow - c.At < ttl) return c.Map;
        var map = await ReadEmpSiteMapAsync(Wr.SiteGrantsKey);
        _grants = (DateTime.UtcNow, map);
        return map;
    }

    private async Task<Dictionary<string, (string[] Sites, string Note)>> LeadsAsync()
    {
        var ttl = TimeSpan.FromMinutes(Math.Max(0, opt.CacheMinutes));
        if (_leads is { } c && DateTime.UtcNow - c.At < ttl) return c.Map;
        var map = await ReadEmpSiteMapAsync(Wr.SiteLeadsKey);
        _leads = (DateTime.UtcNow, map);
        return map;
    }

    /* app_settings 的「工號 → 工地清單＋註記」共用讀取器（覆寫與主管白名單同形狀）。
       ⚠ setting_key 走參數而不是字串串接：目前傳進來的都是程式常數，但這個函式
         已經是「鍵由呼叫端決定」的形狀，串接等於替日後埋一個 SQL injection。 */
    private async Task<Dictionary<string, (string[] Sites, string Note)>> ReadEmpSiteMapAsync(string settingKey)
    {
        var map = new Dictionary<string, (string[], string)>(StringComparer.OrdinalIgnoreCase);
        try
        {
            await using var cn = appDb();
            await cn.OpenAsync();
            await using var cmd = new SqlCommand(
                "SELECT value_json FROM dbo.app_settings WHERE setting_key = @k", cn);
            cmd.Parameters.AddWithValue("@k", settingKey);
            if (await cmd.ExecuteScalarAsync() is string raw && !string.IsNullOrWhiteSpace(raw)
                && JsonNode.Parse(raw) is JsonObject root)
            {
                foreach (var (emp, node) in root)
                {
                    if (node is not JsonObject o || o["sites"] is not JsonArray arr) continue;
                    /* ⚠ 逐項用 GetValueKind 判型再取值：JSON 由設定頁寫入，但這份資料
                         也可能被 SQL 直改，非字串元素（數字／null／巢狀物件）不可讓
                         GetValue<string>() 直接丟例外——整包 catch 會讓所有授權一起消失。 */
                    var sites = arr.Where(x => x?.GetValueKind() == JsonValueKind.String)
                                   .Select(x => x!.GetValue<string>())
                                   .Where(s => !string.IsNullOrWhiteSpace(s))
                                   .Select(s => s.Trim()).ToArray();
                    if (sites.Length == 0) continue;
                    var note = string.Join(" / ", new[]
                    {
                        o["by"]?.ToString(), o["at"]?.ToString(), o["why"]?.ToString()
                    }.Where(x => !string.IsNullOrWhiteSpace(x)));
                    map[emp.Trim()] = (sites, note);
                }
            }
        }
        catch (Exception)
        {
            /* 讀不到就當作沒有這份設定。**不 fail-closed**：兩份都是加法授權，
               讀失敗只會讓人少拿到權限，不會放行任何本來不該有的操作。 */
        }
        return map;
    }

    private async Task<Authz?> ComputeAsync(UserIdentity user)
    {
        var empty = (IReadOnlySet<string>)new HashSet<string>();

        // 規則 1：部門名稱命中管理員部門 → 系統管理者。**先於 ERP 角色比對**
        if ((await AdminDeptsAsync()).Contains(user.DeptName, StringComparer.Ordinal))
            return new Authz(Role.Admin, empty, true);

        if (erpDb is null)
            throw new InvalidOperationException(
                "未設定 ERP 權限連線：請填 appsettings.json 的 ConnectionStrings:KgAuditErp"
              + "（或設環境變數 KGAUDIT_ERP_CONNECTION 覆寫）——權限模式已啟用但無法查詢授權來源");

        /* 主管白名單：由成本管理部於設定頁維護，**不取自 ERP 角色**（見 LeadsAsync 註解）。
           在 ERP 查詢之前先取，讓全站角色（規則 2）與工地角色（規則 4／5）共用同一份。 */
        var leads = await LeadsAsync();
        var leadGrant = leads.TryGetValue(user.EmpId, out var lg) ? lg.Sites : Array.Empty<string>();

        var roles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var projects = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        await using (var cn = erpDb())
        {
            await cn.OpenAsync();
            var names = opt.AllRoles().ToArray();
            var ps = string.Join(",", names.Select((_, i) => "@r" + i));
            /* ⚠ UserID 是 char 型別、**有尾端空白**，不 TRIM 會查不到任何列
                 ——而且是靜默的：查無資料看起來就像「這個人沒有權限」。 */
            await using var cmd = new SqlCommand(
                $@"SELECT DISTINCT LTRIM(RTRIM(ProjectID)) AS pid, LTRIM(RTRIM(RoleName)) AS rn
                   FROM BI.dbo.vw_Acumatica_Permission
                   WHERE LTRIM(RTRIM(UserID)) = @u AND LTRIM(RTRIM(RoleName)) IN ({ps})", cn);
            cmd.Parameters.AddWithValue("@u", user.EmpId);
            for (var i = 0; i < names.Length; i++) cmd.Parameters.AddWithValue("@r" + i, names[i]);

            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
            {
                projects.Add(rd.GetString(0));
                roles.Add(rd.GetString(1));
            }
        }

        // 規則 2／3：全站角色
        if (roles.Overlaps(opt.CostControlRoles)) return new Authz(Role.CostControl, empty, true);
        if (roles.Overlaps(opt.AdminRoles)) return new Authz(Role.Admin, empty, true);

        // 規則 4／5：工地角色 → 專案代碼換成工地名
        var isLead = roles.Overlaps(opt.SiteLeadRoles);

        /* v24.12 授權覆寫：先取這個人的額外授權。
           ⚠ 必須在規則 6 之前取得——完全沒有 ERP 工地角色、但有覆寫的人
             （新到職尚未進 ERP、支援性職務）要能靠覆寫進來，否則覆寫對
             最需要它的那群人無效。 */
        var grants = await GrantsAsync();
        var granted = grants.TryGetValue(user.EmpId, out var g)
            ? g : (Sites: Array.Empty<string>(), Note: "");

        // 規則 6：ERP 無工地角色**且**無覆寫 → 拒絕
        if (!isLead && !roles.Overlaps(opt.SiteUserRoles) && granted.Sites.Length == 0) return null;

        var sites = new HashSet<string>(StringComparer.Ordinal);
        var mapped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var okGrants = new HashSet<string>(StringComparer.Ordinal);
        var leadSites = new HashSet<string>(StringComparer.Ordinal);   // 主管白名單命中的站（v24.15）
        await using (var cn = appDb())
        {
            await cn.OpenAsync();
            /* 一次取回全部啟用中的工地：ERP 對映需要 project_code，
               覆寫則要能授予**尚未填 project_code**的工地，所以不能在 SQL 就濾掉 NULL。 */
            await using var cmd = new SqlCommand(
                "SELECT name, project_code FROM dbo.sites WHERE is_active = 1", cn);
            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
            {
                var name = rd.GetString(0);
                if (!rd.IsDBNull(1))
                {
                    var code = rd.GetString(1).Trim();
                    if (code.Length > 0 && projects.Contains(code))
                    {
                        sites.Add(name);
                        mapped.Add(code);
                    }
                }
                /* 主管白名單以**資料庫的工地名**為準比對（同覆寫的做法）：
                   白名單裡打錯字的項目不會生效，也不會憑空造出一個不存在的工地。 */
                if (leadGrant.Any(s => string.Equals(s, name, StringComparison.OrdinalIgnoreCase)))
                    leadSites.Add(name);
                /* 覆寫比對工地名。以資料庫的名稱為準（大小寫不敏感比對、存回正規名），
                   JSON 裡打錯字的項目不會生效，也不會憑空造出一個不存在的工地。 */
                if (granted.Sites.Any(s => string.Equals(s, name, StringComparison.OrdinalIgnoreCase)))
                {
                    sites.Add(name);
                    okGrants.Add(name);
                }
            }
        }

        /* 有工地角色但一個站都對不上：多半是該站的 project_code 還沒填。
           回空清單而不是拒絕登入——使用者會看到「沒有可用工地」的引導訊息，
           比直接擋在門外容易查出是設定沒做完。 */
        var unmapped = new HashSet<string>(projects.Where(p => !mapped.Contains(p)), StringComparer.OrdinalIgnoreCase);
        /* 覆寫裡對不上任何啟用中工地的項目（SQL 直改打錯字、或該站事後改名／停用）。
           與 unmapped 同一個理由要攤出來：不標示的話，「存了卻沒生效」在畫面上
           與「根本沒授權」一模一樣，查修無從下手（節點 54 的教訓，別再犯一次）。 */
        var missGrants = new HashSet<string>(
            granted.Sites.Where(s => !okGrants.Any(n => string.Equals(n, s, StringComparison.OrdinalIgnoreCase))),
            StringComparer.OrdinalIgnoreCase);
        /* ⚠ 主管白名單**只在看得到的站生效**（最小權限）：白名單本身不授予可見性，
             它只是把「已看得到的站」升級成「可刪該站已回報單」。
             CanSee 在 op 層也會先擋一次，這裡的交集是第二道、也讓 /whoami 不會
             報出一個他其實進不去的站。 */
        leadSites.IntersectWith(sites);
        /* 角色仍由 ERP 決定：覆寫**只加工地、不升角色**（設計決策，2026-08-24）。
           純靠覆寫進來的人（ERP 無任何工地角色）視為 SiteUser——能申請與回報，
           不會因為被授予工地而變成主管。 */
        return new Authz(isLead ? Role.SiteLead : Role.SiteUser, sites, false)
            { ErpProjects = projects, UnmappedProjects = unmapped,
              GrantedSites = okGrants, GrantNote = okGrants.Count > 0 ? granted.Note : null,
              GrantsNotMatched = missGrants.Count > 0 ? missGrants : null,
              LeadSites = leadSites };
    }
}
