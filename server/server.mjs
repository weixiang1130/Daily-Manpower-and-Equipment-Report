/* ==========================================================
   點工機具稽核系統 — 可攜式伺服器（地端部署用）

   用途：在不依賴 Netlify 的環境（公司自有伺服器）提供與
   Netlify 版完全相同的服務：
     1. 靜態檔案（index.html / app.js / style.css / config.local.js）
     2. 資料 API（/api/data，與 netlify/functions/api.mjs 同一合約）
     3. 整站 Basic Auth（與 netlify/edge-functions/auth.ts 同一邏輯）

   前端 app.js 完全不需修改。

   需求：Node.js 18 以上。零外部依賴（不需 npm install）。

   啟動：
     node server/server.mjs

   環境變數：
     PORT            監聽埠（預設 8080）
     DATA_DIR        資料儲存目錄（預設 <repo>/server/data）
     STATIC_DIR      靜態檔案目錄（預設 repo 根目錄）
     SITE_AUTH_USER  Basic Auth 帳號（預設 kg）
     SITE_AUTH_PASS  Basic Auth 密碼（未設定＝不啟用驗證，
                     正式環境務必設定）

   儲存方式：一筆資料一個 JSON 檔，檔名為 key 的 base64url
   （與 Netlify Blobs「一筆一 blob」同構；key 含「:」不能直接
   當 Windows/Linux 檔名，故整個 key 再編碼一次）。寫入採
   tmp+rename 原子寫，避免斷電產生半個檔案。

   注意：本檔案由開發端撰寫時無 Node 環境可執行測試（僅通過
   語法驗證與 API 合約逐行比對）。部署前請先在測試機驗證：
   啟動 → 開站登入 → 建一筆申請 → 回報 → 匯出 CSV。
   ========================================================== */
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, "..");

/* ---------------- key ↔ 檔名 ---------------- */
const b64e = s => Buffer.from(s, "utf8").toString("base64url");
const b64d = s => Buffer.from(s, "base64url").toString("utf8");
const keyToFile = key => path.join(DATA_DIR, b64e(key) + ".json");

const cfgKey = s => "cfg2:" + b64e(s);
const recKey = (s, kind, id) => `rec2:${b64e(s)}:${kind}:${id}`;
const KINDS = ["labor", "equipment"];

/* ---------------- 檔案儲存層（對應 Netlify Blobs） ---------------- */
async function ensureDataDir(){
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function kvGet(key){
  try{
    const raw = await fs.readFile(keyToFile(key), "utf8");
    return JSON.parse(raw);
  }catch(e){
    if(e.code === "ENOENT") return null;
    throw e;
  }
}

async function kvSet(key, obj){
  const file = keyToFile(key);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
  await fs.rename(tmp, file);
}

async function kvDelete(key){
  try{ await fs.unlink(keyToFile(key)); }
  catch(e){ if(e.code !== "ENOENT") throw e; }
}

async function kvListKeys(prefix){
  const names = await fs.readdir(DATA_DIR).catch(()=>[]);
  const keys = [];
  for(const name of names){
    if(!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    let key;
    try{ key = b64d(name.slice(0, -5)); }catch(e){ continue; }
    if(key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/* ---------------- Basic Auth（與 Netlify 版同邏輯） ---------------- */
function authorized(req){
  const user = process.env.SITE_AUTH_USER || "kg";
  const pass = process.env.SITE_AUTH_PASS || "";
  if(!pass) return true;   // 未設定密碼＝不啟用（正式環境務必設定）
  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return (req.headers["authorization"] || "") === expected;
}

/* ---------------- 資料 API（與 netlify/functions/api.mjs 同合約） ---------------- */
async function readSite(site){
  const config = await kvGet(cfgKey(site));
  const keys = await kvListKeys("rec2:" + b64e(site) + ":");
  const out = { config, labor: [], equipment: [] };
  for(const key of keys){
    const kind = key.split(":")[2];
    const rec = await kvGet(key);
    if(rec && KINDS.includes(kind)) out[kind].push(rec);
  }
  return out;
}

async function handleApi(req, res, body, query){
  if(req.method === "GET"){
    const site = query.get("site");
    if(site) return sendJson(res, await readSite(site));

    const master = await kvGet("master");
    const sites = (master && master.sites) || [];
    const stores = {};
    for(const site of sites){
      stores[site] = { config: await kvGet(cfgKey(site)), labor: [], equipment: [] };
    }
    const keys = await kvListKeys("rec2:");
    for(const key of keys){
      const parts = key.split(":");
      let site;
      try{ site = b64d(parts[1]); }catch(e){ continue; }
      const kind = parts[2];
      if(!stores[site]) stores[site] = { config: null, labor: [], equipment: [] };
      const rec = await kvGet(key);
      if(rec && KINDS.includes(kind)) stores[site][kind].push(rec);
    }
    return sendJson(res, { master, stores });
  }

  if(req.method === "POST"){
    let data;
    try{ data = JSON.parse(body); }catch(e){ return sendJson(res, { error: "invalid json" }, 400); }

    switch(data.op){
      case "master":
        if(!Array.isArray(data.sites) || !data.sites.length) return sendJson(res, { error: "sites required" }, 400);
        await kvSet("master", { sites: data.sites });
        return sendJson(res, { ok: true });

      case "config":
        if(!data.site || !data.config) return sendJson(res, { error: "site/config required" }, 400);
        await kvSet(cfgKey(data.site), data.config);
        return sendJson(res, { ok: true });

      case "record": {
        if(!data.site || !KINDS.includes(data.kind) || !data.record || !data.record.id)
          return sendJson(res, { error: "site/kind/record required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.record.id)))
          return sendJson(res, { error: "invalid record id" }, 400);
        /* 樂觀並發控制：與 Netlify 版一致，版本不符回 409 */
        const key = recKey(data.site, data.kind, data.record.id);
        const existing = await kvGet(key);
        const baseV = Number(data.baseV) || 0;
        if(existing && (Number(existing.v) || 0) !== baseV)
          return sendJson(res, { error: "conflict", reason: "modified" }, 409);
        if(!existing && baseV > 0)
          return sendJson(res, { error: "conflict", reason: "deleted" }, 409);
        const rec = Object.assign({}, data.record, {
          v: baseV + 1,
          updatedAt: new Date().toISOString()
        });
        await kvSet(key, rec);
        return sendJson(res, { ok: true, v: rec.v, updatedAt: rec.updatedAt });
      }

      case "addOption": {
        const POOLS = ["vendors","locations","categories","equipTypes","people","workers","laborTypes"];
        if(!data.site || !POOLS.includes(data.pool) || !data.value || typeof data.value !== "string")
          return sendJson(res, { error: "site/pool/value required" }, 400);
        const ck = cfgKey(data.site);
        const cfg = (await kvGet(ck)) || {};
        if(!Array.isArray(cfg[data.pool])) cfg[data.pool] = [];
        const val = data.value.trim();
        if(val && !cfg[data.pool].includes(val)){
          cfg[data.pool].push(val);
          await kvSet(ck, cfg);
        }
        return sendJson(res, { ok: true, pool: cfg[data.pool] });
      }

      case "deleteRecord":
        if(!data.site || !KINDS.includes(data.kind) || !data.id) return sendJson(res, { error: "site/kind/id required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.id)))
          return sendJson(res, { error: "invalid record id" }, 400);
        await kvDelete(recKey(data.site, data.kind, data.id));
        return sendJson(res, { ok: true });

      case "clearSite": {
        if(!data.site) return sendJson(res, { error: "site required" }, 400);
        const keys = await kvListKeys("rec2:" + b64e(data.site) + ":");
        for(const key of keys) await kvDelete(key);
        return sendJson(res, { ok: true, deleted: keys.length });
      }

      case "clearAll": {
        const keys = await kvListKeys("");
        for(const key of keys) await kvDelete(key);
        return sendJson(res, { ok: true, deleted: keys.length });
      }

      default:
        return sendJson(res, { error: "unknown op" }, 400);
    }
  }

  return sendJson(res, { error: "method not allowed" }, 405);
}

/* ---------------- 靜態檔案 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
  ".csv":  "text/csv; charset=utf-8",
  ".md":   "text/plain; charset=utf-8"
};

async function serveStatic(req, res, pathname){
  if(pathname === "/") pathname = "/index.html";
  /* 防路徑穿越：正規化後必須仍在 STATIC_DIR 底下 */
  const filePath = path.normalize(path.join(STATIC_DIR, decodeURIComponent(pathname)));
  if(!filePath.startsWith(path.normalize(STATIC_DIR + path.sep))){
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try{
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  }catch(e){
    if(e.code === "ENOENT" || e.code === "EISDIR"){ res.writeHead(404); res.end("Not Found"); }
    else { res.writeHead(500); res.end("Internal Server Error"); }
  }
}

/* ---------------- HTTP 進入點 ---------------- */
function sendJson(res, obj, status = 200){
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try{
    if(!authorized(req)){
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="KG Manpower", charset="UTF-8"',
        "content-type": "text/plain; charset=utf-8"
      });
      res.end("需要登入 / Authentication required");
      return;
    }

    const u = new URL(req.url, "http://localhost");
    if(u.pathname === "/api/data"){
      let body = "";
      for await (const chunk of req) body += chunk;
      await handleApi(req, res, body, u.searchParams);
      return;
    }

    if(req.method !== "GET" && req.method !== "HEAD"){
      res.writeHead(405); res.end("Method Not Allowed"); return;
    }
    await serveStatic(req, res, u.pathname);
  }catch(e){
    console.error("[server] unhandled error:", e);
    if(!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

await ensureDataDir();
server.listen(PORT, () => {
  console.log(`[點工機具稽核系統] listening on http://localhost:${PORT}`);
  console.log(`  DATA_DIR   = ${DATA_DIR}`);
  console.log(`  STATIC_DIR = ${STATIC_DIR}`);
  console.log(`  Basic Auth = ${process.env.SITE_AUTH_PASS ? "啟用" : "未啟用（SITE_AUTH_PASS 未設定，正式環境請務必設定）"}`);
});
