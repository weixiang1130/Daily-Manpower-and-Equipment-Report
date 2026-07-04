# Daily Manpower and Equipment Report｜點工機具稽核系統

工地端「點工（人力派工）」與「機具」抽查稽核回報工具。依營造工程稽核會議紀錄與現行 Excel 查核表設計，讓工程師與稽核人員能以勾選、下拉選單為主的方式快速完成申請與回報，減少人工登打 Excel 的負擔，並支援跨工地列控。

> 本專案為通用工具，`app.js` 內建的工地／分包商／人員名單皆為範例佔位資料。實際名單請放在地端 `config.local.js`（已列入 `.gitignore`，格式見 `app.js` 開頭註解）或於系統「設定」頁輸入；資料僅存於使用者瀏覽器的 `localStorage`，不會回寫至本程式碼庫，避免客戶專案資訊外流。

## 功能總覽

- **多工地完全隔離（Multi-Project Isolation）**：每個工地一把獨立的 localStorage 資料庫（基礎名單與紀錄互不共用）；頁首切換工地即切換整個資料環境（Context Switch），總覽頁跨工地彙總並可點擊切換
- **點工申請（父）/ 回報覆核（子）**：回報直接承繼申請單資料，逐人勾選預計進場人員確認到場、填寫各自的實際出工數（支援 0.5／1.5 等小數）與加班時數；全日無人出工可經「0 工確認」寫入 0 工
- **智慧搜尋下拉（Combobox）**：分包商、申請人、工程師、工作地點、點工人員皆可輸入即時模糊搜尋；搜不到時選單底部「＋ 新增選項」直接寫入該工地資料庫
- **防呆警告**：出工數與加班時數配置異常（如 0.5 工配 8 小時加班）時彈出警告提醒，但不阻擋送出
- **機具申請/回報**：同樣的父子流程，回報欄位對齊既有 Excel 查核表（機具出工列控）
- **歷程報表 / CSV 匯出**：欄位對應既有 Excel 查核表（含逐人出工明細），方便直接彙整回報

## 技術棧

前端為原生 HTML / CSS / JavaScript（無框架）；資料存於雲端共用資料庫（Netlify Functions + Netlify Blobs，API 路徑 `/api/data`），所有使用者讀寫同一份資料。整站以 Edge Function Basic Auth 保護。

```
index.html                     主要頁面結構
style.css                      版面與元件樣式
app.js                         應用邏輯（資料模型、渲染、互動）
config.local.js                （選用，地端）真實名單，不入版控；Netlify 由環境變數產生
netlify/functions/api.mjs      共用資料庫 API（Blobs 讀寫）
netlify/edge-functions/auth.ts 整站 Basic Auth
scripts/build-config.mjs       建置時由環境變數產生 config.local.js
docs/                          專案文件與迭代紀錄
```

## 開發／預覽

```bash
# 任一種靜態伺服器皆可，例如：
python -m http.server 8791
# 瀏覽器開啟 http://localhost:8791
```

## 文件

- [`docs/milestones/`](docs/milestones/README.md)：每次改版的背景、變更內容與設計決策，依節點編號排序
- [`CHANGELOG.md`](CHANGELOG.md)：版本異動摘要

## 已知限制

- 資料存於雲端共用資料庫（Netlify Functions + Blobs），所有使用者即時共編；同一筆紀錄若兩人同時編輯為後寫者覆蓋（last-write-wins），且不留「誰修改」的軌跡——需要稽核軌跡時建議升級至含使用者驗證的後端（如 Supabase）
- 本機以純靜態伺服器開啟時無 API，會顯示「無法連線」畫面；本機開發請用 `netlify dev` 或直接以部署網址測試
- 管理員模式為前端層級防誤觸，非資安防線（詳見 [`docs/milestones/08-equip-parent-child-admin-mode.md`](docs/milestones/08-equip-parent-child-admin-mode.md)）
