# 節點 40：Windows 驗證於網域環境實測通過，並補上 HTTP.sys 支援（v23.4）

## 背景

「Windows 整合驗證本身未在網域環境實測過（開發機無網域）」這句話，從節點 35
起就寫在 `DEPLOYMENT.md`、`AUTH-PLAN.md` 與每一份交付文件裡，也一直是上線前
最大的未知數。

上線前要驗證登入方式時才發現：**開發機本來就是網域成員**
（`kindomgroup\...`，登入伺服器 `\\AD06`）。先前的判斷是錯的，這件事一直可以測。

同時查出一個交付缺口：`DEPLOYMENT.md` §4.5 教資訊處以
「`UseHttpSys` 設 `Authentication.Schemes = Negotiate | NTLM`」啟用 Windows 驗證，
**但程式裡根本沒有這個設定點**——照文件做會找不到地方設。

## 變更內容

### 一、補上 HTTP.sys 支援（`KGAUDIT_HTTPSYS=1`，預設關閉）

- 主機有兩條路：**IIS 託管不需要程式碼**（ASP.NET Core Module 會把身分帶進來）；
  **Windows 服務／自主控管**才需要 HTTP.sys 提供 Negotiate/NTLM
- 設 `KGAUDIT_HTTPSYS=1` 即以 `Negotiate|NTLM` 監聽並 `AllowAnonymous = false`
- **預設關閉**，不設就完全維持原本的 Kestrel 行為；僅 Windows 有效
  （非 Windows 設了會略過，不讓服務起不來）
- `Microsoft.AspNetCore.Server.HttpSys` 在共用框架內，**不需新增套件**——
  維持「相依只有 `Microsoft.Data.SqlClient` 一個」

### 二、新增 `/whoami` 身分鏈診斷端點

部署 Windows 驗證最常見的問題是「不知道卡在哪一段」。此端點把四段結果攤開：
主機層是否帶入身分 → 去網域前綴後的帳號 → 目錄查到的工號與部門 → 授權結果。
斷在哪一段就回 `stoppedAt` 說明原因。

**刻意放在 `/api` 之外**：權限中介層只擋 `/api`，放進去會在授權失敗時被 403
擋掉——而那正是最需要診斷的時候。仍受整站 Basic Auth 保護，且只回報呼叫者
自己的身分，不能查別人。

## 實測結果（真實網域帳號）

```
hostAuthenticated : true
hostIdentity      : KINDOMGROUP\<帳號>
hostAuthType      : Negotiate          ← 確實走 Kerberos/NTLM
account           : <帳號>             ← 正確去除網域前綴
empId / deptName  : 由目錄取得
role              : Admin（部門命中管理員清單）
```

| 情境 | 結果 |
|---|---|
| 帶 Windows 身分開 `/whoami` | 200，身分鏈四段全通 |
| 不帶身分 | **401**（主機層擋下，`AllowAnonymous=false` 生效） |
| 帶身分打 `/api/data?scope=all` | 200 |
| 不帶身分打 `/api/data` | 401 |
| **冒名**：送 `X-Dev-User: someone_else` | 伺服器仍認 Kerberos 身分 |
| **冒名**：偽造 `Authorization: Negotiate <garbage>` | 伺服器仍認 Kerberos 身分 |
| **冒名**：多個自稱身分的標頭一起送 | 伺服器仍認 Kerberos 身分 |

**冒名三種嘗試全部無效**——這正是當初否決 SSO 導轉方案的理由
（規格書範例直接信前端送來的 AD 帳號字串）。Windows 模式下不存在該風險，
因為身分來自主機層的 Kerberos/NTLM 驗證，前端沒有任何可偽造的輸入。

## 影響範圍

| 檔案 | 變更 |
|---|---|
| `backend/onprem/dotnet/Program.cs` | HTTP.sys opt-in；`/whoami` 診斷端點 |
| `docs/DEPLOYMENT.md` | §4.5 兩種主機各自要做什麼、`/whoami` 用法；§8 測試狀態更正 |
| `docs/AUTH-PLAN.md` | §6 情境 7 與 Windows 驗證的實測結論 |

## 仍未驗證的一項

**人資 API 對真實端點的呼叫**。端點主機可連通（內網 443 通），
但正式的 `system`／`apiKey` 尚未配發，目前僅以規格書形狀的假 API 驗證過完整鏈路。
配發後以 `/whoami` 打一次即可確認（`Auth:Directory=hrapi`）。
