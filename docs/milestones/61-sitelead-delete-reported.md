# 節點 61：工地主管可刪除自己工地的已回報單（2026-08-28）

## 背景

節點 57 把「已回報單僅限管理員刪除」補上伺服器端把關後，工地主管覆核時發現錯單
也只能找管理員代刪。使用者要求賦予工地主管管理員權限；經確認範圍後**收斂為單一項能力**：
主管在**自己負責的工地**內可刪除已回報單。其餘管理員能力（跨站可見、改工地清單、
清空資料、稽核模組）一律不給。

## 決策：主管身分**逐站**認定，不是逐人

`Role.SiteLead` 是整體角色，但一個人可能在 A 站是主任、B 站只是工程師。若用整體角色
判定，他在 B 站也會取得刪除權——那是越權。因此新增 `Authz.LeadSites`：
ERP 權限檢視表逐列讀取時，只把 **RoleName 命中 SiteLeadRoles（Director）的那些
ProjectID** 收進 `leadProjects`，再對映成 `leadSites`。

三條邊界：

1. **授權覆寫（節點 55）給的站不進 LeadSites**——覆寫是「臨時支援」不是「主管職」，
   被授予者只取得申請與回報，不取得刪除已回報單的權限。
2. **鎖檔優先**：`LockGuard` 在 `ReportedDeleteGuard` 之前執行且不看主管身分，
   主管一樣刪不掉鎖檔區間內的單（結算凍結是實質控制）。
3. **管理員不受站別限制**：`CanDeleteReported = IsAdmin || LeadSites.Contains(site)`。

## 實作

- `Auth.cs`：`Authz.LeadSites` ＋ `CanDeleteReported(site)`；`ComputeAsync` 逐列記錄
  Director 專案並對映成工地名。
- `Program.cs`：`ReportedDeleteGuard` 收 `Authz` 參數，改判 `!az.CanDeleteReported(site)`；
  403 訊息改為「僅限管理員或該工地主管刪除」。
- `Program.cs` `/whoami`：新增 `leadSites` ＋ **`canDeleteReportedScope`**（直接講出可刪範圍）。
  ⚠ 管理員的 `leadSites` 恆為空（規則 1／3 早退），只看該欄位會得出「管理員不能刪」的
  相反結論——節點 53／54 的教訓，故另給語意欄位。
- `app.js`：新增 `AUTHZ` ＋ `loadAuthz()`（開站時與主資料並行取 `/whoami`）＋
  `canDeleteReported(site)`；點工／機具兩處刪除閘門由 `isAdmin()` 改用它。
  **取不到 `/whoami`（雲端／`Auth:Mode=Off`／舊部署）一律退回 adminPin 行為**，
  與改版前完全相同。

> ⚠ **前後端必須成對**：後端放行但前端仍以 adminPin 擋，主管在瀏覽器就被擋住、
> 請求根本不會送出，整個功能形同虛設（本節點 code review 實際抓到此狀態）。

## 驗證（真實 ERP × 正式資料鏡像 × 瀏覽器）

伺服器端七項矩陣（LocalDB 鏡像，正式庫全程未寫入）：

| 情境 | 結果 |
|---|---|
| 主管刪自己 Director 站的已回報單 | 200 已刪 ✅ |
| 同一人刪**覆寫**授予站的已回報單 | 403（訊息來自守衛，證實非 CanSee 擋下）✅ |
| 主管刪自己站但在**鎖檔區間**內 | 403 鎖檔優先 ✅ |
| 同主管刪自己站、鎖檔區間外 | 200 已刪 ✅ |
| 一般工程師刪自己站已回報單 | 403 ✅ |
| 管理員刪任一站 | 200 已刪 ✅ |
| 對看不到的站發動刪除 | 403（CanSee）✅ |

前端（以單站主管身分、**未輸入 adminPin**）：`AUTHZ.role=SiteLead`、
`leadSites=[本站]`、`canDeleteReported(本站)=true`、`canDeleteReported(覆寫站)=false`；
實際於畫面刪除一筆已回報單 → toast「已刪除」且資料庫確認已消失。

`/whoami` 診斷：主管顯示可刪站名、工程師顯示「（無——非管理員且非任何工地的主管）」、
管理員顯示「全部工地（系統管理者）」。

## ⚠ 實際影響範圍（部署前須知）

實查正式 ERP（唯讀）：本系統 12 站共 **20 人**具 Director 角色，其中
**4 人在全部 12 站都是 Director**（6 人 ≥5 站、6 人僅 1 站）。
亦即這 4 人實質取得全 12 站的「刪除已回報單」權限——設計上正確（他們確實是那些站的
主管），但 blast radius 需知情。仍**不含**清空資料、改設定、稽核模組。
