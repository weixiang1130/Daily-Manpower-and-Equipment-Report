# 維運紀錄（Ops Log）

記錄不涉及程式碼、但影響線上資料/設定的維運操作。真實姓名／廠商等敏感資訊一律不寫入本檔（去識別化政策）。

| 日期 | 操作 | 範圍與方式 |
|---|---|---|
| 2026-07-06 | 移除 3 位工程師人員名單項目 | 依使用者要求，將 3 個不再需要的「工程師人員（people）」名單項目自以下三處同步移除：① 地端 `config.local.js` ② Netlify 環境變數 `LOCAL_CONFIG_JS`（4 個 context 全數）③ 共用資料庫 16 個工地各自的 `people`（read-modify-write，保留各工地其他既有項目與 vendors/lockDate）。本次 commit 之部署會一併重建線上 `config.local.js`，使「新建工地／還原預設」的種子名單同步為最新。點工人員池（workers）未受影響。 |
