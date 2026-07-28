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

/* 工地名以 base64url 編碼進 key：Blobs 後端會將 key 中的 % 序列
   解碼（key 經 URL 路徑傳輸），encodeURIComponent 形式的 key 與
   前綴因此不可靠；base64url 字元集（A-Za-z0-9_-）不含 % 與 :，
   儲存與前綴比對都安全。新 key 使用 rec2:/cfg2: 命名空間，與
   舊資料完全區隔。 */
const b64e = s => Buffer.from(s, "utf8").toString("base64url");
const b64d = s => Buffer.from(s, "base64url").toString("utf8");

const cfgKey = s => "cfg2:" + b64e(s);
const recKey = (s, kind, id) => `rec2:${b64e(s)}:${kind}:${id}`;
const attKey = (s, id) => `att2:${b64e(s)}:${id}`;
const KINDS = ["labor", "equipment"];

/* 附件（v14）：檔案本體獨立存放（一檔一 blob，含 name/type metadata），
   單據 JSON 只存描述資料（attachments[]），開站全量載入不受影響。
   型別白名單＋大小上限：圖片由前端壓縮後上傳，PDF 原檔（≤4MB，
   base64 後約 5.3MB，仍在 Functions 6MB body 限制內）。 */
const ATT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const ATT_MAX_BYTES = 4 * 1024 * 1024;

/* 刪單據時連同其附件（含各稽核紀錄的附件）一併清除，避免孤兒檔案 */
function attIdsOf(rec){
  const ids = [];
  (rec && rec.attachments || []).forEach(a => a && a.id && ids.push(a.id));
  (rec && rec.audits || []).forEach(au => (au && au.attachments || []).forEach(a => a && a.id && ids.push(a.id)));
  return ids.filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(String(id)));
}

/* 一次性遷移：把舊命名空間（rec:/cfg:，工地段為原始字串或
   %-編碼殘留）的全部 key 無條件搬到 rec2:/cfg2:。
   注意 "rec2:" 不以 "rec:" 開頭，兩個命名空間互不干擾；
   全部搬完後此函式即為 no-op。 */
async function migrateLegacyKeys(s){
  const [recList, cfgList] = await Promise.all([
    s.list({ prefix: "rec:" }),
    s.list({ prefix: "cfg:" })
  ]);
  const legacy = [...recList.blobs, ...cfgList.blobs];
  if(!legacy.length) return false;
  await Promise.all(legacy.map(async b => {
    const parts = b.key.split(":");
    if(parts.length < 2){ await s.delete(b.key); return; }
    let site = parts[1];
    try{ site = decodeURIComponent(site); }catch(e){}
    const newKey = parts[0] === "cfg"
      ? cfgKey(site)
      : `rec2:${b64e(site)}:${parts.slice(2).join(":")}`;
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
    s.list({ prefix: "rec2:" + b64e(site) + ":" })
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
    /* 附件下載：獨立路徑，回傳二進位＋原始 Content-Type。
       附件內容不可變（id 唯一、覆蓋即換新 id），可長時間快取 */
    const attId = url.searchParams.get("attachment");
    const attSite = url.searchParams.get("site");
    if(attId && attSite){
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(attId)) return json({ error: "invalid attachment id" }, 400);
      const got = await s.getWithMetadata(attKey(attSite, attId), { type: "arrayBuffer" });
      if(!got || !got.data) return json({ error: "not found" }, 404);
      const meta = got.metadata || {};
      return new Response(got.data, { status: 200, headers: {
        "content-type": ATT_TYPES.includes(meta.type) ? meta.type : "application/octet-stream",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name || attId)}`,
        "cache-control": "private, max-age=86400"
      }});
    }

    await migrateLegacyKeys(s);

    const site = url.searchParams.get("site");
    if(site) return json(await readSite(s, site));

    const master = await s.get("master", { type: "json" });
    const sites = (master && master.sites) || [];
    const [listed, cfgs] = await Promise.all([
      s.list({ prefix: "rec2:" }),
      Promise.all(sites.map(site => s.get(cfgKey(site), { type: "json" })))
    ]);
    const recs = await Promise.all(listed.blobs.map(b => s.get(b.key, { type: "json" })));
    const stores = {};
    sites.forEach((site, i) => { stores[site] = { config: cfgs[i], labor: [], equipment: [] }; });
    listed.blobs.forEach((b, i) => {
      const parts = b.key.split(":");
      let site;
      try{ site = b64d(parts[1]); }catch(e){ return; }
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

      case "record": {
        if(!body.site || !KINDS.includes(body.kind) || !body.record || !body.record.id)
          return json({ error: "site/kind/record required" }, 400);
        /* id 僅允許安全字元：防止惡意 id 造成前端屬性注入（XSS）
           或含 : / % 的 id 破壞 Blobs key 結構（uid() 產生的 id 為純 base36） */
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(body.record.id)))
          return json({ error: "invalid record id" }, 400);
        /* 樂觀並發控制：baseV 為客戶端載入時的版本。版本不符代表
           這筆單在你編輯期間被其他人改過（或已被刪除），回 409
           讓前端提示重新載入，避免無聲覆蓋他人內容。 */
        const key = recKey(body.site, body.kind, body.record.id);
        const existing = await s.get(key, { type: "json" });
        const baseV = Number(body.baseV) || 0;
        if(existing && (Number(existing.v) || 0) !== baseV)
          return json({ error: "conflict", reason: "modified" }, 409);
        if(!existing && baseV > 0)
          return json({ error: "conflict", reason: "deleted" }, 409);
        const rec = Object.assign({}, body.record, {
          v: baseV + 1,
          updatedAt: new Date().toISOString()
        });
        await s.setJSON(key, rec);
        return json({ ok: true, v: rec.v, updatedAt: rec.updatedAt });
      }

      case "addOption": {
        /* 選項新增改由伺服器端合併，避免兩人同時新增時整包互相覆蓋 */
        const POOLS = ["vendors","locations","categories","equipTypes","people","workers","laborTypes"];
        if(!body.site || !POOLS.includes(body.pool) || !body.value || typeof body.value !== "string")
          return json({ error: "site/pool/value required" }, 400);
        const val = body.value.trim();
        /* v15.1：人員池僅接受單一人名（前端已擋，伺服器端為第二道防線，
           防以「/」等分隔符把多人並列塞進名單規避回報單人限制） */
        if(body.pool === "people" && /[+＋/／\\、,，;；:：\s]/.test(val))
          return json({ error: "person name must be a single name" }, 400);
        const ck = cfgKey(body.site);
        const cfg = (await s.get(ck, { type: "json" })) || {};
        if(!Array.isArray(cfg[body.pool])) cfg[body.pool] = [];
        if(val && !cfg[body.pool].includes(val)){
          cfg[body.pool].push(val);
          await s.setJSON(ck, cfg);
        }
        return json({ ok: true, pool: cfg[body.pool] });
      }

      case "uploadAttachment": {
        if(!body.site || !body.id || !body.data) return json({ error: "site/id/data required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(body.id))) return json({ error: "invalid attachment id" }, 400);
        if(!ATT_TYPES.includes(body.type)) return json({ error: "type not allowed" }, 400);
        let buf;
        try{ buf = Buffer.from(String(body.data), "base64"); }catch(e){ return json({ error: "invalid data" }, 400); }
        if(!buf.length || buf.length > ATT_MAX_BYTES) return json({ error: "size limit exceeded" }, 400);
        const name = String(body.name || body.id).slice(0, 200);
        await s.set(attKey(body.site, body.id), buf, { metadata: { name, type: body.type } });
        return json({ ok: true, id: body.id, size: buf.length });
      }

      case "deleteAttachment":
        if(!body.site || !body.id) return json({ error: "site/id required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(body.id))) return json({ error: "invalid attachment id" }, 400);
        await s.delete(attKey(body.site, body.id));
        return json({ ok: true });

      case "deleteRecord": {
        if(!body.site || !KINDS.includes(body.kind) || !body.id) return json({ error: "site/kind/id required" }, 400);
        if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(body.id)))
          return json({ error: "invalid record id" }, 400);
        const rKey = recKey(body.site, body.kind, body.id);
        /* 先讀出單據，連同其引用的附件一併刪除（避免孤兒檔案佔用空間） */
        const rec = await s.get(rKey, { type: "json" });
        await s.delete(rKey);
        if(rec) await Promise.all(attIdsOf(rec).map(id => s.delete(attKey(body.site, id)).catch(() => {})));
        return json({ ok: true });
      }

      case "clearSite": {
        if(!body.site) return json({ error: "site required" }, 400);
        const [listed, atts] = await Promise.all([
          s.list({ prefix: "rec2:" + b64e(body.site) + ":" }),
          s.list({ prefix: "att2:" + b64e(body.site) + ":" })
        ]);
        const all = [...listed.blobs, ...atts.blobs];
        await Promise.all(all.map(b => s.delete(b.key)));
        return json({ ok: true, deleted: all.length });
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
