# 迭代節點索引 (Milestone Index)

本資料夾記錄「點工‧機具稽核系統」每一次改版的背景、變更內容與原因，供後續接手者快速理解系統演進脈絡，不需重新爬梳對話紀錄。

| 節點 | 標題 | 摘要 |
|---|---|---|
| [01](01-initial-prototype.md) | 初版原型建置 | 依會議紀錄與既有查核表，建立第一版勾選式稽核 APP（8 個頁籤） |
| [02](02-request-report-restructure.md) | 點工申請/回報架構重整 | 精簡頁籤、統一申請與回報為單一紀錄、移除交接簽單與鐵板盤點模組 |
| [03](03-separation-of-duties-dropdowns.md) | 查核獨立性與下拉選單化 | 回報區塊延遲顯示以避免同一人一次填完、欄位全面改為下拉選單 |
| [04](04-excel-alignment-subtabs.md) | Excel 欄位對齊與大頁籤重構 | 申請/回報拆為真正獨立的子模組、回報欄位對齊既有 Excel 查核表 |
| [05](05-multi-site-support.md) | 多工地列控支援 | 工地改為申請時選定、匯入 16 個實際工地、總覽改為跨工地分列顯示 |
| [06](06-git-github-setup.md) | Git / GitHub 版本控管建立 | 建立版本控制、推送至 GitHub、建立 PR 審核流程 |
| [07](07-parent-child-multisite-isolation.md) | 父子單覆核與多工地隔離（v6） | 智慧搜尋下拉、申請/回報父子結構逐人勾選、小數出工、防呆警告、每工地獨立資料庫 |
| [08](08-equip-parent-child-admin-mode.md) | 機具父子覆核與管理員模式（v7） | 機具回報逐台勾選、移除清點計時器、管理員密碼保護清空/批次設定、縮小危險按鈕 |
| [09](09-netlify-deployment.md) | Netlify 部署與私密名單注入 | 環境變數建置時產生 config.local.js、整站密碼保護、GitHub 保持去識別化 |
| [10](10-shared-database.md) | 共用資料庫與填錯工地防呆（v8） | Netlify Blobs 雲端共編（所有人看到同一份資料）、開站選工地攔截頁、工地徽章、送出前工地確認 |
| [11](11-concurrency-pricing-safeguards.md) | 共編保險絲與計價保障（v9） | 時區日期修正、編輯前抓最新、版本衝突409、選項伺服器合併、報表期間篩選、已回報刪除保護、鎖單、備份下載 |
| [12](12-report-refinements-pricing-summary.md) | 回報補人、自辦/代辦結構化與計價彙總（v10） | 回報頁現場補入出工人員（逐人加班補缺口）、根基自辦/廠商代辦拆工數+時數+備註、報表廠商/工作內容篩選、計價彙總表與獨立匯出 |
| [13](13-worktype-report-split-overtime.md) | 回報改逐工種、分段加班與彙總期間欄（v11） | 申請移除人員名單、回報逐工種（粗工/技術工/打石工）覆核、加班拆前2小時/第3小時起、彙總CSV加期間欄、舊單完整相容 |
| [14](14-security-hardening.md) | 安全補強（v11.1） | CSV 公式注入中和（= + - @ 開頭前置 '）、record.id 前端跳脫＋伺服器端格式驗證 |
| [15](15-portable-server-deployment.md) | 可攜式伺服器與地端部署交付 | server/ 零依賴 Node 伺服器（同 API 合約+靜態+Basic Auth）、備份 JSON 匯入工具、DEPLOYMENT.md 部署手冊 |
| [16](16-api-contract-seam.md) | API 合約正式化與後端替換餘裕 | docs/API-CONTRACT.md 接縫合約（op/409/欄位字典/資料表建議）、apiBase 可配置、IT 標準後端重寫的對接準備 |
| [17](17-remove-selfdone-unlimit-conclusion.md) | 移除根基自辦、回饋不限字數（v12） | 兩回報表單移除自辦三欄（舊資料承繼保留、報表欄不動）、查核回饋取消 30 字上限 |
| [18](18-sql-handoff-package.md) | SQL 交付包（資料表＋遷移工具） | backend/sql/ 8表4VIEW＋備份轉SQL工具＋實作指引；LocalDB 以正式資料實測對帳一致、409 模式驗證 |
| [19](19-field-audit-module.md) | 成控現場稽核模組（v13） | 管理員限定稽核頁籤（工地端隱藏）、連動申請單逐項相符/不相符查核＋實點差異、PDF/CSV 匯出；audits[] 內嵌後端零修改；SQL 包同步至 10表5VIEW |
| [20](20-attachments.md) | 附件：簽單掃描檔與稽核照片（v14） | 三掛載點附件（點工/機具申請＋稽核）、圖片前端壓縮、稽核 PDF 嵌照片；api.mjs 首次修改（上傳/下載/刪除＋連動清除）；合約 §4.6、SQL 包 11表5VIEW |
| [21](21-report-filters-collapsible.md) | 現場回饋三項（v15） | 回報限一位簽單責任工程師＋報表按工程師篩選統計、點工/機具清單日期廠商篩選、四表單收合式面板 |
| [22](22-kedge-brand-restyle.md) | 根基營造品牌風格改版（v16） | 暖中性＋深板岩藍品牌配色、Noto Sans TC/Space Grotesk/DM Sans/DM Mono、▎區塊標記、無漸層尖角暖陰影；純樣式改版，結構與邏輯零修改 |
| [23](23-per-site-option-pools.md) | 各工地名單自行建置（v17／v17.1） | 新建工地全部名單池皆空、移除工種自動補預設相容邏輯；正式資料清空配套（保留主力工地與既有單據引用名稱） |
| [24](24-optimistic-form-open.md) | 開表單樂觀渲染與 baseV 快照（v18／v18.1） | 快取即時開表單＋背景校正（1.5s 網路下 61ms）；baseV 開表單快照防背景刷新繞過 409；v18.1 補稽核側對稱守衛 |
| [25](25-engineer-ranking-report.md) | 工程師叫工排名報表（v19） | 依工種列排名各工程師叫工工數（出工＋加班8h折1工）；帶格式 .xls 匯出（期別合併/雙欄群組/底色）；零外部套件 |
| [26](26-entry-flow-site-lock.md) | 開站動線優化（v20）＋權限規畫 | 選站即進點工頁、單站自動進入（AD 鋪路）；過渡期維持自由跳轉不做一站一連結；AUTH-PLAN.md AD 權限規畫 |
| [27](27-export-split-by-worktype.md) | 匯出依工種展開分欄（v21） | 明細與計價彙總 CSV 每工種三欄（出工數/前2h/2h後），欄序依總量降冪；口徑同彙總 |
| [28](28-idle-timeout-logout.md) | 閒置逾時與登出（v22） | 10 分鐘閒置自動登出＋登出按鈕；清工作狀態與管理員模式，SSO 階段沿用 |
| [29](29-repo-restructure.md) | 目錄重組為前端／後端／文件（v22.1） | 三大項結構＋部署設定同步；code review 修復重組引發的 8 項缺陷與 2 項計價正確性問題 |

## 如何新增下一個節點

每次改版完成後，請新增一份 `0N-描述.md`，內容至少包含：
1. **背景**：這次改版要解決什麼問題（可引用使用者原始需求）
2. **變更內容**：條列實際改了什麼
3. **設計決策 / 取捨**：為什麼這樣做，有沒有考慮過其他做法
4. **影響範圍**：牽動哪些檔案、資料結構是否變動

並在本頁表格新增一列連結，同時更新根目錄 `CHANGELOG.md`。
