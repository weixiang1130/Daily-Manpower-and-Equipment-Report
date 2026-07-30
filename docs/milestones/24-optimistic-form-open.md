# 節點 24 — 開表單樂觀渲染與 baseV 快照（v18）

## 背景

使用者回饋「清單點『填寫回報』跳轉到表單的速度不夠快」。實測正式站：四個載入入口（點工/機具 × 申請/回報）都會先 `await refetchSite()` 重抓整個工地資料（主力工地 149KB／200+ 筆）才渲染表單，需等 1.1～3.7 秒（冷啟更久）。

## 變更內容

- **樂觀渲染**：四個載入入口改為先用 `SITE_CACHE` 快取即時開表單，再呼叫 `bgRefetchVerify()` 於背景抓最新版校正；快取沒有該筆才退回等待網路。慢速網路（1.5s）實測開表單 1500ms+ → **61ms**
- **baseV 快照（併發安全配套，關鍵）**：表單開啟當下即快照 `editing*BaseV`，送出一律以快照為 baseV——否則背景刷新會讓快取版本前進、送出時取即時版本就繞過 409。合約 §3.3 補充 v18 前端紀律
- 背景校正發現該單被他人更新→toast 提示並保留已填內容；被刪除→收回表單

## 設計決策

- 為何不做「背景刷新後自動合併」：合併編輯複雜且易錯，v9 以來的模型是「後確認者重填」，快照＋409 維持同一語意
- 快照與 v13.1 的 otherFormEditing 把關互為對稱：稽核側刷新不動點工表單（v13.1）、點工側刷新不動稽核表單（v18.1 補）

## 影響範圍

- `app.js`（四個 load 函式、四個送出點、bgRefetchVerify）；後端／SQL 零修改；合約 §3.3 補充文字

## 驗證紀錄

- 慢速網路 stub：開表單 61ms、表單就緒、baseV 快照正確
- 併發：模擬他人更新使快取 v 5→8，送出仍以 5 為 baseV → 伺服器 409 → 正確提示重填
- 四入口實測 10–260ms；正常送出成功、快照送出後歸零；console 零錯誤

## v18.1 補強（2026-07-30，XHIGH 審查發現）

- **修復稽核側 409 繞過**：`saveAudit`/`deleteAudit` 送出時讀快取即時 v，而 `bgRefetchVerify` 的整批刷新未檢查稽核表單狀態——管理員開著稽核表單時到點工/機具頁開任一表單，會讓稽核送出的 baseV 漂移繞過 409（v13.1 修過的同型問題之鏡像）。修法：`bgRefetchVerify` 與四個載入 fallback 在 `auditSelectedId` 存在時跳過整批刷新；兩道守衛（otherFormEditing／auditSelectedId）互為對稱、缺一不可（CLAUDE.md 已記載此不變式）
- 同輪清理 11 處過時文件（README localStorage/last-write-wins、app.js 與 api.mjs 檔頭、合約 laborTypes 與版本標頭、sql/README op 數、DEPLOYMENT 備份與附件搬運注意、import-backup 附件警語、MIGRATION-PLAN 機具覆蓋限定語等）
