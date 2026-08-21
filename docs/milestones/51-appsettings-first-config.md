# 節點 51：部署設定改以 appsettings.json 為主（v24.8）

## 背景

資訊處在檢視交付包時提出兩件事：

1. **`appsettings.json` 裡的 `"Urls": "http://localhost:8080"` 需要部署時調整嗎？**
2. **不建議用環境變數。** 理由：多系統共存時環境變數名稱會互相打架、還得逐一改名；
   環境變數也墊高部署複雜度。設定請盡量寫在 `appsettings.json`，
   而且 **`appsettings.json` 是手動維護、不會整檔覆蓋**——所以每次改版若有
   設定異動，要**明確條列**「改哪個值、加哪個節點」。

兩點都採納。第 1 點在查證過程中還牽出一個會靜默出錯的問題（見下）。

## 查到的問題：`ASPNETCORE_URLS` 對這個交付包無效

以**發佈版執行檔**實測（不是 `dotnet run`——`launchSettings.json` 只影響前者，會誤導）：

| 情境 | 實際監聽 |
|---|---|
| 什麼都不設 | `127.0.0.1:8080`、`::1:8080` |
| 設 `ASPNETCORE_URLS=http://*:8099` | **仍然 `localhost:8080`** |
| 給 `--urls http://*:8098` | `:::8098` |

成因：`appsettings.json` 根層的 `"Urls"` 屬於**應用組態**，載入順序**晚於**
`ASPNETCORE_URLS`（主機組態），於是把環境變數靜默蓋掉。

而 `docs/DEPLOYMENT.md` 當時正是請資訊處用 `ASPNETCORE_URLS` 開放對外連線——
**照文件做會沒有效果，服務只綁本機、全公司連不上，而且完全不報錯。**
這正是節點 42 想防的那一類「部署組態設錯且不會報錯」。

> ⚠ 另一個相鄰的坑（原註解已記載，保留）：改用 `Kestrel:Endpoints` 也不行——
> 它的優先權**高於**命令列 `--urls`，設了之後 `--urls` 會靜默失效。

## 做法

### ① 所有部署設定都能寫在 appsettings，環境變數降為選用覆寫

新增統一的讀取器 `Cfg`，優先權一律 **環境變數 ＞ appsettings ＞ 程式預設**：

```csharp
Cfg.Str("STATIC_DIR", "App:StaticDir")     // 字串
Cfg.Flag("KGAUDIT_HTTPSYS", "App:UseHttpSys")  // 布林
```

保留環境變數覆寫的兩個理由：既有以環境變數部署者不會壞掉；
資安政策要求密碼不落檔時，可以**只**把密碼那一項移出去，不必全搬。

原本散在各處直接呼叫 `Environment.GetEnvironmentVariable` 的九處全部收斂到這裡。
新增 `App` 節點承接原本只能靠環境變數的五項：

| 原環境變數 | 新 appsettings 鍵 |
|---|---|
| `STATIC_DIR` | `App:StaticDir` |
| `ATTACH_DIR` | `App:AttachDir` |
| `SITE_AUTH_USER` / `SITE_AUTH_PASS` | `App:BasicAuthUser` / `App:BasicAuthPassword` |
| `KGAUDIT_HTTPSYS` | `App:UseHttpSys` |
| `KGAUDIT_ALLOW_INSECURE` | `App:AllowInsecureConfig` |

另補上 `ConnectionStrings:KgAuditErp` 的**實際鍵**——原本只有 `_KgAuditErp` 註解，
底線前綴不會被讀取，填在那裡不會有錯誤訊息，會在啟用權限後變成全員 503。

### ② 監聽位址改用 `App:Urls`，不用根層 `"Urls"`

用獨立鍵名，優先權才與其他設定一致：**`--urls` ＞ `ASPNETCORE_URLS` ＞ `App:Urls` ＞ 預設**。

> 為什麼不乾脆保留根層 `"Urls"`（反正資訊處要的就是寫在 appsettings）：
> 同一份設定檔裡出現兩套相反的優先權規則，才是真正難查的東西。
> 一致比方便重要。

### ③ 設錯會被點名，不再靜默

上線組態守衛新增三則檢查（非開發環境）：

- **只綁在 loopback**：啟動後讀 `IServerAddressesFeature`，全部是 `localhost`／`127.0.0.1`／`[::1]`
  就發警告。訊息本身講明「若反向代理在同一台機器上，這是正確設定，可忽略本則」，避免誤導。
- **連線字串仍指向 `(localdb)`**：交付包的開發預設值忘了改，服務照樣啟動、
  要等第一個請求才失敗。
- **`App:AttachDir` 未設定**：附件會寫進執行檔旁的預設路徑，
  改版重新部署覆蓋整個目錄時，簽單掃描檔會一併消失。

## 資訊處要做的 appsettings 異動

`appsettings.json` 為手動維護，**請只比對差異、逐項補上，不要整檔覆蓋**
（會沖掉已填的連線字串與密碼）。清單同時列在 `docs/DEPLOYMENT.md` §③。

| 動作 | 內容 |
|---|---|
| **新增** | 整個 `App` 節點（`Urls`／`StaticDir`／`AttachDir`／`BasicAuthUser`／`BasicAuthPassword`／`UseHttpSys`／`AllowInsecureConfig`） |
| **新增** | `ConnectionStrings:KgAuditErp`（不啟用權限可留空字串） |
| **刪除** | 根層的 `"Urls"` 那一行 |

## 驗證（全部以**發佈版執行檔**實測）

**監聽位址優先權矩陣**

| 情境 | `App:Urls` | 環境變數 | `--urls` | 實際監聽 | 本機限定警告 |
|---|---|---|---|---|---|
| A | `http://*:8090` | – | – | `:::8090` | 無 |
| B | `http://localhost:8080` | – | – | `::1:8080, 127.0.0.1:8080` | **有** |
| C | `http://localhost:8080` | `http://*:8091` | – | `:::8091` | 無 |
| D | `http://localhost:8080` | `http://*:8091` | `http://*:8092` | `:::8092` | 無 |
| E | （留空） | – | – | `::1:8080, 127.0.0.1:8080` | **有** |

**零環境變數的完整部署**（設定全部只寫在 appsettings）

- `App:Urls` → 服務在指定埠回應 ✔
- `App:BasicAuthUser`／`BasicAuthPassword` → 無帳密 401、舊帳密 401、新帳密 200 ✔
- `ConnectionStrings:KgAudit` → `scope=all` 回 200 且日誌無 `SqlException` ✔
- `App:StaticDir` → 首頁回 200 並送出該目錄的 index.html ✔
- `App:AttachDir` → 指定目錄被建立 ✔

**守衛**：原封不動跑交付包預設值，五則警告全數發出（LocalDB 連線字串、
未設 AttachDir、`Auth:Mode=Off`、靜態目錄不存在、只監聽本機位址）。

`dotnet build` 0 警告 0 錯誤。

> ⚠ 過程中兩次誤判都出在測試腳本而非產品，記下來避免重蹈：
> ① 用 `dotnet run` 測監聽位址——`launchSettings.json` 的 `applicationUrl` 會蓋掉一切，
>    量到的不是部署行為，**一律用發佈版執行檔測**。
> ② `Process.Start` 沒設 `WorkingDirectory`——讀到的是**原始碼**那份 `appsettings.json`，
>    改了發佈目錄的檔案卻毫無反應。

---

## 補強：兩輪 code review 共 16 項修正（2026-08-21）

節點 51 交付前跑了兩輪 code review。第一輪 11 項是針對節點 51 本身，
**第二輪 6 項是針對第一輪的修正**——修正本身也會有 bug，值得記一筆。

### 第一輪（11 項）

同一個病根佔了三項：**這次改的是「設定要寫在哪」，但好幾處講「設定要寫在哪」的
文字沒跟著改**，而那些正是資訊處最會讀到的地方。

| 位置 | 問題 |
|---|---|
| `Program.cs` 檔首註解 | 仍條列「環境變數：KGAUDIT_CONNECTION…」——正是資訊處要求改掉的那份清單，而且是讀這支檔案第一眼看到的東西 |
| `Auth.cs` 缺 ERP 連線的例外 | 仍叫人設 `KGAUDIT_ERP_CONNECTION`；而首次以 `Auth:Mode=Windows` 部署時本來就會缺，正是最會看到這句的時機 |
| 工地納管候選端點的 `reason` | 同上 |

其餘八項：

- **`ASPNETCORE_URLS` 之外又多了個沒寫進文件的 `KGAUDIT_URLS`**——改成不吃額外環境變數，
  覆寫只留框架原生的 `--urls`／`ASPNETCORE_URLS`，與文件一致
- **loopback 警告的建議值寫死 `http://*:8080`**——對方若用 8096，照著改會連埠都被換掉；
  改成依實際監聽位址推導
- **IIS out-of-process 承載會誤報 loopback 警告**（詳見下節）
- **`Cfg.Flag` 兩個來源的寫法不對稱**：環境變數收 `"1"`，appsettings 只收 `true`；
  把 `KGAUDIT_HTTPSYS=1` 照抄成 `"UseHttpSys": "1"` 會靜默失效。改成共用同一個 `Truthy()`
- **`ConnStr()` 每次呼叫都重讀設定**，而同一個 commit 才剛把 Basic Auth 帳密提到啟動時解析；
  連線字串鍵當時散在三處。改成解析一次、守衛與 `ConnStr()` 共用
- **`Cfg.Root` 回 null 會靜默出錯**：`Wr.AttachRoot` 讀不到設定時會安靜地落到執行檔旁的預設路徑。改成 getter 丟例外
- `Cfg.Str` 的 `fallback` 參數無人使用；Basic Auth 中介層留了兩行空轉的區域變數

### ⚠ IIS 承載的誤報（第一輪抓到、第二輪才修對）

第一輪的註解寫「IIS／HTTP.sys 託管時位址由主機指派、不會是 loopback，因此不會誤報」——
**這句是錯的**。out-of-process 模式下 ANCM 才是對外的那一端，本程序的 Kestrel
**依設計只綁 `127.0.0.1`**，全部都是 loopback。照原邏輯會在每次啟動誤報，
還叫人去改 `App:Urls`，照做反而會拆掉 ANCM 的交握。

已加入 `HostedByIis()` 跳過，判準與框架自己一致（in-process 看伺服器型別、
out-of-process 看 `ASPNETCORE_PORT` ＋ `ASPNETCORE_TOKEN`），並額外並列
ANCM 的 `ASPNETCORE_IIS_*` 變數作保險——型別名稱是字串比對，框架改名就會靜默失效。

### 第二輪（6 項，針對第一輪的修正）

- **守衛拒絕啟動時的 guide 訊息仍只提 `KGAUDIT_ALLOW_INSECURE=1`**——與上面三項同一類，
  第一輪漏了這處，而它是 `LogCritical` ＋例外訊息，是整個部署最會被讀到的一句話
- **`Cfg.Root` 丟例外的時機不對**：註解寫「啟動即失敗」，但 `Wr` 是靜態欄位初始化，
  第一次碰到它是在**請求處理中**——會變成第一個 API 請求回泛用 500，比原本更難查。
  改成啟動時主動觸發 `Wr.AttachRoot`；順帶讓**附件目錄路徑或權限設錯也在啟動就失敗**，
  而不是等到有人上傳簽單
- **`IsLoopbackAddr` 用字串包含判斷**，`http://localhost.corp.example.com:8080` 這種
  真的對外的主機名會被判成 loopback。改用 .NET 原生的 `Uri.IsLoopback`
  （萬用位址 `http://*:8080` 不是合法 Uri → 視為非 loopback → 不警告，正是要的行為）
- **建議值只取第一個位址**：同時綁 HTTP 與 HTTPS 時，照著貼會弄丟 HTTPS 那個。改成全部列出
- `HostedByIis` 的型別名稱字串比對加了環境變數保險（見上）
- 本節補強未追加留痕（就是這一段）

### 補強的驗證

**監聽位址與警告（發佈版執行檔，9 情境）**

| 情境 | 監聽 | 本機警告 | 建議值 |
|---|---|---|---|
| `App:Urls=http://*:8090` | `:::8090` | 無 | — |
| `App:Urls=http://localhost:8080` | loopback | 有 | `http://*:8080` |
| `App:Urls=http://localhost:8096` | loopback | 有 | `http://*:8096` |
| `App:Urls=http://127.0.0.1:8094` | loopback | 有 | `http://*:8094` |
| 環境變數 `ASPNETCORE_URLS` 覆寫 | `:::8091` | 無 | — |
| 命令列 `--urls` | `:::8092` | 無 | — |
| `App:Urls` 留空 → 程式預設 | loopback | 有 | `http://*:8080` |
| 本機 ＋ 模擬 IIS out-of-process | loopback | **無**（正確跳過） | — |
| 本機 ＋ 模擬 IIS in-process | loopback | **無**（正確跳過） | — |

**其餘**

- `App:AllowInsecureConfig=true` → 服務啟動並額外印出具名警告；改用環境變數則**不**印
  （環境變數不會跟著檔案傳播，只有設定檔這條路要點名）
- 守衛拒絕啟動時的 guide 已改為先講 `App:AllowInsecureConfig`，並附註「設在 appsettings
  會隨檔案沿用到正式環境」
- `"UseHttpSys": "1"`（字串）確實啟用 HTTP.sys——證據是監聽位址變成 `http://localhost:8080/`
  帶結尾斜線，那是 HTTP.sys 的前綴格式，Kestrel 不帶
- `App:AttachDir` 指向不存在的磁碟 → **啟動即失敗**，訊息指名 `App:AttachDir`
  並附上 `DirectoryNotFoundException`（改前要等第一個上傳才 500）

`dotnet build` 0 警告 0 錯誤。
