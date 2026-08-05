/* Netlify 建置腳本：從環境變數 LOCAL_CONFIG_JS 產生 frontend/config.local.js。
   真實工地/分包商/人員名單存放於 Netlify 環境變數（不進 GitHub），
   部署時才寫入檔案；未設定該變數時跳過，站台使用內建範例值。

   ⚠ 輸出必須落在 frontend/（＝netlify.toml 的 publish 目錄），
     index.html 以相對路徑 <script src="config.local.js"> 載入它。 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = "frontend/config.local.js";
const content = process.env.LOCAL_CONFIG_JS;

if (content && content.trim()) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, content, "utf8");
  console.log(`[build-config] ${OUT} generated from LOCAL_CONFIG_JS env var`);
} else {
  console.log("[build-config] LOCAL_CONFIG_JS not set; site will use built-in generic defaults");
}
