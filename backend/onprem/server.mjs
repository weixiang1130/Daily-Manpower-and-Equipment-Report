/* ==========================================================
   點工機具稽核系統 — 可攜式伺服器（地端部署用）

   用途：在不依賴 Netlify 的環境（公司自有伺服器）提供與
   Netlify 版完全相同的服務：
     1. 靜態檔案（index.html / app.js / style.css / config.local.js）
     2. 資料 API（/api/data，與 backend/cloud/functions/api.mjs 同一合約）
     3. 整站 Basic Auth（與 backend/cloud/edge-functions/auth.ts 同一邏輯）

   前端 app.js 完全不需修改。

   需求：Node.js 18 以上。零外部依賴（不需 npm install）。

   啟動：
     node backend/onprem/server.mjs

   環境變數：
     PORT            監聽埠（預設 8080）
     DATA_DIR        資料儲存目錄（預設 <repo>/backend/onprem/data）
     STATIC_DIR      靜態檔案目錄（預設 <repo>/frontend）
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
/* 靜態根＝frontend/（三大項結構）。**不可指向 repo 根或 backend/**——
   那會把後端原始碼與 SQL DDL 一併對外提供下載。 */
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, "../../frontend");

/* ---------------- key ↔ 檔名 ---------------- */
const b64e = s => Buffer.from(s, "utf8").toString("base64url");
const b64d = s => Buffer.from(s, "base64url").toString("utf8");
const keyToFile = key => path.join(DATA_DIR, b64e(key) + ".json");

const cfgKey = s => "cfg2:" + b64e(s);
const recKey = (s, kind, id) => `rec2:${b64e(s)}:${kind}:${id}`;
const KINDS = ["labor", "equipment"];

/* 行情通報費率書（v22.8，合約 §4.8）：不進 scope=all。
   以 effectiveFrom 為季別唯一鍵，保留上限 12 季（三年）。
   ⚠ **一個 kind 一把 key**：兩種放同一把時，同時匯入租工與機具會是兩個
   「讀整包→改→寫整包」互相覆蓋，後寫的把先寫的那一半無聲蓋掉。
   ⚠ 與 cloud/functions/api.mjs 為同一份合約的兩個實作，改規則要兩邊一起改。 */
const ratesKey = kind => "rates:" + kind;
const RATE_BOOK_MAX = 12;
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const bookBrief = books => books.map(b => ({ label: b.label, effectiveFrom: b.effectiveFrom,
  importedAt: b.importedAt, rowCount: b.rows.length }));

/* ---------------- 檔案儲存層（對應 Netlify Blobs） ---------------- */
async function ensureDataDir(){
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(ATT_DIR, { recursive: true });
}

/* ---------------- 附件（v14，合約 §2.3/§3.6/§3.7） ----------------
   檔案本體存 DATA_DIR/attachments/<b64e(site)>_<id>（id 為安全字元集），
   name/type 描述資料存 kv（attmeta:<b64e(site)>:<id>），與 Netlify 版
   Blobs metadata 同構。 */
const ATT_DIR = path.join(DATA_DIR, "attachments");
const ATT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const ATT_MAX_BYTES = 4 * 1024 * 1024;
const attFile = (site, id) => path.join(ATT_DIR, `${b64e(site)}_${id}`);
const attMetaKey = (site, id) => `attmeta:${b64e(site)}:${id}`;

function attIdsOf(rec){
  const ids = [];
  ((rec && rec.attachments) || []).forEach(a => a && a.id && ids.push(a.id));
  ((rec && rec.audits) || []).forEach(au => ((au && au.attachments) || []).forEach(a => a && a.id && ids.push(a.id)));
  return ids.filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(String(id)));
}
async function deleteAttachmentFiles(site, ids){
  for(const id of ids){
    await fs.unlink(attFile(site, id)).catch(() => {});
    await kvDelete(attMetaKey(site, id));
  }
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

/* ---------------- 資料 API（與 backend/cloud/functions/api.mjs 同合約） ---------------- */
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
    /* 附件下載（v14）：二進位回應＋原始 Content-Type */
    const attId = query.get("attachment");
    const attSite = query.get("site");
    if(attId && attSite){
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(attId)) return sendJson(res, { error: "invalid attachment id" }, 400);
      try{
        const [buf, meta] = await Promise.all([
          fs.readFile(attFile(attSite, attId)),
          kvGet(attMetaKey(attSite, attId))
        ]);
        res.writeHead(200, {
          "content-type": (meta && ATT_TYPES.includes(meta.type)) ? meta.type : "application/octet-stream",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent((meta && meta.name) || attId)}`,
          "cache-control": "private, max-age=86400"
        });
        return res.end(buf);
      }catch(e){
        if(e.code === "ENOENT") return sendJson(res, { error: "not found" }, 404);
        throw e;
      }
    }

    /* 行情通報費率書（v22.8，合約 §2.4）：獨立端點，不進 scope=all */
    if(query.get("rates")){
      const labor = await kvGet(ratesKey("labor"));
      const equipment = await kvGet(ratesKey("equipment"));
      return sendJson(res, { labor: Array.isArray(labor) ? labor : [],
                             equipment: Array.isArray(equipment) ? equipment : [] });
    }

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
        const val = data.value.trim();
        /* v15.1：人員池僅接受單一人名（與 Netlify 版同規則） */
        if(data.pool === "people" && /[+＋/／\\、,，;；:：\s]/.test(val))
          return sendJson(res, { error: "person name must be a single name" }, 400);
        const ck = cfgKey(data.site);
        const cfg = (await kvGet(ck)) || {};
        if(!Array.isArray(cfg[data.pool])) cfg[data.pool] = [];
        if(val && !cfg[data.pool].includes(val)){
          cfg[data.pool].push(val);
          await kvSet(ck, cfg);
        }
        return sendJson(res, { ok: true, pool: cfg[data.pool] });
      }

      case "uploadAttachment": {
        if(!data.site || !data.id || !data.data) return sendJson(res, { error: "site/id/data required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.id))) return sendJson(res, { error: "invalid attachment id" }, 400);
        if(!ATT_TYPES.includes(data.type)) return sendJson(res, { error: "type not allowed" }, 400);
        let buf;
        try{ buf = Buffer.from(String(data.data), "base64"); }catch(e){ return sendJson(res, { error: "invalid data" }, 400); }
        if(!buf.length || buf.length > ATT_MAX_BYTES) return sendJson(res, { error: "size limit exceeded" }, 400);
        await fs.writeFile(attFile(data.site, data.id), buf);
        await kvSet(attMetaKey(data.site, data.id), { name: String(data.name || data.id).slice(0, 200), type: data.type });
        return sendJson(res, { ok: true, id: data.id, size: buf.length });
      }

      case "deleteAttachment":
        if(!data.site || !data.id) return sendJson(res, { error: "site/id required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.id))) return sendJson(res, { error: "invalid attachment id" }, 400);
        await deleteAttachmentFiles(data.site, [data.id]);
        return sendJson(res, { ok: true });

      case "deleteRecord": {
        if(!data.site || !KINDS.includes(data.kind) || !data.id) return sendJson(res, { error: "site/kind/id required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.id)))
          return sendJson(res, { error: "invalid record id" }, 400);
        const rKey = recKey(data.site, data.kind, data.id);
        const rec = await kvGet(rKey);   // 先讀出，連同引用附件一併刪除（合約 §3.8）
        await kvDelete(rKey);
        if(rec) await deleteAttachmentFiles(data.site, attIdsOf(rec));
        return sendJson(res, { ok: true });
      }

      /* 行情通報：整季覆蓋（合約 §3.9）。與雲端版邏輯一致 */
      case "rateBook": {
        if(!KINDS.includes(data.kind)) return sendJson(res, { error: "invalid kind" }, 400);
        if(!isDate(data.effectiveFrom)) return sendJson(res, { error: "effectiveFrom must be YYYY-MM-DD" }, 400);
        if(!Array.isArray(data.rows) || !data.rows.length) return sendJson(res, { error: "rows required" }, 400);
        const key = ratesKey(data.kind);
        let books = await kvGet(key);
        if(!Array.isArray(books)) books = [];
        const book = {
          label: String(data.label || data.effectiveFrom).slice(0, 40),
          effectiveFrom: data.effectiveFrom,
          importedAt: new Date().toISOString().slice(0, 10),
          rows: data.rows
        };
        books = books.filter(b => b.effectiveFrom !== book.effectiveFrom);
        books.push(book);
        books.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
        const dropped = Math.max(0, books.length - RATE_BOOK_MAX);
        if(dropped) books = books.slice(0, RATE_BOOK_MAX);
        await kvSet(key, books);
        return sendJson(res, { ok: true, kind: data.kind, dropped, books: bookBrief(books) });
      }

      case "deleteRateBook": {
        if(!KINDS.includes(data.kind)) return sendJson(res, { error: "invalid kind" }, 400);
        if(!isDate(data.effectiveFrom)) return sendJson(res, { error: "effectiveFrom must be YYYY-MM-DD" }, 400);
        const key = ratesKey(data.kind);
        let books = await kvGet(key);
        if(!Array.isArray(books)) books = [];
        books = books.filter(b => b.effectiveFrom !== data.effectiveFrom);
        await kvSet(key, books);
        return sendJson(res, { ok: true, books: bookBrief(books) });
      }

      case "clearSite": {
        if(!data.site) return sendJson(res, { error: "site required" }, 400);
        const keys = await kvListKeys("rec2:" + b64e(data.site) + ":");
        for(const key of keys) await kvDelete(key);
        /* 該站附件（實體檔＋描述資料）一併清除 */
        const metaKeys = await kvListKeys("attmeta:" + b64e(data.site) + ":");
        await deleteAttachmentFiles(data.site, metaKeys.map(k => k.split(":")[2]).filter(Boolean));
        return sendJson(res, { ok: true, deleted: keys.length + metaKeys.length });
      }

      case "clearAll": {
        const keys = await kvListKeys("");
        for(const key of keys) await kvDelete(key);
        /* 附件實體檔一併清空 */
        const files = await fs.readdir(ATT_DIR).catch(() => []);
        for(const f of files) await fs.unlink(path.join(ATT_DIR, f)).catch(() => {});
        return sendJson(res, { ok: true, deleted: keys.length + files.length });
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
