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
const cfgKey = s => "cfg:" + encodeURIComponent(s);
const recKey = (s, kind, id) => `rec:${encodeURIComponent(s)}:${kind}:${id}`;
const KINDS = ["labor", "equipment"];

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
    s.list({ prefix: "rec:" + encodeURIComponent(site) + ":" })
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
      const site = decodeURIComponent(parts[1]);
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
        const listed = await s.list({ prefix: "rec:" + encodeURIComponent(body.site) + ":" });
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
