/* 共用資料庫 API（Netlify Functions + Netlify Blobs）
   所有使用者讀寫同一份雲端資料，取代各自瀏覽器的 localStorage。

   儲存結構（Blobs store: audit-data）
   - master                     全域工地清單 { sites: [...] }
   - cfg:<encodeURI(工地)>       該工地基礎資料（分包商/人員/地點…）
   - rec:<encodeURI(工地)>:<labor|equipment>:<id>   單筆紀錄

   逐筆紀錄各自一把 key：不同紀錄的同時寫入互不影響；同一筆
   紀錄同時被兩人編輯時為後寫者覆蓋（last-write-wins）。

   驗證：與整站 Edge Function 相同的 Basic Auth（SITE_AUTH_USER /
   SITE_AUTH_PASS 環境變數），函式內再驗一次作為第二道防線。 */
import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "audit-data", consistency: "strong" });

/* 工地名以 base64url 編碼進 key：Blobs 的 list(prefix) 會在伺服器端
   解碼 % 序列，encodeURIComponent 產生的前綴因此比對不到；base64url
   字元集（A-Za-z0-9_-）不含 % 與 :，前綴比對與 split(":") 都安全。 */
const b64e = s => Buffer.from(s, "utf8").toString("base64url");
const b64d = s => Buffer.from(s, "base64url").toString("utf8");
const decodeSeg = seg => seg.includes("%") ? decodeURIComponent(seg) : b64d(seg);

const cfgKey = s => "cfg:" + b64e(s);
const recKey = (s, kind, id) => `rec:${b64e(s)}:${kind}:${id}`;
const KINDS = ["labor", "equipment"];

/* 一次性遷移：把早期以 encodeURIComponent 建立的 %-key 改寫為
   base64url key（含 cfg 與 rec）。全部遷移完成後即為 no-op。 */
async function migrateLegacyKeys(s){
  const [recList, cfgList] = await Promise.all([
    s.list({ prefix: "rec:" }),
    s.list({ prefix: "cfg:" })
  ]);
  const legacy = [...recList.blobs, ...cfgList.blobs].filter(b => b.key.split(":")[1] && b.key.split(":")[1].includes("%"));
  if(!legacy.length) return false;
  await Promise.all(legacy.map(async b => {
    const parts = b.key.split(":");
    const site = decodeURIComponent(parts[1]);
    const newKey = parts[0] === "cfg"
      ? cfgKey(site)
      : `rec:${b64e(site)}:${parts.slice(2).join(":")}`;
    const data = await s.get(b.key, { type: "json" });
    if(data != null){
      const existing = await s.get(newKey, { type: "json" });
      if(existing == null) await s.setJSON(newKey, data);
    }
    await s.delete(b.key);
  }));
  return true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

function authorized(req){
  const user = process.env.SITE_AUTH_USER || "kg";
  const pass = process.env.SITE_AUTH_PASS || "";
  if(!pass) return true;
  const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  return (req.headers.get("authorization") || "") === expected;
}

async function readSite(s, site){
  const [config, listed] = await Promise.all([
    s.get(cfgKey(site), { type: "json" }),
    s.list({ prefix: "rec:" + b64e(site) + ":" })
  ]);
  const recs = await Promise.all(listed.blobs.map(b => s.get(b.key, { type: "json" })));
  const out = { config, labor: [], equipment: [] };
  listed.blobs.forEach((b, i) => {
    const kind = b.key.split(":")[2];
    if(recs[i] && KINDS.includes(kind)) out[kind].push(recs[i]);
  });
  return out;
}

export default async (req) => {
  if(!authorized(req)){
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="KG Manpower"' } });
  }
  const s = store();
  const url = new URL(req.url);

  if(req.method === "GET"){
    await migrateLegacyKeys(s);

    const site = url.searchParams.get("site");
    if(site) return json(await readSite(s, site));

    const master = await s.get("master", { type: "json" });
    const sites = (master && master.sites) || [];
    const [listed, cfgs] = await Promise.all([
      s.list({ prefix: "rec:" }),
      Promise.all(sites.map(site => s.get(cfgKey(site), { type: "json" })))
    ]);
    const recs = await Promise.all(listed.blobs.map(b => s.get(b.key, { type: "json" })));
    const stores = {};
    sites.forEach((site, i) => { stores[site] = { config: cfgs[i], labor: [], equipment: [] }; });
    listed.blobs.forEach((b, i) => {
      const parts = b.key.split(":");
      const site = decodeSeg(parts[1]);
      const kind = parts[2];
      if(!stores[site]) stores[site] = { config: null, labor: [], equipment: [] };
      if(recs[i] && KINDS.includes(kind)) stores[site][kind].push(recs[i]);
    });
    return json({ master, stores });
  }

  if(req.method === "POST"){
    let body;
    try{ body = await req.json(); }catch(e){ return json({ error: "invalid json" }, 400); }

    switch(body.op){
      case "master":
        if(!Array.isArray(body.sites) || !body.sites.length) return json({ error: "sites required" }, 400);
        await s.setJSON("master", { sites: body.sites });
        return json({ ok: true });

      case "config":
        if(!body.site || !body.config) return json({ error: "site/config required" }, 400);
        await s.setJSON(cfgKey(body.site), body.config);
        return json({ ok: true });

      case "record":
        if(!body.site || !KINDS.includes(body.kind) || !body.record || !body.record.id)
          return json({ error: "site/kind/record required" }, 400);
        await s.setJSON(recKey(body.site, body.kind, body.record.id), body.record);
        return json({ ok: true });

      case "deleteRecord":
        if(!body.site || !KINDS.includes(body.kind) || !body.id) return json({ error: "site/kind/id required" }, 400);
        await s.delete(recKey(body.site, body.kind, body.id));
        return json({ ok: true });

      case "clearSite": {
        if(!body.site) return json({ error: "site required" }, 400);
        const listed = await s.list({ prefix: "rec:" + b64e(body.site) + ":" });
        await Promise.all(listed.blobs.map(b => s.delete(b.key)));
        return json({ ok: true, deleted: listed.blobs.length });
      }

      case "clearAll": {
        const listed = await s.list();
        await Promise.all(listed.blobs.map(b => s.delete(b.key)));
        return json({ ok: true, deleted: listed.blobs.length });
      }

      default:
        return json({ error: "unknown op" }, 400);
    }
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/data" };
