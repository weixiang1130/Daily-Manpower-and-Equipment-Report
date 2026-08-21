# 節點 54：工地看不到的成因分不出來——`sites.project_code` 對映與 `/whoami` 診斷

> 2026-08-21・地端 UAT 部署支援

## 背景

UAT 期間回報一個案例：某位工地主任的部門就是 A 工地、人也在 A 工地，
但登入後只看得到 B 工地。`/whoami` 的輸出是：

```json
{ "onJob": true, "role": "SiteLead", "allSites": false, "sites": ["B 工地"] }
```

身分鏈四段全通、角色也判對了，就是少一個工地。而這個輸出**沒有任何線索**
指出少的原因。

「少一個工地」有兩種成因，畫面與 `/whoami` 的表現一模一樣，查修方向卻相反：

| 成因 | 要找誰 |
|---|---|
| ① ERP 權限檢視表沒把那個專案給這個人 | ERP 權限管理者 |
| ② ERP 給了，但該工地的 `sites.project_code` 沒填 | 我們自己的部署設定 |

實際查證後是 ②：ERP 端該工號在 5 個專案都有工地角色，其中就包含他自己的工地；
地端 `sites` 表只有一個工地填了 `project_code`。

## 為什麼會漏填——這不是使用者的疏忽，是交付的缺口

`sites.project_code` 是**地端才有**的欄位（雲端沒有權限機制），因此
**資料匯出的內容裡沒有它**。用備份 JSON 轉出來的 SQL 匯入之後，
所有工地的 `project_code` 一律是 `NULL`。

而這個狀態的症狀是最不容易察覺的一種：

- 服務正常、`/health` 正常、資料筆數全對
- 管理員登入看得到**全部**工地（管理員走的是部門白名單，不經 `project_code`）
- 唯獨工地人員登入後是空的，**而且完全不會有錯誤訊息**

驗證部署的人通常就是管理員——他看到的一切都正常。

## 變更內容

### 1. `/whoami` 攤開 ERP 專案與對映結果（`Auth.cs`／`Program.cs`）

`Authz` 增加兩個 init-only 診斷欄位（**不參與任何判定**，與節點 53 的
`RawIsOnJob`／`RawLeaveDate` 同一個模式）：

- `ErpProjects`：ERP 權限檢視表回給這個人的專案代碼
- `UnmappedProjects`：其中在 `dbo.sites` 換不出工地名的那些

`/whoami` 在**非全站角色**時輸出這兩項，並在有未對映項目時給出修正指引。
一次請求就分得出 ① 和 ②。

### 2. 對映腳本納入資料交付（`交付_資訊處/`，不進版控）

資料匯入包從一支變成兩支，`02-set-project-code.sql` 負責填 `project_code`，
並帶一個自我檢查：還有啟用中的工地沒對映到就**印出工地名並以非零結束碼收場**。

⚠ 這支腳本**刻意不回滾**——對得上的那幾站寫進去是正確的，沒理由因為一個
名稱不符就整批退掉；改好名稱重跑即可（`UPDATE` 冪等）。

## 踩到的坑

- **`SET XACT_ABORT ON` 不會因 `RAISERROR` 而回滾**。嚴重性 16 的使用者錯誤
  不觸發批次中止，後面的 `COMMIT` 照樣執行。第一版的註解寫「失敗並回滾」，
  實測才發現行為相反——已改成先 `COMMIT` 再檢查，並把實測結論寫進註解。
- **`sites` 有篩選索引**（`WHERE project_code IS NOT NULL`），
  而 sqlcmd 預設 `QUOTED_IDENTIFIER OFF` → `UPDATE` 直接以錯誤 1934 失敗。
  腳本開頭必須自己 `SET QUOTED_IDENTIFIER ON`（建表腳本早就有，新腳本容易漏）。

## 驗證

以拋棄式 LocalDB 完整重現一次：空庫 → 建表 → 匯入 → 跑對映腳本 →
以發佈版執行檔啟動服務（`Auth:Mode=Dev`＋真實 ERP 連線）→ 打 `/whoami`。

- 對映前：只看得到 1 個工地（重現回報的症狀）
- 對映後：兩個工地都出現，`unmappedProjects` 正確列出「不屬於本系統的專案」
- 對映腳本的失敗路徑（故意改壞一個工地名稱）：印出該工地名、結束碼非 0，
  已對映的部分保留

## 影響範圍

| 檔案 | 變更 |
|---|---|
| `backend/onprem/dotnet/Auth.cs` | `Authz` 加兩個診斷欄位；`ComputeAsync` 記錄對映命中 |
| `backend/onprem/dotnet/Program.cs` | `/whoami` 輸出 `erpProjects`／`unmappedProjects`＋指引 |

資料結構未變動，前端未變動。地端需重新編譯。
