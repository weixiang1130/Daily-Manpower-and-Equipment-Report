# 部署手冊（地端 / 自有伺服器）

本文件供 IT／基礎架構人員將本系統從 Netlify 遷移至自有伺服器。
系統技術背景請先讀 [`CLAUDE.md`](../CLAUDE.md)；演進脈絡見 [`docs/milestones/`](milestones/README.md)。

## 1. 系統組成（三種部署形態）

本系統＝**純靜態前端 ＋ 一支資料 API ＋ 整站 Basic Auth**。
repo 內含三套等價的執行環境，皆實作同一份 [`API-CONTRACT.md`](API-CONTRACT.md)：

| | Netlify 版（現行，過渡期） | **.NET 8 版（地端正式方案）** | Node 可攜式版（備援／對照） |
|---|---|---|---|
| 程式位置 | `backend/cloud/` | **`backend/onprem/dotnet/`** | `backend/onprem/server.mjs` |
| 執行環境 | Netlify | **.NET 8 Runtime ＋ SQL Server** | Node.js 18+（零 npm 依賴） |
| 靜態檔案 | Netlify CDN | 同服務供應（`STATIC_DIR`） | 內建靜態服務 |
| 資料儲存 | Netlify Blobs | **SQL Server（17 表 5 VIEW）** | 檔案系統 `DATA_DIR` |
| 附件本體 | Blobs | 檔案系統（`ATTACH_DIR`） | `DATA_DIR/attachments/` |
| 個人身分與權限 | ✕（單一共用帳密） | **✓ Windows 驗證＋ERP 角色（§4.5）** | ✕ |

前端 `app.js` 對三種形態**完全無感**——只呼叫 `/api/data`。

> **給資訊處**：正式方案請採 **.NET 8 版**（§3.5），它是唯一支援個人身分與權限隔離的形態，
> 且已與雲端逐欄比對過真實資料。`server.mjs` 保留作為行為對照與緊急備援，**不是最終方案**。

> **重要**：`backend/cloud/` 與 `netlify.toml` 是 Netlify 專用，地端部署**不需要、也無法使用**。

## 2. 地端環境需求

**.NET 8 版（正式方案）**

- **.NET 8 Runtime**（ASP.NET Core Runtime；只跑不編譯的話不需要 SDK）
- **SQL Server 2017 以上**——DDL 用到 `STRING_AGG` 與 `OPENJSON`，2016 以下不支援
- Windows Server（若要用 Windows 整合驗證；見 §4.5）
- ⚠ **`InvariantGlobalization` 不可設為 true**：`Microsoft.Data.SqlClient` 一開連線就會丟例外；
  中文定序與日期格式也需要完整 globalization。**部署到 Linux 容器須另裝 ICU**
- 相依套件只有一個：`Microsoft.Data.SqlClient`
  （**刻意不引** `Microsoft.AspNetCore.Authentication.Negotiate`——8.0 線帶高嚴重性弱點，
  Windows 驗證改由主機層提供，見 §4.5）

**Node 可攜式版（備援）**

- Node.js 18 以上（**零 npm 依賴**，不需 `npm install`）

**共通**

- 建議前置反向代理（IIS ARR / nginx）處理 **HTTPS**——服務本身只講 HTTP，
  Basic Auth 帳密是明文傳輸，**正式環境必須走 HTTPS**
- 磁碟空間：單據資料極小（每筆約 1–2 KB）；**附件是主要成長來源**（單檔上限 4MB），
  依實際上傳量估算，建議先給 50 GB 並納入監控

## 3. 部署步驟（Node 可攜式版／備援）

> 正式方案請看 **§3.5（.NET 8 版）**。本節保留給備援與行為對照用途。

```bash
# 1) 取得程式碼
git clone <本 repo>
cd <repo>

# 2) 放置真實名單設定檔（向系統管理者索取，勿入版控）
#    內容格式見 app.js 開頭註解；檔名固定：
#    <repo>/frontend/config.local.js   ← 必須放在 frontend/（index.html 以相對路徑載入）

# 3) 設定環境變數
#    Linux（systemd 服務檔或 shell）：
export PORT=8080
export SITE_AUTH_USER=<帳號>          # 向系統管理者索取
export SITE_AUTH_PASS=<密碼>          # 未設定＝不啟用驗證，正式環境必設
export DATA_DIR=/var/lib/kg-audit     # 資料目錄（建議獨立於程式目錄）
#    Windows（以系統環境變數或服務包裝器設定同名變數）

# 4) 匯入既有資料（從 Netlify 切換時；全新部署可跳過）
#    先在舊站：設定頁 → 管理員登入 → 「下載完整備份（JSON）」
node backend/onprem/import-backup.mjs 完整備份.json

# 5) 啟動
node backend/onprem/server.mjs
#    → http://localhost:8080 應出現登入視窗（若已設 SITE_AUTH_PASS）
```

### 常駐服務建議

- **Linux**：systemd unit，`ExecStart=/usr/bin/node /opt/kg-audit/backend/onprem/server.mjs`，`Restart=always`，環境變數寫在 unit 的 `Environment=` 或 `EnvironmentFile=`
- **Windows**：以 [NSSM](https://nssm.cc/) 或工作排程器包成服務；環境變數設在服務層級

## 3.5 部署步驟（.NET 8 版，**正式方案**）

程式在 `backend/onprem/dotnet/`：`Program.cs`（端點）＋`Auth.cs`（身分與權限）
＋`KgAudit.Api.csproj`＋`appsettings.json`。

### ⓪ 帳號與權限（請先確定這一段，最容易卡住）

**連線身分**：若連線字串使用 `Integrated Security=true`（內網常見做法），
實際連資料庫的身分是 **IIS 應用程式集區帳號／Windows 服務的登入帳號**，
**不是**登入網頁的使用者。請先決定專用服務帳號，再依它授權。

```sql
-- ① 本系統資料庫：只需資料讀寫，不需要結構變更權
USE KG_AUDIT;
CREATE USER [<服務帳號>] FOR LOGIN [<服務帳號>];
ALTER ROLE db_datareader ADD MEMBER [<服務帳號>];
ALTER ROLE db_datawriter ADD MEMBER [<服務帳號>];
-- 不需要 db_ddladmin／db_owner：DDL 只在建置時由 DBA 執行一次

-- ② ERP 權限檢視表：**不同資料庫**，必須另外授權（見 §4.5 的說明框）
USE BI;
CREATE USER [<服務帳號>] FOR LOGIN [<服務帳號>];
GRANT SELECT ON dbo.vw_Acumatica_Permission TO [<服務帳號>];
```

**檔案系統權限**（服務帳號）：

| 目錄 | 需要的權限 |
|---|---|
| `ATTACH_DIR`（附件） | **讀取＋寫入＋建立**（程式啟動時會自動建目錄） |
| `STATIC_DIR`（前端靜態檔） | 唯讀 |
| 日誌輸出目的地 | 寫入 |

**網路**：本系統 → SQL Server（預設 1433）、→ ERP SQL 執行個體、
→ 人資 API（HTTPS 443，僅啟用權限時）。使用者 → 本服務（HTTP，前置 HTTPS 反向代理）。

### ① 建立資料庫

```bash
sqlcmd -S <伺服器> -x -b -C -Q "CREATE DATABASE KG_AUDIT;"
sqlcmd -S <伺服器> -d KG_AUDIT -f 65001 -x -b -C -i backend/sql/DB-SCHEMA.sql
```

**旗標缺一不可**：`-f 65001`＝UTF-8（少了它中文全亂碼、DDL 解析失敗）；`-x`＝停用 `$()`
變數替換；`-b`＝遇錯即停；`-C`＝信任伺服器憑證（ODBC 18 預設強制加密）。
資料遷移見 [`backend/sql/README.md`](../backend/sql/README.md) §5。

### ② 發行

```bash
dotnet publish backend/onprem/dotnet/KgAudit.Api.csproj -c Release -o /opt/kg-audit
```

### ③ 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `KGAUDIT_CONNECTION` | **是** | 本系統資料庫連線字串。未設定且 `appsettings` 也沒有 → **啟動即失敗**（刻意的） |
| `ATTACH_DIR` | **是** | 附件本體根目錄。預設值是相對於執行檔往上數層的開發用路徑，**發行後幾乎必然要顯式指定** |
| `STATIC_DIR` | **是** | 前端靜態根，指向 `frontend/`。同上，預設值是為 `bin/Debug` 佈局設計的；發行後層級不同 |
| `ASPNETCORE_URLS` | 建議 | 監聽位址。`appsettings` 預設 `http://localhost:8080` **只接受本機連線**——要讓其他電腦連得到須設 `http://*:8080`（走 IIS 反向代理則不受影響） |
| `SITE_AUTH_USER` / `SITE_AUTH_PASS` | **是** | 整站 Basic Auth。⚠ **`SITE_AUTH_PASS` 未設定＝完全不啟用驗證且不會有任何警告** |

> **⚠ `STATIC_DIR` 設錯的症狀**：服務照樣起得來、API 也正常，但使用者看到**空白頁**——
> 程式只會在日誌記一行 Warning 就繼續只跑 API。部署後請先用瀏覽器開首頁確認，不要只測 API。

啟用權限（§4.5）時另需 `Auth__Mode`、`Auth__Directory`、`Auth__HrApi__*`、`KGAUDIT_ERP_CONNECTION`。

> **⚠ `appsettings.json` 裡的 `_KgAuditErp` 是註解、不是設定。** 底線前綴的鍵不會被讀取。
> ERP 連線請填 `ConnectionStrings:KgAuditErp`（無底線）或設環境變數 `KGAUDIT_ERP_CONNECTION`。
> 填錯位置不會有錯誤訊息，會在啟用權限後變成全員 503。

### ④ 啟動與常駐

```bash
/opt/kg-audit/KgAudit.Api          # 前景試跑，確認日誌無誤
```

- **IIS**：以 ASP.NET Core Module 託管（同時也是啟用 Windows 驗證的建議方式，見 §4.5）
- **Windows 服務**：`sc create` 或 NSSM 包裝；環境變數設在服務層級
- **Linux**：systemd unit，`Restart=always`，環境變數寫在 `Environment=` 或 `EnvironmentFile=`

### ⑤ 上線前檢查

- [ ] 瀏覽器開首頁**看得到畫面**（不是只有 API 通）→ 驗證 `STATIC_DIR`
- [ ] 上傳一張附件並重新下載 → 驗證 `ATTACH_DIR` 與權限
- [ ] `GET /health` 回 `{"ok":true,"sites":N}`，N 與預期工地數相符
- [ ] 未帶帳密存取會跳出登入視窗 → 驗證 `SITE_AUTH_PASS` 確實生效
- [ ] 日誌裡有一行「管理員部門」清單 → 與人資系統的部門名稱**逐字**核對（見 §4.5）

### ⑥ 前端的計價功能開關（v23.1）

前端目前把**計價與行情通報匯入從畫面下架**（`frontend/app.js` 的 `PRICING_UI = false`）。
程式、資料、SQL 費率三表、本 API 的對應端點**全部保留**，只是不顯示。

> **換季要匯入新費率時，必須先把 `PRICING_UI` 改成 `true` 並重新部署前端**——
> 匯入入口也在這個開關裡面。代辦扣抵金額不受開關影響，仍會依已匯入的費率計算。

## 4. 資料遷移（Netlify → 地端）切換流程

1. 公告停機時段（避免切換期間有人寫入舊站）
2. 舊站：管理員「下載完整備份（JSON）」
3. **附件搬運（v14 起必做）**：JSON 備份只含附件描述資料、**不含檔案本體**——依備份中各單據/稽核的 `attachments[].id`，以 `GET ?site=<工地>&attachment=<id>`（帶 Basic Auth）逐一下載存入地端附件目錄。**server.mjs 形態注意**：檔名須為 `<b64url(工地)>_<附件id>`（無副檔名），並須同步建立 `attmeta:` 中繼資料（名稱/型別），否則下載會退化為 octet-stream 與亂檔名；SQL 形態則回填 `file_path`（詳見 backend/sql/README.md 附件搬運節）
4. **費率書搬運（v22.8 起必做）**：完整備份 JSON 就是 `GET ?scope=all` 的回應，
   而**行情通報費率書刻意不在 `scope=all` 裡**（走獨立端點 `GET ?rates=1`）。
   只轉備份會讓費率書整個不見，計價金額與代辦扣抵全部變成「查無費率」。
   請另行 `GET ?rates=1` 匯出後以 `op:rateBook` 匯入，或請管理員重跑一次當季匯入。
   （各站的費率綁定在 config 裡，有隨備份帶走，不必另外處理。）
5. 地端匯入資料 → 啟動服務
   - **.NET 8 版**：見 §3.5 ①（`DB-SCHEMA.sql` ＋ `backend/sql/README.md` §5 的轉換與匯入）
   - Node 版：`node backend/onprem/import-backup.mjs <備份檔>`
6. 驗證清單（缺一不可）：
   - 開站出現 Basic Auth 登入 → 選工地攔截頁 → 各工地資料筆數與舊站一致
   - 建立一筆點工申請 → 回報覆核（逐工種＋分段加班）→ 差異正確
   - 歷程報表期間/條件篩選 → 匯出明細與計價彙總 CSV
   - 附件抽查：任選數筆含附件單據，縮圖可開啟、稽核 PDF 照片正常
   - **代辦扣抵**：任選一筆有代辦的單，確認「廠商排名」頁籤的代辦扣抵金額算得出來
     （算不出來多半是費率書沒搬，見步驟 4）
   - 管理員登入 → 設定頁名單維護 → 下載完整備份
7. DNS／內網入口改指地端；通知使用者新網址
8. **退場舊站**：更換或停用 Netlify 站台密碼、（建議）刪除 Netlify 站台與環境變數，避免兩份資料並存造成誤填

## 4.5 Windows 驗證與權限（.NET 8 API，選用）

權限機制**預設關閉**（`Auth:Mode=Off`）——不做任何設定就維持現行行為
（整站 Basic Auth、所有人可見全部工地）。要啟用時：

**① 主機層開啟 Windows 驗證。**
本程式**刻意不引** `Microsoft.AspNetCore.Authentication.Negotiate` 套件
（該套件 8.0 線含最新版仍帶兩則高嚴重性弱點告警：GHSA-2p3q-h3hg-jcqq、
GHSA-8prm-248r-h957），改由主機提供身分，本程式只讀取已驗證的 `HttpContext.User`：

| 主機 | 設定 | 程式需要做什麼 |
|---|---|---|
| **IIS** | 網站 → 驗證 → **啟用「Windows 驗證」、停用「匿名驗證」** | 不需要——ASP.NET Core Module 會把已驗證的身分帶進來 |
| **HTTP.sys**（Windows 服務／自主控管） | — | 設環境變數 **`KGAUDIT_HTTPSYS=1`**，程式即以 `Negotiate\|NTLM` 監聽並停用匿名 |

> `KGAUDIT_HTTPSYS` **預設關閉**，不設就完全維持原本的 Kestrel 行為。
> 僅 Windows 有效（非 Windows 設了會略過，不會讓服務起不來）。
> 若以 `http://+:port` 監聽，HTTP.sys 需要 URL ACL（`netsh http add urlacl`）或以系統管理員執行。

> ⚠ 只開 Windows 驗證但**保留匿名**，未登入者會以匿名身分進來、`Identity.Name` 為空，
> 本系統一律回 401——功能不會壞，但使用者會看到「無法辨識您的網域帳號」。

**診斷端點 `/whoami`**：部署 Windows 驗證時最常見的問題是「不知道卡在哪一段」。
以瀏覽器（或帶 Windows 認證的工具）開 `/whoami`，會把身分鏈四段的結果攤開：

```jsonc
{ "authMode":"Windows", "hostAuthenticated":true,
  "hostIdentity":"DOMAIN\\account", "hostAuthType":"Negotiate",  // ① 主機層
  "account":"account",                                            // ② 去網域前綴
  "empId":"...", "deptName":"...", "onJob":true,                  // ③ 目錄查詢
  "role":"Admin", "allSites":true, "isAdmin":true }               // ④ 授權結果
```

斷在哪一段就會出現 `stoppedAt` 說明原因。**部門字串對不上時，
把回應裡的 `deptName` 與設定的管理員部門逐字比對即可查出。**
此端點刻意放在 `/api` 之外（權限中介層只擋 `/api`，放進去會在授權失敗時被 403
擋掉——而那正是最需要診斷的時候），仍受整站 Basic Auth 保護，且只回報呼叫者自己的身分。

**② 設定檔。**

```jsonc
"Auth": {
  "Mode": "Windows",           // Off（預設）／Windows／Dev
  "Directory": "hrapi",        // hrapi＝呼叫人資 API 換工號＋部門；config＝設定檔假名單（測試）
  "HrApi": {                   // 實值改用環境變數帶入，不寫進版控檔（見下）
    "Url": "", "System": "", "ApiKey": ""
  }
},
"ConnectionStrings": {
  "KgAudit":    "...",         // 本系統資料庫
  "KgAuditErp": "..."          // ERP 權限檢視表（唯讀），Mode 非 Off 時必填
}
```

> ### ⚠ ERP 連線需要的是**跨資料庫**的讀取權
>
> 程式是以**三段式名稱** `BI.dbo.vw_Acumatica_Permission` 存取權限檢視表——
> **與 `KGAUDIT_ERP_CONNECTION` 連到哪個資料庫無關**。
>
> 只在連線字串指定的資料庫上授 `db_datareader` **不夠**：服務會正常啟動、
> Basic Auth 正常、一般讀寫全部正常，**直到有人登入觸發權限判定才失敗**
> （`Invalid object name 'BI.dbo.vw_Acumatica_Permission'`），
> 而 fail-closed 會讓**全員 503**。這是最容易在上線當天才爆的設定。
>
> 需要的授權：
>
> ```sql
> -- 於 ERP 所在執行個體的 BI 資料庫
> USE BI;
> CREATE USER [<服務帳號>] FOR LOGIN [<服務帳號>];
> GRANT SELECT ON dbo.vw_Acumatica_Permission TO [<服務帳號>];
> ```
>
> 若 ERP 與本系統在**不同執行個體**，`KGAUDIT_ERP_CONNECTION` 要指向 ERP 那台。

**機密一律走環境變數**（不寫進進版控的檔案）：

| 環境變數 | 用途 |
|---|---|
| `KGAUDIT_CONNECTION` | 本系統資料庫連線 |
| `KGAUDIT_ERP_CONNECTION` | ERP 權限檢視表（唯讀）連線 |
| `Auth__HrApi__Url` | 人資 API `GetEmployeeByAD` 端點 |
| `Auth__HrApi__System` | 呼叫端系統識別名（資訊處配發） |
| `Auth__HrApi__ApiKey` | 人資 API 金鑰（資訊處配發） |

**身分鏈**：主機層 Windows 驗證取得 AD 帳號 → `GetEmployeeByAD` 換工號＋部門 →
以工號查 ERP 權限檢視表決定角色與可見工地。人資 API 只能由後端呼叫（金鑰不落地前端）。

角色白名單（哪些 ERP 角色算工地／成控／管理者）也在 `Auth` 區段，ERP 日後新增角色時**改設定即可，免改版**。

**③ 填入專案代碼對映。**
`dbo.sites.project_code` 對應 ERP 專案代碼；未填的工地**只有管理員看得到**。
判定規則與角色對照見 [`AUTH-PLAN.md`](AUTH-PLAN.md) §2.4。

**③-2 確認管理員部門。**
`Auth:AdminDepartments` 裡的部門，其人員一登入即為系統管理者。預設三個部門，
**但成控可在系統設定頁自行增減**（存進 `app_settings` 資料表，優先於本設定檔；
資料表為空時才回退到這裡）。

> ⚠ **部門名稱是逐字元完全相符**人資 API 回傳的 `deptName`（含全半形與空白）。
> 寫錯**不會有錯誤訊息**，只會讓該部門的人拿不到管理員權限。因此：
> - 服務**啟動時會在日誌印出設定的管理員部門清單**——請與人資系統的名稱逐字核對
> - **授權失敗時會記下該使用者實際的部門字串**——設定寫「採購部」而人資回「採購處」
>   這類情況，比對兩行日誌即可查出
> 上線後請各部門實際找一位同仁登入確認。

**④ 驗收。** 跑 `AUTH-PLAN.md` §6 的 11 個情境。

> **Windows 驗證本身已於網域環境實測通過（2026-08-13）**：
> 以真實網域帳號經 HTTP.sys／Negotiate 登入，`hostIdentity` 取得 `DOMAIN\account`、
> 正確去除網域前綴、完成目錄與授權判定；未帶身分者被主機層擋下（401）。
> **冒名亦已驗證無效**——送 `X-Dev-User`／偽造 `Authorization` 標頭，
> 伺服器一律只認 Kerberos 驗過的身分，從不採信標頭自稱的帳號。
>
> 仍需在正式環境複驗的是**貴部門主機的實際設定**（IIS 或 HTTP.sys 是否確實
> 啟用 Windows 驗證並停用匿名）——用 `/whoami` 一次就看得出來。

> `Auth:Mode=Dev` 讓身分由 `X-Dev-User` 標頭指定，僅供開發測試——**正式環境絕不可使用**。

## 5. 維運

| 項目 | 建議 |
|---|---|
| 備份（.NET 版） | **兩份都要**：① SQL Server 資料庫的例行備份 ② **`ATTACH_DIR` 的附件檔案**——附件本體**不在資料庫裡**（刻意的：幾百 MB 的照片塞進 DB 會讓備份與還原又慢又大）。只備份資料庫＝所有簽單照片與稽核照片都沒被備份到 |
| 備份（Node 版） | 每日排程壓縮整個 `DATA_DIR`（含 JSON 檔與 `attachments/` 子目錄的附件二進位——**備份規則勿只挑 .json**）；另保留管理員手動 JSON 備份於月結時點 |
| 監控 | 服務存活（`GET /health` 回 `{"ok":true,"sites":N}`）＋磁碟空間（**含 `ATTACH_DIR`**）。<br>⚠ **啟用 Windows 驗證後，探測也必須帶網域認證**——`AllowAnonymous=false` 是在 HTTP.sys／IIS 層生效，**整台服務每個路徑**（含 `/health` 與首頁）都要求認證。不帶認證的探測會拿到 **401**，監控會把健康的服務報成死掉、甚至觸發自動重啟。請以網域服務帳號執行探測，或在 IIS 對 `/health` 單獨放行匿名 |
| 密碼輪替 | 人員異動時更換 `SITE_AUTH_PASS` 並重啟服務 |
| 日誌 | stdout（systemd journal / NSSM 日誌檔）；本系統不記錄操作者身分（見下） |

## 6. 已知限制（IT 評估用）

- **單一共用帳密**，無個人身分與操作軌跡；責任歸屬以「簽單責任工程師」欄位＋紙本簽單為準。若需問責到人，須另建含登入的後端（屬改版範疇，非部署設定）
- 破壞性操作（清空資料）伺服器端無權限分級，僅前端管理員模式防誤觸——請以檔案備份為最後防線
- 前端每次開站載入全部紀錄；資料累積數千筆後建議實施「月結封存」（將已鎖定月份移出 `DATA_DIR` 另存）
- `SITE_AUTH_PASS` 未設定時**不啟用驗證**（fail-open，沿用雲端版設計）——正式環境務必設定並納入組態檢查

## 7. 未來改接公司標準後端（重寫資料層）

> **移轉主文件**：公司內網（.NET 8 + SQL Server）的完整移轉計畫、分工、三階段時程與切換日程序，
> 見 [`docs/MIGRATION-PLAN.md`](MIGRATION-PLAN.md)。本節僅保留資料層起點說明。


若 IT 評估後決定不使用 `backend/onprem/server.mjs`，而以公司標準技術（自選語言＋資料庫）重寫後端：

- **資料層起點包已備妥**：[`backend/sql/`](../backend/sql/README.md) 內含經實測的 SQL Server 建表 DDL（17 表＋5 VIEW）、備份 JSON→SQL 遷移工具、逐操作 SQL 對照與並發寫法——**請從 backend/sql/README.md 讀起**，不必從零設計 schema
- **只需實作一份合約**：[`docs/API-CONTRACT.md`](API-CONTRACT.md) 完整定義了前後端唯一接縫（單一端點、11 個操作＋附件下載與費率書讀取、409 並發語意、全部欄位字典、資料表設計建議與驗收方式）。新後端符合該合約，**前端 `app.js` 零修改**
- **API 路徑可配置**：後端若掛在其他路徑（如 `/kg-audit/api/data`），在 `config.local.js` 加一行 `apiBase: "<路徑>"` 即可，不改程式
- **驗收**：以現行前端直接跑本文件 §4 驗證清單＋雙瀏覽器並發 409 測試
- 兩份參考實作（`backend/cloud/functions/api.mjs`、`backend/onprem/server.mjs`）API 合約行為一致，可作為重寫時的對照組（已知差異：server.mjs 無舊命名空間 `migrateLegacyKeys` 搬移——僅影響從未經雲端 GET 的極舊資料）

## 8. 測試狀態聲明

三種形態的驗證程度**不同**，請分別看待：

| 形態 | 狀態 |
|---|---|
| **`backend/onprem/dotnet/`（正式方案）** | ✅ **已實機測試**：以正式資料快照在 LocalDB 起服務，與雲端逐欄比對 996 筆單據**差異 0 處**；409 樂觀並發以 12 執行緒實測恰好 1 人成功；各階段功能測試累計 200 項以上全過（含跨工地隔離、日期防呆、代辦逐筆往返、管理員部門） |
| `backend/onprem/server.mjs`／`import-backup.mjs` | ⚠ **未經實機執行測試**——撰寫當下開發機無 Node 環境，僅通過語法驗證與對照 `backend/cloud/functions/api.mjs` 的逐行合約比對 |
| `backend/sql/`（DDL＋轉換器） | ✅ LocalDB 實建、以正式資料匯入對帳一致 |

**已於網域環境實測通過（2026-08-13，更正先前的「無法驗證」聲明）**：

- **Windows 整合驗證本身**：真實網域帳號經 HTTP.sys／Negotiate 完成身分鏈四段；
  未帶身分者被擋下（401）
- **冒名登入無效**：送 `X-Dev-User`／偽造 `Authorization` 標頭，伺服器一律只認
  Kerberos 驗過的身分

**部署時仍須複驗（屬環境設定，非程式）**：

1. **貴部門主機是否確實啟用 Windows 驗證並停用匿名**——開 `/whoami` 即可確認
2. **管理員部門字串是否對得上**——部門名稱逐字元比對人資 API 的回傳值。
   請各部門實際找一位同仁登入，用 `/whoami` 比對回應中的 `deptName`
   與設定的管理員部門
3. **人資 API（`Auth:Directory=hrapi`）**：本機以規格書形狀的假 API 驗證過完整鏈路，
   但**尚未以正式配發的 `system`／`apiKey` 對真實端點呼叫過**（憑證未配發）

不論採哪一種形態，部署前都請完整跑過 §4 的驗證清單；如有問題請回報系統管理者。
