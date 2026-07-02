# 節點 09：Netlify 部署與私密名單注入機制

**日期**：2026-07-02
**狀態**：現行部署流程

## 背景（使用者原始需求）

1. 合併發布最新 PR
2. GitHub 上是去識別化的，但 Netlify 又要串 GitHub 自動部署——需要讓真實的工地/人員/分包商名單「不公開在 GitHub，但部署後的網站上用得到」
3. Netlify 專案：`kgmanpower`（https://app.netlify.com/projects/kgmanpower）

## 架構：環境變數注入 + 整站密碼保護

```
GitHub repo（乾淨，只有通用範例值）
        │  git push / merge → 觸發 Netlify 自動建置
        ▼
Netlify 建置：node scripts/build-config.mjs
        │  讀取環境變數 LOCAL_CONFIG_JS（真實名單，只存在 Netlify）
        │  寫出 config.local.js 到發佈目錄
        ▼
kgmanpower.netlify.app（整站密碼保護，外部無法瀏覽）
```

- **repo 永遠乾淨**：真實名單只存在兩個地方——使用者地端的 `config.local.js`（.gitignore 排除）與 Netlify 的環境變數（僅帳號登入者可見）
- **自動部署不斷鏈**：因為名單來自環境變數而非檔案，之後每次 merge PR 觸發的自動建置都會重新產生 config.local.js，不需要任何手動步驟
- **整站密碼**：Netlify 的 Visitor Access / Password Protection 讓所有路徑（含 config.local.js 本身）都需要輸入密碼才能存取，解決「靜態網站上的資料本質上是公開的」問題
- 未設定 `LOCAL_CONFIG_JS` 時建置腳本跳過，站台以內建範例值運作（例如其他人 fork 這個 repo 部署，不會壞）

## 操作紀錄

- PR #3（堆疊含 #1、#2）依使用者指示合併至 main
- 新增 `netlify.toml`（build command + publish 目錄）與 `scripts/build-config.mjs`
- 環境變數 `LOCAL_CONFIG_JS` 內容 = 地端 config.local.js 全文（含 adminPin）
- 網站密碼保護由 Netlify 專案設定啟用（Site configuration → Access & security）

## 維運須知

- **更新真實名單**：改 Netlify 環境變數 `LOCAL_CONFIG_JS` → 觸發重新部署（或等下次 merge）；地端同步改自己的 config.local.js
- **改網站密碼**：Netlify 專案 → Access & security → Password protection
- **改管理員密碼（adminPin）**：包含在 LOCAL_CONFIG_JS 內容中，同上更新
- 環境變數有長度上限（約數 KB），目前名單約 1.5KB，充裕
