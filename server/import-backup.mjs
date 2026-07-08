/* ==========================================================
   資料遷移工具：把系統的「完整備份 JSON」灌入地端伺服器的資料目錄

   備份檔來源：網站 → 設定頁 → 管理員登入 → 資料管理 →
   「下載完整備份（JSON）」（格式即 GET /api/data?scope=all 的輸出）

   用法：
     node server/import-backup.mjs <備份檔.json> [資料目錄]

   範例：
     node server/import-backup.mjs 點工機具_完整備份_2026-07-31.json
     （資料目錄預設 <repo>/server/data，與 server.mjs 預設一致）

   行為：
   - master（工地清單）、各工地 config、各筆紀錄逐一寫入
   - 已存在的同名資料會被備份檔內容覆蓋（以備份檔為準）
   - 匯入完成後啟動 server.mjs 即可看到完整資料
   ========================================================== */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [,, backupFile, dataDirArg] = process.argv;
if(!backupFile){
  console.error("用法：node server/import-backup.mjs <備份檔.json> [資料目錄]");
  process.exit(1);
}
const DATA_DIR = dataDirArg || process.env.DATA_DIR || path.join(__dirname, "data");

const b64e = s => Buffer.from(s, "utf8").toString("base64url");
const keyToFile = key => path.join(DATA_DIR, b64e(key) + ".json");
const cfgKey = s => "cfg2:" + b64e(s);
const recKey = (s, kind, id) => `rec2:${b64e(s)}:${kind}:${id}`;
const KINDS = ["labor", "equipment"];

async function kvSet(key, obj){
  const file = keyToFile(key);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fs.rename(tmp, file);
}

const raw = await fs.readFile(backupFile, "utf8");
const data = JSON.parse(raw);
if(!data || !data.master || !data.stores){
  console.error("備份檔格式不符：需含 master 與 stores（請用系統的「下載完整備份（JSON）」產生）");
  process.exit(1);
}

await fs.mkdir(DATA_DIR, { recursive: true });

let cfgCount = 0, recCount = 0, skipped = 0;
await kvSet("master", data.master);

for(const [site, store] of Object.entries(data.stores)){
  if(store && store.config){
    await kvSet(cfgKey(site), store.config);
    cfgCount++;
  }
  for(const kind of KINDS){
    for(const rec of (store && store[kind]) || []){
      if(!rec || !rec.id || !/^[A-Za-z0-9_-]{1,64}$/.test(String(rec.id))){
        skipped++;
        continue;
      }
      await kvSet(recKey(site, kind, rec.id), rec);
      recCount++;
    }
  }
}

console.log("匯入完成：");
console.log(`  工地清單 master：${(data.master.sites || []).length} 個工地`);
console.log(`  工地 config：${cfgCount} 份`);
console.log(`  紀錄：${recCount} 筆${skipped ? `（跳過 ${skipped} 筆 id 格式不符）` : ""}`);
console.log(`  資料目錄：${DATA_DIR}`);
