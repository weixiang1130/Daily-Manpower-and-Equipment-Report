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
