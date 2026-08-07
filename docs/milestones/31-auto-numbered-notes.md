# 節點 31：說明文字自動列點（v22.5）

## 背景

使用者需求原文：

> 現場查核回饋在填寫的時候應該可以讓他們主動去列點 1. 2. 之類的，然後 enter 換行就可以
> 自動從 1. 變成 2.，然後最後呈現的時候應該也要是條列式方式呈現，按照 1. 2. 這樣按照順序
> 排列。盤點一下所有需要填寫說明文字的部分，應該都要加入這個機制。

現場查核回饋常一次寫好幾件事（安全帶、電盤、工具箱紀錄…），全部擠成一段很難讀，
承辦回頭對帳時也不容易逐項核。

## 說明文字欄位盤點

| 欄位 | 型別 | 處理 |
|---|---|---|
| 現場查核回饋 `l_conclusion` | textarea | ✅ 套用（主要訴求） |
| 稽核・現場狀況說明 `auditNote` | textarea（動態） | ✅ 套用 |
| 稽核・不符原因 `.ai-reason` | input（動態）→ **改 textarea** | ✅ 套用（一個項目常有多個不符點） |
| 點工・廠商代辦備註 `l_vendorNote` | input → **改 textarea** | ✅ 套用（扣款、代辦事項可能多筆） |
| 機具・廠商代辦備註 `e_vendorNote` | input → **改 textarea** | ✅ 套用 |
| 工作內容補充 `l_categoryNote` | input | ❌ **不套用**——它是接在工作內容後面用「・」串接的短後綴，換行會讓報表該欄變成兩段 |
| 設定頁名單池 `cfg_*` | textarea | ❌ **絕不套用**——那是「一行一個名稱」的清單輸入，加編號會直接毀掉名單資料 |

> 根基自辦備註（`selfDoneNote`）沿用舊單資料，目前沒有輸入欄位，故不在範圍內。

## 做法

刻意做成**純文字**（每點一行，存進資料庫的仍是 `"1. …\n2. …"`），不引入 rich text
或結構化欄位——資料模型不動，舊單相容，匯出也不必特別轉換。

### 輸入（`initAutoNumber`）

- 只有「本行是編號行**且有內容**」按 Enter 才接下一號；一般文字照常換行
- **空的編號行按 Enter ＝結束列點**，把該行編號清掉（否則會一直長號碼下去）
- 每次都重新編號：連續編號行算同一組，遇到非編號行（含空行）從 1 重新起算，
  所以中間插一行，後面會自動順下去
- 接受 `1.` `1、` `1)` 三種起手式，一律正規化成 `1. `
- **中文輸入法組字中（`isComposing`）不介入**——否則選字用的 Enter 會被吃掉，
  注音使用者根本打不了字
- 離開欄位（blur）再整理一次：貼上或手動刪行造成的斷號在這裡補正
- 改寫 `.value` 後**補派 `input` 事件**：稽核不符原因是靠 `input` 監聽回寫
  `auditItemState`，少了這行會存到舊值

### 顯示

- `.fixed-table th,td` 由 `white-space:normal` 改 `pre-line`，讓存下的換行還原
- `cellHTML()`：值若是列點，逐點包成 `<div class="li">` 並做**懸掛縮排**
  （`padding-left:1.6em; text-indent:-1.6em`）——折行才會對齊文字而不是跑到編號正下方。
  必須逐點一個區塊：`text-indent` 只作用在區塊的第一行，整格套一個負縮排的話只有
  第 1 點會對，2. 3. 反而歪掉
- 稽核 PDF 的不符原因欄加 `white-space:pre-line`（現場狀況說明 `.note` 早已是 `pre-wrap`）

### 匯出

- **CSV**：既有的 `downloadCSV` 已對含 `\n` 的欄位加引號，實測換行未把資料拆成新列
- **xlsx**：新增兩個樣式 `TEXTW`／`PTEXTW`（＝原 `TEXT`／`PTEXT` 加 `wrapText`），
  在 `dataRowsXml` 與工種計價表的查核回饋欄依「值是否含換行」擇一使用。
  **沒有 wrapText 的話 Excel 會把整段擠成一行、換行只顯示成一個小方塊**——
  等於條列在 Excel 裡完全看不出來

## 驗證

**42 項自動檢查全數通過**（`scratchpad/test_autonum.js`＋`test_display_export.js`＋`test_xlsx.py`）：

- **編號邏輯 10 項**：連續重排、非編號行歸零、空行歸零、三種起手式正規化、
  內容含數字不誤判、位數變動（10.→1.）時游標跟著移、空字串不爆
- **鍵盤行為 9 項**：Enter 接號、空編號行結束列點、非編號行不介入、
  **輸入法組字中不介入**、Shift+Enter 不介入、中間插入後自動重排、游標落點正確、blur 整理
- **欄位範圍 5 項**：該套用的三個都在；設定頁名單池與工作內容補充**確認未被套用**
- **顯示 6 項**：pre-line 生效、三點各自成區塊、懸掛縮排、報表同樣條列、
  非列點文字不誤判、**列點內容仍經 `esc()` 無法注入標籤**
- **匯出 8 項**：CSV 引號與列數；xlsx 以 openpyxl 驗證儲存格保留三行且 `wrap_text=True`、
  單行欄位未被波及；**再以 Excel COM 實際開啟**確認樣式表 `cellXfs` 由 12 增為 14 未造成損毀
- v22.4 版面回歸重跑：四種視窗寬 × 四張表，壓欄／按鈕折行／徽章折行全為 0

### 過程中抓到的一個真 bug

`autoGrow()` 依 `scrollHeight` 撐高 textarea，但**面板收合／頁籤未切換時元素沒有版面，
`scrollHeight` 是 0**——照設會把欄位壓成高度 0 且不會自己恢復。
截圖驗證時看到 `height=0px` 才發現。修法兩道：

1. `autoGrow` 在 `offsetParent === null` 時直接放棄調整（不要寫入 0）
2. 兩個回報表單的 `refreshAutoGrow()` 呼叫移到 `expandPanel()`／`switchSubTab()` **之後**

## 影響範圍

- `frontend/app.js`：新增 `NUM_LINE`／`renumberLines`／`autoGrow`／`refreshAutoGrow`／
  `initAutoNumber`／`cellHTML`／`LIST_TEXT`；xlsx 樣式表 `cellXfs` 12→14
- `frontend/index.html`：兩個廠商代辦備註由 `input` 改 `textarea`
- `frontend/style.css`：`.fixed-table` 的 `pre-line`、`.li` 懸掛縮排、
  `textarea[data-autonum]` 高度上限
- **資料結構不變**，舊單完全相容（沒有換行的說明照舊顯示為單行）
