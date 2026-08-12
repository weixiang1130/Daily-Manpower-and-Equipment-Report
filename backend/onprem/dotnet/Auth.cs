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
using System.Collections.Concurrent;
using System.Text;
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

public sealed record UserIdentity(string Account, string EmpId, string Name, string DeptName, bool OnJob);

public sealed record Authz(Role Role, IReadOnlySet<string> Sites, bool AllSites)
{
    public bool CanSee(string site) => AllSites || Sites.Contains(site);
    /// 破壞性操作與全域設定限系統管理者——一併解決「伺服器端無權限分級」的安審遺留
    public bool IsAdmin => Role == Role.Admin;
    /// 稽核模組：成控與管理者可見。v13 只在 UI 隱藏，這裡才是真隔離
    public bool CanSeeAudits => Role is Role.Admin or Role.CostControl;
}

public sealed class AuthOptions
{
    public AuthMode Mode { get; set; } = AuthMode.Off;

    /// 部門名稱命中即為系統管理者（AUTH-PLAN §2.4 規則 1）。
    /// 用部門而非 ERP 角色，是因為實查發現部門內有人未掛成控角色，只看角色會漏判。
    public string[] AdminDepartments { get; set; } = { "成本管理部" };

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
    static string? S(JsonObject o, string k) =>
        o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

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

        // isOnJob=="1" 且無離職日 才算在職；兩者取交集，任一顯示離職即拒絕
        var onJob = S(row, "isOnJob") == "1" && string.IsNullOrWhiteSpace(S(row, "leaveDate"));
        return new UserIdentity(account, empId,
            S(row, "userName") ?? account, S(row, "deptName") ?? "", onJob);
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
        _cache[user.EmpId] = (DateTime.UtcNow, authz);
        return authz;
    }

    public void Invalidate() => _cache.Clear();

    private async Task<Authz?> ComputeAsync(UserIdentity user)
    {
        var empty = (IReadOnlySet<string>)new HashSet<string>();

        // 規則 1：部門名稱＝成本管理部 → 系統管理者。**先於 ERP 角色比對**
        if (opt.AdminDepartments.Contains(user.DeptName, StringComparer.Ordinal))
            return new Authz(Role.Admin, empty, true);

        if (erpDb is null)
            throw new InvalidOperationException(
                "未設定 ERP 權限連線（KGAUDIT_ERP_CONNECTION）——權限模式已啟用但無法查詢授權來源");

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
        if (!isLead && !roles.Overlaps(opt.SiteUserRoles)) return null;   // 規則 6：拒絕

        var sites = new HashSet<string>(StringComparer.Ordinal);
        await using (var cn = appDb())
        {
            await cn.OpenAsync();
            await using var cmd = new SqlCommand(
                "SELECT name, project_code FROM dbo.sites WHERE project_code IS NOT NULL AND is_active = 1", cn);
            await using var rd = await cmd.ExecuteReaderAsync();
            while (await rd.ReadAsync())
                if (projects.Contains(rd.GetString(1).Trim())) sites.Add(rd.GetString(0));
        }

        /* 有工地角色但一個站都對不上：多半是該站的 project_code 還沒填。
           回空清單而不是拒絕登入——使用者會看到「沒有可用工地」的引導訊息，
           比直接擋在門外容易查出是設定沒做完。 */
        return new Authz(isLead ? Role.SiteLead : Role.SiteUser, sites, false);
    }
}
