# 節點 29：目錄重組為前端／後端／文件（v22.1）

## 背景

檔案平鋪在 repo 根目錄（前端三檔、`netlify/`、`server/`、`docs/sql/`、
`DEPLOYMENT.md`），新增檔案時無明確歸屬。使用者要求整理為前端／後端／
README 三大項，作為未來更新與 git 的依據。

## 結構

```
frontend/   前端（唯一對外發布目錄）
backend/    cloud/(Netlify 現行) onprem/(地端參考) sql/(DDL＋移轉)
docs/       規格、計畫、手冊、迭代紀錄
```

原則：前端不引用後端原始碼（只透過 `/api/data`）、後端不含頁面、
文件不含可執行程式。

## 部署設定（此結構下 Netlify 三個預設值全部不適用）

| 設定 | 值 | 注意 |
|---|---|---|
| `[build] publish` | `frontend` | |
| `[build] edge_functions` | `backend/cloud/edge-functions` | **字串，在 `[build]` 底下** |
| `[functions] directory` | `backend/cloud/functions` | 獨立區段 |

> ⚠ 兩者寫法不同不可類推：`[edge_functions]` 作為**區段**在 Netlify 是
> `[[edge_functions]]` 宣告式路由用的陣列。寫成區段會讓 Basic Auth
> **不被部署、整站變公開**——初版即犯此錯，經查官方文件後修正。

同步修正：`scripts/build-config.mjs` 輸出改 `frontend/config.local.js`、
`.claude/launch.json` 的 `--directory`、`.gitignore`。

## 重組引發的缺陷（同批修復）

初版以全域字串取代更新路徑，造成多處破壞，經 code review 逐一查證修復：

| 問題 | 後果 |
|---|---|
| `@netlify/edge-functions` 套件名被誤改為 `@backend/cloud/edge-functions` | 邊緣函式無法解析、Basic Auth 部署失敗 |
| `netlify.toml` 用 `[edge_functions] directory`（非法設定） | 同上；官方為 `[build] edge_functions = "dir"` |
| `server.mjs` 的 `STATIC_DIR` 未重新定位（指向 `backend/`） | 地端全站 404，且後端原始碼與 SQL DDL 可被下載 |
| `DATA_DIR` 預設值靜默改變、檔頭註解仍寫舊路徑 | 地端實例升級後資料看似消失（split-brain） |
| `.gitignore` 未涵蓋 `backend/onprem/data/` | 移轉演練會把正式單據寫進被追蹤的樹內——重演 8/3 外洩形狀 |
| `DEPLOYMENT.md` 仍指示把名單放 repo 根 | 地端靜默使用內建假名單，無任何錯誤訊息 |
| 8 個文件相對連結失效 | IT 交付文件在 GitHub 上 404 |
| 去識別化掃描器讀不到搬移後的 `config.local.js` | 名單詞 112→95，防護靜默減弱 |

## 驗證

- git 全部辨識為 rename（R091～R100），歷史保留
- `netlify.toml` 三個路徑逐一比對實際目錄；兩個 key 的寫法經**查證官方文件**確認
- 本機起 `frontend/` 靜態伺服器：靜態資源皆 200、後端原始碼 404（發布隔離正確）
- `.gitignore` 以 `git check-ignore` 實測資料目錄確實被擋
- 全 repo markdown 連結存在性程式化掃描：0 個無效
- 去識別化掃描器名單詞恢復 112
