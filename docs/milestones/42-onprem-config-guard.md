# 節點 42 — 地端上線組態守衛（防「一個字設錯就靜默破功」）

> 僅動 `backend/onprem/dotnet/`，不影響雲端與前端；線上版本仍為 v23.5。

## 背景

移交資訊處地端部署前做了一次完整資安盤點。結論是：**地端 .NET 版的授權層品質足夠，
真正的風險在「部署組態設錯」**——而這些設錯**都不會報錯**，只會讓系統安靜地門戶大開：

- `Auth:Mode=Off`（預設值）：停掉物件層級授權與稽核隔離、`clearAll` 等破壞性操作只剩 Basic Auth 把守
- `Auth:Mode=Dev`：身分由 `X-Dev-User` 標頭指定＝任何人可冒充任何員工/管理員
- `Auth:Mode=Windows` 但 `Auth:Directory` 非 `hrapi`：用設定檔假名單，正式環境每個 AD 帳號都查無資料，
  全員（含管理員）被 403 鎖在門外——服務看似正常卻不可用

使用者的部署場景已定案為「**只限公司網域電腦，外網與手機不可用**」，其安全模型因此**繫於
`Auth:Mode=Windows` 這個開關不能設錯**。把「設錯就破功」變成「設錯根本起不來」是最穩妥的防線。

## 變更內容

- **`Program.cs` 檔首（`builder.Build()` 後）新增啟動組態守衛**：非開發環境偵測到上述不安全/不可上線
  組態即以 `LogCritical` 印出原因與解法後 **拋例外拒絕啟動**（非零結束碼，IIS／Windows 服務判為啟動失敗）。
- **逃生口**：開發／測試機用 `ASPNETCORE_ENVIRONMENT=Development`（已附 `Properties/launchSettings.json`，
  `dotnet run` 即為 Development）；明確承擔風險的過渡期設 `KGAUDIT_ALLOW_INSECURE=1` 降為警告放行。
- **僅警告不擋啟動**：`Auth:Mode=Windows` 但仍設著 `SITE_AUTH_PASS`（共用帳密，Windows 驗證下應移除）。
- 移除 `Auth.cs` 前的舊 Dev 警告（已由檔首守衛統一發出，避免兩處重複維護同一訊息）。
- 同步 `DEPLOYMENT.md §4.5` 說明此「拒絕啟動」為刻意設計，並列出三種解法。

## 設計決策 / 取捨

- **以「非 `Development`」判定，而非 `IsProduction()`**：交付前 code review 抓到的關鍵缺口——
  `IsProduction()` 只認字面 `"Production"`，把環境命名為 `Prod`／`Staging`（很常見）會整個繞過守衛、
  帶著 `Mode=Off` 門戶大開地啟動。改用 `!IsDevelopment()` 讓**除了明確開發環境外一律 fail-closed**。
- **`Windows`＋非 `hrapi` 列為 fatal 而非僅警告**（同 code review）：假名單在正式環境會讓全員（含管理員）
  被鎖，服務看似正常卻全站不可用，屬「不可上線」而非「風險偏好」，應直接擋下。
- **用 `throw` 而非 `Environment.Exit`**：確保 Critical 訊息確實寫出、結束碼非零，服務管理員偵測得到失敗啟動。
- **保留 `KGAUDIT_ALLOW_INSECURE` 逃生口**：切換日以 Basic Auth 對帳等過渡情境仍需短時間跑 `Mode=Off`，
  但必須是**明確、知情**的選擇，而非預設。

## 影響範圍

- 檔案：`backend/onprem/dotnet/Program.cs`、新增 `backend/onprem/dotnet/Properties/launchSettings.json`、
  `docs/DEPLOYMENT.md`。**無資料結構變動**、無 API 合約變動、前端與雲端零修改。
- ⚠ 既有的地端 .NET 測試腳本若以 Production 環境跑 `Mode=Off`/`Dev` 對帳，現在會被守衛擋下——
  需設 `ASPNETCORE_ENVIRONMENT=Development`（或 `KGAUDIT_ALLOW_INSECURE=1`）。這是預期行為、不是壞掉。

## 驗證

`dotnet build -c Release` 0 警告 0 錯誤。啟動組態矩陣八情境實跑：

| 情境 | 預期 | 結果 |
|---|---|---|
| Production／Staging／`Prod` + `Mode=Off` | 拒啟 | ✅ 拋例外、結束碼非零、無 `Now listening` |
| Production + `Mode=Dev` | 拒啟 | ✅ |
| Production + `Windows` + `config` | 拒啟 | ✅ |
| Development + `Mode=Off` | 放行 | ✅ 正常 listening |
| Production + `Off` + `ALLOW_INSECURE=1` | 警告後放行 | ✅ |
| Production + `Windows` + `hrapi`（合法） | 放行 | ✅ |
