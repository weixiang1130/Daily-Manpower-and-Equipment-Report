# 節點 22 — 根基營造品牌風格改版（v16）

## 背景

使用者提供集團品牌設計規範（kedge-construction-design skill：色票、CJK 字體、版式、元件規則），要求將既有系統改為符合品牌識別的視覺風格。原系統為自訂 teal/amber 配色，與集團簡報／ESG 報告的視覺語言不一致。

## 品牌規範重點（取自 skill）

- 色彩：暖中性（beige/grey）＋深板岩藍重點色，**無漸層**
- 字體：Space Grotesk（標題）、DM Sans（內文）、DM Mono（數據）、Noto Sans TC（全部 CJK）
- 圓角：尖角 0–4px；陰影暖調；**無 glassmorphism**
- 動態：溫和淡入 200ms ease，無彈跳
- 標記：▎區塊標記，優先幾何標記而非圖示

## 變更內容

- **設計 token 全面替換**：`:root` 導入品牌完整 token（slate 10 階、暖中性底 5 階、文字 5 階、框線 5 階、語意色、陰影、動態曲線）
- **相容映射策略**：既有元件變數（`--teal-*`／`--amber-*`／`--ink-*`／`--line`／`--bg`）保留並映射至品牌 token——541 行樣式中約九成引用自動換色，元件選擇器無需改寫，將迴歸風險降到最低
- **寫死顏色精準替換**：30 餘處 teal 系淺色調逐一對應至品牌暖中性／語意色
- **規範落實**：移除唯一漸層（頁首改純色板岩藍）、`border-radius` ≥6px 一律降為 4px（藥丸與圓形標記保留）、陰影改暖調 rgba(28,28,28,*)、轉場統一 `var(--duration-normal)` + `var(--ease-default)`
- **品牌識別強化**：面板標題 ▎標記、標題字體 Space Grotesk、KPI/頁碼/表格數值 DM Mono＋`tabular-nums` 對齊、標籤字距 `tracking-wide`、表頭改暖中性底＋板岩藍字
- **字體載入**：index.html 掛 Google Fonts（`display=swap`）；字體堆疊皆含 Microsoft JhengHei fallback，**離線或內網封鎖時中文仍正常顯示**（地端部署考量）
- **PDF 報告同步**：`auditReportHTML` 內嵌樣式（獨立列印視窗，不吃 style.css）一併品牌化

## 影響範圍

- `style.css`（token 與樣式）、`index.html`（字體連結）、`app.js`（PDF 內嵌樣式 10 處）
- HTML 結構、JS 業務邏輯、後端／API 合約／SQL 交付包：**零修改**

## 驗證紀錄

- 品牌屬性 computed style 逐項驗證：底色 #FAFAF7、重點色 #2E3F5A、相容映射生效、圓角 4px、頁首純色且全站漸層元素數＝0、標題 Space Grotesk＋▎標記、表頭暖中性底＋板岩藍字、語意色（成功 #3A6B52／警告 #8B6D2E）
- 功能回歸：申請送出、回報送出、分頁、收合面板、篩選、稽核 PDF 產出全數正常；console 零錯誤
- PDF 報告：板岩藍區塊線、暖中性表頭、Noto Sans TC、無舊配色殘留
