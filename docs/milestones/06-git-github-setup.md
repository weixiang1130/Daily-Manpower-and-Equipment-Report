# 節點 06：Git / GitHub 版本控管建立

**日期**：2026-07-02
**狀態**：現行流程

## 背景（使用者原始需求）

1. 每次系統改版或迭代都上傳到 GitHub，並每次都做 PR 管控
2. 每個節點寫入一份 md 文檔，讓後續接手的人可以更快讀取
3. 上傳至 `weixiang1130/Daily-Manpower-and-Equipment-Report` 專案

## 資料去識別化（重要）

推送前發現 `app.js` 的 `DEFAULT_CONFIG` 寫死了真實的客戶專案工地代號、分包商名稱與人員姓名。**該 repo 為 public**，直接推送會造成客戶資訊外流。處理方式：

- 程式碼庫中的預設清單改為通用範例值（工地A／分包商A／王小明）
- 含敏感資料的初始提交以 `git commit --amend` 重寫（當時尚未推送過任何遠端，歷史中不存在敏感版本）
- 文件中引用內部文件名稱與工地清單的段落一併改寫
- 推送前以 `git grep` 掃描**提交樹**（非僅工作目錄）確認乾淨

### 地端真實名單機制（config.local.js）

去識別化不應影響地端實際使用。新增 `config.local.js` 機制：

- 地端放置 `config.local.js`（格式：`window.LOCAL_CONFIG = { sites:[...], vendors:[...], people:[...] }`），頁面開啟時自動載入真實名單
- 該檔案列入 `.gitignore`，永遠不會進入版本控制
- 若 localStorage 已存有仍為範例佔位值的清單類別，自動升級為本機名單；使用者已自訂過的類別不受影響
- 檔案不存在時靜默回退至內建範例值

## 版控流程建立

- 於 `點工機具稽核系統/` 資料夾 `git init`，首個提交包含完整程式碼與 docs/milestones 文件
- 遠端：`https://github.com/weixiang1130/Daily-Manpower-and-Equipment-Report.git`
- 因 repo 原為空，第一次推送的分支被 GitHub 自動設為預設分支；經使用者授權後以 GitHub API 建立 `main`（指向初始提交）並設為預設分支
- 第一個 PR（#1）：`feat/initial-release` → `main`，內容為 config.local.js 機制

## 後續每次迭代的標準流程

1. 從最新的 `main` 開新分支：`git checkout main && git pull && git checkout -b feat/<描述>`
2. 開發、測試完成後提交（提交訊息說明背景與變更）
3. 新增 `docs/milestones/0N-<描述>.md`（背景／變更內容／設計決策／影響範圍），並更新 `docs/milestones/README.md` 索引與根目錄 `CHANGELOG.md`
4. 推送分支並開 PR，說明欄比照 PR #1 格式（背景／變更內容／驗證）
5. **推送前必查**：`git diff` 與 `git grep`（對提交樹）確認無真實工地／廠商／人員名稱；`config.local.js` 永不入版控
6. 審核後合併至 `main`

## 環境備註

- 認證：Git Credential Manager（Windows），推送時自動處理
- GitHub CLI（gh）未安裝於系統；本次以可攜版 + GitHub REST API 完成分支與 PR 操作。日後若常用建議安裝：`winget install GitHub.cli`
