# 節點 20 — 附件功能：簽單掃描檔與稽核現場照片（v14）

## 背景

成本管理部提出兩個現場需求：(1) 成控稽核要能上傳附件或圖片（現場照片佐證）；(2) 點工申請單可夾手寫簽單掃描檔。經確認一併涵蓋機具申請單，稽核照片並自動嵌入 PDF 抽查報告。

## 變更內容

- **後端（api.mjs 首次修改）**：新命名空間 `att2:<b64url(site)>:<attId>` 存檔案本體（Blobs 二進位＋name/type metadata）；新增 `op:uploadAttachment`（型別白名單、4MB 上限、base64 傳輸）、`op:deleteAttachment`（冪等）、`GET ?site=&attachment=`（二進位回應＋原始 Content-Type＋快取標頭）；`deleteRecord`/`clearSite` 連動清除引用附件（防孤兒檔案）
- **前端（app.js 共用附件模組）**：三個掛載點——點工申請、機具申請（簽單掃描檔）、稽核表單（現場照片）。手機直接拍照/選檔、縮圖預覽、每處上限 5 件、僅圖片＋PDF；**圖片前端壓縮**（canvas 長邊 1600px、JPEG 0.8，手機 3-5MB 照片→數百 KB）
- **交易語意**：「送出時才上傳、成功後才刪除」——表單取消不留孤兒檔、不誤刪仍被引用的檔案；逐件上傳成功即移入 existing，部分失敗重試不重複上傳
- **架構鐵則**：單據 JSON 只存描述資料 `attachments[]`（id/name/type/size/uploadedAt），檔案本體獨立存放——開站全量載入與 JSON 備份體積不受影響
- **回報頁**：申請單附件以唯讀縮圖列顯示（工程師回報時對照簽單）
- **稽核 PDF 報告**：現場照片自動嵌入逐筆明細（PDF 附件列檔名）
- **順手修復**：申請表單編輯送出時整筆重組單據未帶 `audits[]`——編輯已被稽核的申請單會洗掉稽核紀錄（兩輪審查皆未發現的既有 bug，點工/機具皆修）
- **合約同步**：§2.3／§3.6／§3.7／§4.6 新增；§3.8 註記連動刪除；明文警示「JSON 備份不含檔案本體」
- **SQL 交付包**：第 11 表 `attachments`（描述資料；地端檔案本體存檔案系統、file_path 記錄路徑）；遷移工具 emit 附件描述資料（id/檔名驗證＋跳過計數）；README 對照表與附件搬運節；DEPLOYMENT 切換流程加附件搬運步驟與驗證項
- **地端伺服器（server/server.mjs）對等實作**：檔案存 `DATA_DIR/attachments/`、metadata 存 kv，同一合約行為（仍註記未實機測試）

## 設計決策 / 取捨

1. **檔案與描述資料分離**：附件塞進單據 JSON 會讓開站全量載入與備份爆量（6MB function 上限）——獨立 blob＋metadata 是唯一可規模化的做法；代價是 JSON 備份不再等於完整備份，已在合約/部署文件明文警示並提供切換日搬運程序
2. **base64 JSON 傳輸而非 multipart**：與既有單一 JSON API 形態一致、實作最簡；4MB 原檔上限（base64 後 5.3MB）落在 Functions 6MB body 限制內
3. **前端壓縮**：在容量、上傳速度與畫質間取衡——1600px/0.8 對簽單與現場照片辨識綽綽有餘
4. **附件內容不可變**：同 id 不覆蓋，允許長快取（private, max-age=86400）

## 影響範圍

- `netlify/functions/api.mjs`（上線以來首次修改）＋`server/server.mjs`
- `app.js`（附件模組＋三掛載點整合＋PDF）＋`index.html`＋`style.css`
- `docs/API-CONTRACT.md`／`docs/sql/`（11 表）／`DEPLOYMENT.md`

## 驗證紀錄

- DEMO 完整流程：2000×1500 測試圖選取→壓縮（80KB→22KB、轉 JPEG）→縮圖渲染→txt 擋下→申請送出（單據帶 attachments、audits 欄位保留、pending 清空）→回報頁唯讀縮圖→稽核加照片儲存（audits[].attachments 入庫）→PDF 含 photos 區塊與 img 標籤；console 零錯誤
- SQL 層（LocalDB 重建）：11 表＋5 VIEW 一次跑通；fixture 匯入——附件描述資料 2 筆入表（labor＋labor_audit）、壞 id/空檔名 2 筆跳過計數
- 雲端後端（api.mjs）為 Functions 環境，本機無法實跑——上線後以正式站冒煙測試補驗（上傳→下載→刪除循環）
