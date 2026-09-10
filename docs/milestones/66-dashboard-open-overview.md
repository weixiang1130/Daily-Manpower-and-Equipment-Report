# 節點 66：總覽分區開放全員（2026-09-10）

## 背景

使用者要求：**只要能進入系統的人，總覽都看得到**，但只能點進自己有權限的工地，
未開通的站點進去要被擋。四個區塊的分界由使用者逐一裁示：

| 總覽區塊 | 範圍 |
|---|---|
| 整體概況（六張卡片） | **全部工地**，全員可見 |
| 本月出工量排名（工地榜/分包商榜） | **全部工地**，全員可見 |
| 追蹤提醒 | 只列**自己可進入**的工地 |
| 各工地列控總覽、最近出工回報紀錄 | 只列**自己可進入**的工地 |

## 設計：瘦身投影，口徑不搬家

改版前後端把看不到的站**整包移除**；要讓全員算得出全站卡片與排名，
選項有二：伺服器算好數字下發，或下發最小欄位集的紀錄。採**後者**——
卡片與排名的口徑（`reportTypeRows`／`trackLeftDays`／20 天窗口/月租基準日）
全在前端且是唯一權威，在 C# 重寫第二份必然分家（v24.6 教訓）。

`SlimOverviewStore`（Program.cs）對未授權站只下發：
- 點工：date/status/vendor/categories＋report{reportedAt, diff, signReturnDate,
  zeroWork, actual, totalOT, workTypes[{type, work}]}
- 機具：date/status/billing/rentTo＋report{signReturnDate}
- **不下發**：id、一切人名、地點、內容、備註、逐人/逐台明細、代辦、稽核、附件、名單池
- `overviewOnly: true` 標記＋`config: {}`（不能 null——boot 的種子邏輯會誤發
  apiSaveConfig 且必 403）

`master.sites` 改列**全部**啟用中工地；`?site=` 讀取與所有寫入的 CanSee 403 守衛
**原樣不動**（隔離的防線在那裡，瘦身投影只是把「統計上必要的最小資料」放行）。

## 前端

- `siteEnterable(site)`＝`!store.overviewOnly`（**以資料為準**，不用 AUTHZ.sites
  另比對——兩份來源有先後差）；雲端／Auth Off 無標記 → 一律可進，行為不變。
- 選站攔截頁與切站下拉：全部列出，未授權的鎖住（🔒＋disabled／點擊提示洽成控）。
- `switchSiteContext` 入口擋（追蹤列點擊、記住的舊站名都會走進來）。
- 總覽分流：卡片計數（overdue/sign）在 collect 內對**全站**累加、
  追蹤清單只 push 可進入的站；列控總覽與最近回報改 `enterableSites()`。
- ⚠ 三個踩過就會炸的點：
  1. **SITE_CACHE 重建（boot/refreshData）必須保留 `overviewOnly`**——掉了等於全站解鎖
  2. **自動進站改看 `enterableSites()`**——master.sites 變 12 站後，單站使用者的
     v20 免選直進會失效、記住的站被收回權限會直接進到看不了的站
  3. refreshData 的 currentSite 回退要同時判「站被移除」與「被收回權限」

## 驗證

- 後端 `dotnet build` 0 警告 0 錯誤。
- 瀏覽器實載注入「1 個自己的站＋1 個瘦身站」心算級資料，全數相符：
  卡片＝全站（回報 2／逾期未回報 3／異常 1／點工待 2／機具待 1／簽單未繳 1）、
  工地榜與分包商榜含兩站、追蹤/列控/最近回報只剩自己的站、
  切換到瘦身站被擋且 currentSite 不動、攔截頁與下拉出現 🔒 鎖定項。
- 真實多角色的端到端（工程師/主管/成控 各 port）待三節點併包後
  於本機上線模擬環境一次驗證。

## MAX 審查修正（2026-09-10，與 64/65 同批）

1. **enterableSites() 為空的死路**：授權整組被收回時 refreshData 會把 currentSite
   設成 undefined → cur() TypeError 整頁半殘且被 silent catch 吞掉——改回選站畫面；
   選站頁全鎖狀態補引導文字；toast z-index 原本低於遮罩（點鎖定站毫無回饋）一併修。
2. **瘦身投影三修**：①加班分段欄位帶齊（ot2Total/otOverTotal＋workTypes.ot2/otOver，
   防未來全站加班指標口徑分家）②只投影總覽讀得到的紀錄（待回報∨本月已回報∨簽單未繳，
   防 payload 隨封存月份無界成長）③已退場站（is_active=0）對非可見者整包不回。
3. **假完整檔封堵**：完整備份/切換日遷移包含瘦身站時擋下（匯入工具會靜默跳過
   無 id 紀錄，資訊處會拿到「看起來完整、多數站空殼」的搬遷檔）。
4. **範圍註記**：追蹤提醒/最近回報/列控總覽標題改「（我的工地）」、
   卡片與清單的差額在清單尾註交代（另有 N 張在未開通的工地）；
   鎖檔「套用到全部工地」改只發可進入的站（原本必 403 整批報失敗）。
5. 快取一致性：refetchSite 補 overviewOnly（第三個重建點，掉了等於全站解鎖）；
   瘦身站跳過 sortRecords/StripAudits（無 id/無 audits 的恆等操作）；
   稽核頁選站補 🔒 標示；設定頁儲存的回退站改挑可進入的站。
