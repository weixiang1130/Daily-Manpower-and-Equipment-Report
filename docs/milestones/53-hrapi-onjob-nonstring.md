# 節點 53：人資 API 非字串欄位導致全員被判離職（v24.10）

## 症狀

地端首次以 `Auth:Mode=Windows` ＋ `Auth:Directory=hrapi` 部署，**所有人都沒有權限**。
`/whoami` 的回應看起來身分鏈整條是通的：

```json
{ "authMode":"Windows", "directory":"hrapi",
  "hostAuthenticated":true, "hostAuthType":"Negotiate",
  "account":"<帳號>", "empId":"<工號>", "name":"<姓名>", "deptName":"<管理員部門>",
  "onJob": false,
  "stoppedAt":"③ 無任何權限——部門不在管理員清單，且 ERP 查無工地角色" }
```

主機層驗證通過、人資 API 也查到了工號／姓名／部門——**只有 `onJob` 是 false**，
而該員實際在職，且部門就在管理員清單裡。

## 根因

`Auth.cs` 的 JSON 取值輔助函式只接受**字串**：

```csharp
static string? S(JsonObject o, string k) =>
    o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;   // 舊
```

人資 API 的 `isOnJob` 回的是**布林／數字**而非字串 `"1"`，於是 `S()` 回 `null`、
`null == "1"` 為 false，**在職判定一律 false**。

而 `ResolveAsync` 的第一行就是：

```csharp
if (!user.OnJob) return null;   // 離職者即使 ERP 權限資料未清理也拒絕
```

所以**每一個人**都在權限判定之前就被拒絕——不論部門、不論 ERP 角色。

> ⚠ 為什麼特別難查：`userName`／`deptName` **完全正常**（那兩個本來就是字串），
> 只有非字串的那個欄位壞掉。畫面上看到的是「身分查得到、就是沒權限」，
> 很自然會往「部門字串對不上」或「ERP 權限沒設好」的方向找。

## 診斷端點也指錯位置（第二個問題）

`/whoami` 存在的意義就是講出身分鏈斷在哪一段，但這個情況它回報：

> ③ 無任何權限——部門不在管理員清單，且 ERP 查無工地角色
> hint：若此人應為管理員，請比對上方 deptName 與設定的管理員部門是否**逐字**相同

**兩句都不成立**——`ResolveAsync` 根本沒走到部門比對，也沒查過 ERP。
照這個提示去逐字比對部門是條死路（首次部署就是這樣被誤導的）。

## 做法

1. **`S()` 接受非字串純量**（布林／數字轉成文字），註明為什麼不能只認字串
2. **在職判定放寬「表示法」但不放寬語意**：接受 `1`／`true`／`Y`（不分大小寫），
   其餘一律視為非在職。欄位缺失＝拒絕（fail-closed，離職者不得放行）
3. **`UserIdentity` 帶出人資 API 的原始 `isOnJob`／`leaveDate`**，僅供診斷、不參與判定
4. **`/whoami` 新增 `②-b` 分支**：在職判定不通過時單獨回報，並附上兩個原始值，
   讓人分得出「真的離職」與「欄位格式不如預期」

## 驗證

**解析（8 種 JSON 形狀）**

| 情境 | `isOnJob` | `leaveDate` | 判定 |
|---|---|---|---|
| 規格書寫法 | `"1"` | `""` | ✔ 在職 |
| 實測疑似 | `true` | `null` | ✔ 在職 |
| 數字 | `1` | `""` | ✔ 在職 |
| 另一種寫法 | `"Y"` | `""` | ✔ 在職 |
| 真的離職 | `false` | `null` | ✘ 拒絕 |
| 真的離職 | `0` | `""` | ✘ 拒絕 |
| 在職但有離職日 | `true` | `2026-06-30` | ✘ 拒絕 |
| 欄位不存在 | －  | `""` | ✘ 拒絕（fail-closed）|

**`/whoami`（實際服務，Dev 目錄三個假身分）**

| 身分 | 結果 |
|---|---|
| 在職 ＋ 管理員部門 | 通過，`role=Admin`、`isAdmin=true` |
| 非在職 | **`②-b 在職判定不通過`**（不再誤報成 ③），附原始值與正確提示 |
| 在職 ＋ 部門不在清單 | `③ 無任何權限`（這才是 ③ 該出現的時機） |

`dotnet build` 0 警告 0 錯誤。

## 給資訊處的動作

重新編譯部署後再打一次 `/whoami`：

- 若 `onJob` 變成 `true` → 問題解決
- 若仍是 `false` → 看新增的 `hrIsOnJob`／`hrLeaveDate` 兩個原始值，
  即可判斷是人資 API 真的回報離職，還是欄位值超出目前接受的範圍
