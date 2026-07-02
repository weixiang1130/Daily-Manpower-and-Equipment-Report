/* Netlify 建置腳本：從環境變數 LOCAL_CONFIG_JS 產生 config.local.js。
   真實工地/分包商/人員名單存放於 Netlify 環境變數（不進 GitHub），
   部署時才寫入檔案；未設定該變數時跳過，站台使用內建範例值。 */
import { writeFileSync } from "node:fs";

const content = process.env.LOCAL_CONFIG_JS;
if (content && content.trim()) {
  writeFileSync("config.local.js", content, "utf8");
  console.log("[build-config] config.local.js generated from LOCAL_CONFIG_JS env var");
} else {
  console.log("[build-config] LOCAL_CONFIG_JS not set; site will use built-in generic defaults");
}
