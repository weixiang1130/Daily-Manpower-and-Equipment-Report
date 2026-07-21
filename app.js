/* ==========================================================
   點工機具稽核系統 - 前端 v8（共用資料庫版）

   v8 重點：
   1. 資料改存雲端共用資料庫（Netlify Functions + Blobs，
      API：/api/data）——所有使用者讀寫同一份資料，任何人的
      填報其他人重新整理後都看得到；不再使用 localStorage 存
      業務資料（僅 sessionStorage 記住本分頁的工地與管理員狀態）。
   2. 填錯工地防呆（三道）：
      a. 每次開啟頁面必須先在攔截頁明確選定工地
      b. 申請/回報表單面板常駐醒目的目前工地徽章
      c. 送出「申請」前彈出工地確認視窗
   3. 同筆紀錄若兩人同時編輯為後寫者覆蓋（last-write-wins）；
      不同紀錄互不影響（每筆獨立儲存）。

   注意：以下 GENERIC_CONFIG 僅為範例佔位資料。實際名單由
   config.local.js 提供（地端手動放置；Netlify 部署時由環境
   變數 LOCAL_CONFIG_JS 於建置時產生），不進入程式碼庫。
   ========================================================== */

const ADD_NEW = "__ADD_NEW__";

const GENERIC_CONFIG = {
  sites: ["工地A", "工地B", "工地C"],
  vendors: ["分包商A", "分包商B", "分包商C"],
  locations: ["一樓", "二樓", "三樓", "室外廣場", "地下室", "料場", "其他"],
  categories: ["搬料", "掃地/環境5S", "打石", "整地", "安衛設施維護", "鋼筋作業", "模板作業", "吊掛作業", "其他"],
  equipTypes: ["吊車", "挖土機", "堆高機", "洗車台", "發電機", "其他"],
  people: ["王小明", "李小華", "陳大文"],
  laborTypes: ["粗工", "技術工", "打石工", "其他"]
};

const LOCAL = (typeof window !== "undefined" && window.LOCAL_CONFIG) ? window.LOCAL_CONFIG : {};

let MASTER = { sites: [], currentSite: null };
let SITE_CACHE = {};
let READY = false;

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
/* 以「本地時區」取日期字串——toISOString 是 UTC，台灣早上 8 點前
   會被記成前一天，直接影響按月計價的歸屬 */
function localDate(d = new Date()){
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function fmt(n){ const v = Math.round((Number(n)||0)*100)/100; return String(v); }

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove("show"), 2600);
}

/* ==========================================================
   API 層（共用資料庫）

   ★ 前後端的唯一接縫：整個前端只透過本函式與後端溝通，
     合約規格見 docs/API-CONTRACT.md。未來改接公司標準後端
     （不同語言/資料庫）時，只要新後端實作同一份合約，前端
     不需任何修改；若後端掛在不同路徑，於 config.local.js
     設定 apiBase 即可（例：window.LOCAL_CONFIG = { apiBase:
     "/kg-audit/api/data", ... }）。
   ========================================================== */
const API_BASE = (LOCAL.apiBase && String(LOCAL.apiBase)) || "/api/data";

async function api(method, body, query){
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const res = await fetch(API_BASE + qs, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if(!res.ok){
    const err = new Error("API " + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const apiSaveMaster = () => api("POST", { op:"master", sites: MASTER.sites });
const apiSaveConfig = (site) => api("POST", { op:"config", site, config: SITE_CACHE[site].config });
const apiSaveRecord = (kind, rec, baseV) => api("POST", { op:"record", site: MASTER.currentSite, kind, record: rec, baseV: baseV || 0 });
const apiDeleteRecord = (kind, id) => api("POST", { op:"deleteRecord", site: MASTER.currentSite, kind, id });

/* 重新抓取單一工地的最新資料（開啟編輯前呼叫，避免用到舊資料） */
async function refetchSite(site){
  const st = await api("GET", null, { site });
  SITE_CACHE[site] = {
    config: st.config || (SITE_CACHE[site] && SITE_CACHE[site].config) || defaultSiteConfig(),
    labor: st.labor || [],
    equipment: st.equipment || []
  };
  sortRecords(SITE_CACHE[site]);
}

/* 鎖單：config.lockDate（含）以前的單據，非管理員不可增修刪 */
function isLockedDate(dateStr){
  const lock = cur() && cur().config.lockDate;
  return !!(lock && dateStr && dateStr <= lock && !isAdmin());
}

function sortRecords(store){
  const byNewest = (a,b)=> String(b.id).localeCompare(String(a.id));
  store.labor.sort(byNewest);
  store.equipment.sort(byNewest);
  // 既有工地的 config 可能缺少後來新增的名單池（v11 工種），載入時補預設值
  if(store.config && (!Array.isArray(store.config.laborTypes) || !store.config.laborTypes.length)){
    store.config.laborTypes = GENERIC_CONFIG.laborTypes.slice();
  }
}

function defaultSiteConfig(){
  return {
    vendors: (LOCAL.vendors && LOCAL.vendors.length ? LOCAL.vendors : GENERIC_CONFIG.vendors).slice(),
    locations: GENERIC_CONFIG.locations.slice(),
    categories: GENERIC_CONFIG.categories.slice(),
    equipTypes: GENERIC_CONFIG.equipTypes.slice(),
    people: (LOCAL.people && LOCAL.people.length ? LOCAL.people : GENERIC_CONFIG.people).slice(),
    workers: [],
    laborTypes: GENERIC_CONFIG.laborTypes.slice(),
    lockDate: ""
  };
}
function cur(){ return SITE_CACHE[MASTER.currentSite]; }

function anyEditing(){
  return !!(editingLaborApplyId || editingLaborReportId || editingEquipApplyId || editingEquipReportId || auditSelectedId);
}

/* ==========================================================
   啟動：載入共用資料庫 → 選工地攔截頁
   ========================================================== */
function showLoading(msg){
  const el = document.getElementById("appLoading");
  if(msg === false){ el.hidden = true; return; }
  document.getElementById("appLoadingMsg").textContent = msg || "正在連線共用資料庫…";
  el.hidden = false;
}

async function boot(){
  showLoading("正在連線共用資料庫…");
  try{
    const data = await api("GET", null, { scope: "all" });

    if(data.master && Array.isArray(data.master.sites) && data.master.sites.length){
      MASTER.sites = data.master.sites;
    }else{
      MASTER.sites = (LOCAL.sites && LOCAL.sites.length ? LOCAL.sites : GENERIC_CONFIG.sites).slice();
      await apiSaveMaster();
    }

    SITE_CACHE = {};
    const seedJobs = [];
    for(const site of MASTER.sites){
      const st = (data.stores && data.stores[site]) || {};
      SITE_CACHE[site] = {
        config: st.config || null,
        labor: st.labor || [],
        equipment: st.equipment || []
      };
      sortRecords(SITE_CACHE[site]);
      if(!SITE_CACHE[site].config){
        SITE_CACHE[site].config = defaultSiteConfig();
        seedJobs.push(apiSaveConfig(site));
      }
    }
    if(seedJobs.length) await Promise.all(seedJobs);

    showLoading(false);

    const remembered = sessionStorage.getItem("dm_site");
    if(remembered && MASTER.sites.includes(remembered)){
      enterSite(remembered);
    }else{
      showSiteGate();
    }
  }catch(e){
    showLoading(false);
    document.getElementById("appFatal").hidden = false;
  }
}

function showSiteGate(){
  const grid = document.getElementById("siteGateGrid");
  grid.innerHTML = MASTER.sites.map(s=>`<button type="button" class="gate-btn" data-site="${esc(s)}">${esc(s)}</button>`).join("");
  grid.querySelectorAll(".gate-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.getElementById("siteGate").hidden = true;
      enterSite(btn.dataset.site);
    });
  });
  document.getElementById("siteGate").hidden = false;
}

function enterSite(site){
  MASTER.currentSite = site;
  sessionStorage.setItem("dm_site", site);
  READY = true;
  renderAll();
}

/* 重新整理：從共用資料庫重新載入全部資料 */
async function refreshData(silent){
  if(anyEditing()){
    if(!silent) toast("表單編輯中，請先送出或取消再重新整理");
    return;
  }
  if(!silent) showLoading("重新整理中…");
  try{
    const data = await api("GET", null, { scope: "all" });
    if(data.master && data.master.sites && data.master.sites.length) MASTER.sites = data.master.sites;
    for(const site of MASTER.sites){
      const st = (data.stores && data.stores[site]) || {};
      SITE_CACHE[site] = {
        config: st.config || SITE_CACHE[site]?.config || defaultSiteConfig(),
        labor: st.labor || [],
        equipment: st.equipment || []
      };
      sortRecords(SITE_CACHE[site]);
    }
    if(!MASTER.sites.includes(MASTER.currentSite)){
      MASTER.currentSite = MASTER.sites[0];
      sessionStorage.setItem("dm_site", MASTER.currentSite);
    }
    renderAll();
    if(!silent) toast("已載入最新資料");
  }catch(e){
    if(!silent) toast("⚠ 重新整理失敗，請檢查網路");
  }finally{
    if(!silent) showLoading(false);
  }
}

/* ==========================================================
   工地切換（Context Switch）
   ========================================================== */
function renderSitePicker(){
  const sel = document.getElementById("currentSite");
  sel.innerHTML = MASTER.sites.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = MASTER.currentSite;
  sel.onchange = ()=>switchSiteContext(sel.value);
}
function switchSiteContext(site, silent){
  MASTER.currentSite = site;
  sessionStorage.setItem("dm_site", site);
  resetLaborApplyForm();
  resetLaborReportForm();
  resetEquipApplyForm();
  resetEquipReportForm();
  resetAuditView();
  auditVendor = "";
  renderAll();
  if(!silent) toast(`已切換至：${site}`);
  refreshData(true);
}
function renderSiteChips(){
  document.querySelectorAll("[data-site-chip]").forEach(el=>{
    el.textContent = "📍 " + (MASTER.currentSite || "");
  });
}

/* ---------------- Top-level / Sub Tabs ---------------- */
function initTabs(){
  document.querySelectorAll(".tabs > .tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(!READY) return;
      if(btn.dataset.tab === "audit" && !isAdmin()){ toast("僅限管理員（成控）使用"); return; }
      document.querySelectorAll(".tabs > .tab").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll("#app > .tab-panel").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
      if(btn.dataset.tab === "dashboard"){ renderDashboard(); refreshData(true); }
      if(btn.dataset.tab === "labor" || btn.dataset.tab === "equipment"){ refreshData(true); }
      if(btn.dataset.tab === "history") renderReport(currentReport);
      if(btn.dataset.tab === "audit"){ renderAuditView(); refreshData(true); }
      if(btn.dataset.tab === "settings") renderSettings();
    });
  });
}
function initSubTabs(){
  document.querySelectorAll(".subtabs").forEach(bar=>{
    const section = bar.closest(".tab-panel");
    bar.querySelectorAll(".subtab").forEach(btn=>{
      btn.addEventListener("click", ()=>switchSubTab(section.id, btn.dataset.sub));
    });
  });
}
function switchSubTab(sectionId, subId){
  const section = document.getElementById(sectionId);
  section.querySelectorAll(".subtab").forEach(b=>b.classList.toggle("active", b.dataset.sub===subId));
  section.querySelectorAll(".sub-panel").forEach(p=>p.classList.toggle("active", p.id === "sub-"+subId));
}
function switchMainTab(tabId){
  document.querySelectorAll(".tabs > .tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===tabId));
  document.querySelectorAll("#app > .tab-panel").forEach(p=>p.classList.toggle("active", p.id==="tab-"+tabId));
}

/* ==========================================================
   智慧搜尋下拉（Combobox）：模糊搜尋＋「＋新增選項」
   ========================================================== */
const COMBO = {};
const tagState = { l_locations:[], l_categories:[], e_locations:[], e_type:[] };

function initCombobox(rootId, pool, placeholder, opts={}){
  const root = document.getElementById(rootId);
  root.innerHTML = `<input type="text" class="cb-input" placeholder="${esc(placeholder)}" autocomplete="off"><div class="cb-list" hidden></div>`;
  const input = root.querySelector(".cb-input");
  const list = root.querySelector(".cb-list");
  COMBO[rootId] = { pool, input, list, multi: opts.multi || null, onChange: opts.onChange || null, onPick: opts.onPick || null };

  const options = ()=> (cur() && cur().config[pool]) || [];

  function render(){
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    let matches = q
      ? options().filter(o=>o.toLowerCase().includes(q))
      : options().slice();
    if(q){
      matches.sort((a,b)=> Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)));
    }
    matches = matches.slice(0, 60);
    let html = matches.map(o=>`<div class="cb-item" data-v="${esc(o)}">${esc(o)}</div>`).join("");
    const exact = options().some(o=>o.toLowerCase()===q);
    if(raw && !exact){
      html += `<div class="cb-item cb-add" data-add="${esc(raw)}">＋ 新增選項：「${esc(raw)}」</div>`;
    }
    if(!html) html = '<div class="cb-empty">輸入文字開始搜尋…</div>';
    list.innerHTML = html;
    list.hidden = false;
  }

  function choose(v){
    const cfg = COMBO[rootId];
    if(cfg.onPick){
      // 動作型選擇：選取即回呼並清空輸入框（用於回報頁現場補人）
      input.value = "";
      list.hidden = true;
      cfg.onPick(v);
      return;
    }
    if(cfg.multi){
      if(!tagState[cfg.multi].includes(v)){
        tagState[cfg.multi].push(v);
        renderTags(cfg.multi);
      }
      input.value = "";
      if(cfg.onChange) cfg.onChange();
    }else{
      input.value = v;
    }
    list.hidden = true;
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", e=>{
    if(e.key === "Escape"){ list.hidden = true; }
    if(e.key === "Enter"){
      e.preventDefault();
      if(list.hidden) return;
      const first = list.querySelector(".cb-item");
      if(!first) return;
      if(first.dataset.add !== undefined){
        addPoolOption(pool, first.dataset.add);
        choose(first.dataset.add);
      }else{
        choose(first.dataset.v);
      }
    }
  });
  input.addEventListener("blur", ()=>{ setTimeout(()=>{ list.hidden = true; }, 160); });
  list.addEventListener("mousedown", e=>{
    const item = e.target.closest(".cb-item");
    if(!item) return;
    e.preventDefault();
    if(item.dataset.add !== undefined){
      addPoolOption(pool, item.dataset.add);
      choose(item.dataset.add);
    }else{
      choose(item.dataset.v);
    }
  });
}

function addPoolOption(pool, v){
  const c = cur().config;
  if(!Array.isArray(c[pool])) c[pool] = [];
  if(!c[pool].includes(v)){
    c[pool].push(v);
    // 伺服器端合併單一選項，兩人同時新增不會互相覆蓋
    api("POST", { op:"addOption", site: MASTER.currentSite, pool, value: v })
      .then(resp=>{
        if(resp && Array.isArray(resp.pool)) c[pool] = resp.pool;
        toast(`已新增至本工地共用資料庫：${v}`);
      })
      .catch(()=>toast(`⚠ 「${v}」雲端儲存失敗，請按重新整理後再試`));
  }
}
function getCombo(rootId){ return COMBO[rootId] ? COMBO[rootId].input.value.trim() : ""; }
function setCombo(rootId, v){ if(COMBO[rootId]) COMBO[rootId].input.value = v || ""; }
function comboValid(rootId){
  const cfg = COMBO[rootId];
  const v = getCombo(rootId);
  return !!v && (cur().config[cfg.pool] || []).includes(v);
}
function requireCombo(rootId, label){
  const v = getCombo(rootId);
  if(!v){ toast(`請填寫${label}`); return null; }
  if(!comboValid(rootId)){ toast(`「${v}」不在${label}清單中，請從搜尋結果選取或點「＋ 新增選項」加入`); return null; }
  return v;
}

/* ---------------- Tag list（多值欄位） ---------------- */
function renderTags(fieldId){
  const container = document.getElementById(fieldId + "_tags");
  if(!container) return;
  const values = tagState[fieldId] || [];
  container.innerHTML = values.length
    ? values.map(v=>`<span class="tag-pill">${esc(v)}<button type="button" class="tag-remove" data-field="${fieldId}" data-value="${esc(v)}">×</button></span>`).join("")
    : '<span class="tag-empty">尚未選擇</span>';
}
function setTags(fieldId, values){ tagState[fieldId] = (values||[]).slice(); renderTags(fieldId); }
function initTagRemoveHandler(){
  document.addEventListener("click", e=>{
    const btn = e.target.closest(".tag-remove");
    if(!btn) return;
    const f = btn.dataset.field;
    tagState[f] = (tagState[f]||[]).filter(v=>v!==btn.dataset.value);
    renderTags(f);
  });
}

/* ---------------- select 型 tag picker（工作內容類別／機具類型） ---------------- */
function fillSelect(id, options, placeholder, poolKey){
  const el = document.getElementById(id);
  if(!el) return;
  let html = "";
  if(placeholder) html += `<option value="">${esc(placeholder)}</option>`;
  html += options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join("");
  if(poolKey) html += `<option value="${ADD_NEW}">＋ 新增選項…</option>`;
  el.innerHTML = html;
  if(poolKey) el.dataset.poolKey = poolKey;
}
function initSelectTagPicker(pickerId, fieldId){
  const sel = document.getElementById(pickerId);
  sel.addEventListener("change", ()=>{
    const v = sel.value;
    if(!v) return;
    if(v === ADD_NEW){
      const val = prompt("請輸入要新增的選項名稱：");
      const nv = (val||"").trim();
      sel.value = "";
      if(!nv) return;
      addPoolOption(sel.dataset.poolKey, nv);
      renderOptionPools();
      if(!tagState[fieldId].includes(nv)){ tagState[fieldId].push(nv); renderTags(fieldId); }
      return;
    }
    if(!tagState[fieldId].includes(v)){
      tagState[fieldId].push(v);
      renderTags(fieldId);
    }
    sel.value = "";
  });
}

function renderOptionPools(){
  if(!cur()) return;
  const c = cur().config;
  fillSelect("l_categories_picker", c.categories, "點選以新增工作內容類別", "categories");
  fillSelect("e_type_picker", c.equipTypes, "點選以新增機具類型", "equipTypes");
}

function setStepper(){
  document.querySelectorAll(".step-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const input = document.getElementById(btn.dataset.target);
      const delta = parseFloat(btn.dataset.delta);
      const val = Math.max(0, (parseFloat(input.value)||0) + delta);
      input.value = val;
      input.dispatchEvent(new Event("input"));
    });
  });
}

/* ==========================================================
   點工 — 申請（父層）
   ========================================================== */
let editingLaborApplyId = null;

function initLaborApplyForm(){
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("laborApplyNewBtn").addEventListener("click", resetLaborApplyForm);

  document.getElementById("laborApplyForm").addEventListener("submit", async e=>{
    e.preventDefault();
    const vendor = requireCombo("cb_l_vendor", "分包商");
    if(vendor === null) return;
    const applicant = requireCombo("cb_l_applicant", "申請人");
    if(applicant === null) return;
    const required = parseFloat(document.getElementById("l_required").value) || 0;
    const date = document.getElementById("l_date").value;

    if(isLockedDate(date)){
      toast(`此日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員操作`);
      return;
    }

    // 防呆：送出前確認工地
    const okSite = confirm(`⚠ 工地確認\n\n本筆點工申請將寫入共用資料庫的工地：\n「${MASTER.currentSite}」\n\n${date}・${vendor}・需求 ${fmt(required)} 工・申請人 ${applicant}\n\n工地正確嗎？`);
    if(!okSite) return;

    const store = cur();
    const existing = editingLaborApplyId ? store.labor.find(r=>r.id===editingLaborApplyId) : null;

    const rec = {
      id: editingLaborApplyId || uid(),
      date, vendor, applicant, required,
      workers: existing ? (existing.workers || []) : [],   // v11：申請不再填人員名單（工程師不會知道點工姓名）；保留舊單資料
      locations: tagState.l_locations.slice(),
      categories: tagState.l_categories.slice(),
      categoryNote: document.getElementById("l_categoryNote").value.trim(),
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null
    };

    try{
      const resp = await apiSaveRecord("labor", rec, existing ? existing.v : 0);
      rec.v = resp.v; rec.updatedAt = resp.updatedAt;
    }catch(err){
      if(err.status === 409){
        toast("⚠ 此單剛被其他人修改或刪除，您的變更未儲存；已重新載入最新內容，請確認後再編輯");
        await refetchSite(MASTER.currentSite).catch(()=>{});
        resetLaborApplyForm();
        return;
      }
      toast("⚠ 雲端儲存失敗，資料未送出，請檢查網路後再按一次送出");
      return;
    }

    if(existing){
      const idx = store.labor.findIndex(r=>r.id===rec.id);
      store.labor[idx] = rec;
      toast("申請資料已更新（所有人皆可看到）");
    }else{
      store.labor.unshift(rec);
      toast("點工申請已送出至共用資料庫，待現場回報覆核");
    }
    resetLaborApplyForm();
    renderDashboard();
  });

  resetLaborApplyForm();
}

function resetLaborApplyForm(){
  editingLaborApplyId = null;
  document.getElementById("laborApplyForm").reset();
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("l_required").value = 0;
  setCombo("cb_l_vendor", "");
  setCombo("cb_l_applicant", "");
  setTags("l_locations", []);
  setTags("l_categories", []);
  document.getElementById("laborApplyTitle").textContent = "新增點工申請";
  document.getElementById("laborApplySubmitBtn").textContent = "送出點工申請";
  document.getElementById("laborApplyNewBtn").style.display = "none";
  if(READY) renderLaborList();
}

async function loadLaborApplyRecord(id){
  try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
  const rec = cur().labor.find(r=>r.id===id);
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderLaborList(); return; }
  editingLaborApplyId = id;

  document.getElementById("l_date").value = rec.date;
  setCombo("cb_l_vendor", rec.vendor);
  setCombo("cb_l_applicant", rec.applicant);
  document.getElementById("l_required").value = rec.required;
  setTags("l_locations", rec.locations);
  setTags("l_categories", rec.categories);
  document.getElementById("l_categoryNote").value = rec.categoryNote || "";

  document.getElementById("laborApplyTitle").textContent = `編輯點工申請：${rec.date}・${rec.vendor}`;
  document.getElementById("laborApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("laborApplyNewBtn").style.display = "";

  switchSubTab("tab-labor", "labor-apply");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});
}

/* ==========================================================
   點工 — 回報覆核（子層）
   ========================================================== */
let editingLaborReportId = null;
let typeState = [];   // v11：逐工種覆核列 [{type, work, ot2, otOver}]

/* 數字欄位取值：空白回 null（與 0 區分），其餘轉數字 */
function numFieldVal(id){
  const v = document.getElementById(id).value.trim();
  return v === "" ? null : (parseFloat(v) || 0);
}
function setNumField(id, v){
  document.getElementById(id).value = (v === null || v === undefined) ? "" : v;
}

function initLaborReportForm(){
  document.getElementById("laborReportCancelBtn").addEventListener("click", resetLaborReportForm);
  document.getElementById("l_actual").addEventListener("input", updateLaborDiff);
  document.getElementById("l_zeroWork").addEventListener("change", onZeroWorkToggle);

  const typeBox = document.getElementById("l_typeRows");
  typeBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i) || !typeState[i]) return;
    if(el.classList.contains("tr-work")) typeState[i].work = parseFloat(el.value)||0;
    if(el.classList.contains("tr-ot2")) typeState[i].ot2 = parseFloat(el.value)||0;
    if(el.classList.contains("tr-otover")) typeState[i].otOver = parseFloat(el.value)||0;
    syncTotalsFromTypes();
  });
  typeBox.addEventListener("click", e=>{
    const btn = e.target.closest(".att-remove");
    if(!btn) return;
    typeState.splice(parseInt(btn.dataset.i,10), 1);
    renderTypeRows();
    syncTotalsFromTypes();
  });

  document.getElementById("laborReportForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const store = cur();
    const rec = store.labor.find(r=>r.id===editingLaborReportId);
    if(!rec) return;

    const engineer = requireCombo("cb_l_engineer", "簽單責任工程師");
    if(engineer === null) return;
    if(engineer === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    const actual = parseFloat(document.getElementById("l_actual").value) || 0;
    const ot2Total = parseFloat(document.getElementById("l_ot2").value) || 0;
    const otOverTotal = parseFloat(document.getElementById("l_otOver").value) || 0;
    const totalOT = ot2Total + otOverTotal;
    const zeroWork = document.getElementById("l_zeroWork").checked;

    if(actual === 0 && !zeroWork){
      toast("實際出工數為 0：若當日確實無人出工，請先勾選「0 工確認」再送出");
      return;
    }
    if(zeroWork && actual !== 0){
      toast("已勾選 0 工確認，但簽單實際出工數不為 0，請修正其中一項");
      return;
    }

    const warnings = collectLaborWarnings(typeState, actual, ot2Total, otOverTotal, zeroWork);
    if(warnings.length){
      const ok = confirm("⚠ 系統偵測到以下數據配置異常，請確認是否輸入錯誤：\n\n- " + warnings.join("\n- ") + "\n\n確認無誤仍要送出嗎？");
      if(!ok) return;
    }

    const updated = Object.assign({}, rec, {
      status: "已回報",
      report: {
        reportedAt: localDate(),
        engineer,
        checkFace: document.getElementById("l_check_face").checked,
        checkCard: document.getElementById("l_check_card").checked,
        checkToolbox: document.getElementById("l_check_toolbox").checked,
        // v11：改逐「工種」覆核（粗工/技術工/打石工…）；舊單的逐人 attendance 資料原樣保留
        workTypes: zeroWork ? [] : typeState.map(t=>({type:t.type, work:t.work||0, ot2:t.ot2||0, otOver:t.otOver||0})),
        attendance: (rec.report && rec.report.attendance) || [],
        actual, ot2Total, otOverTotal, totalOT,
        diff: actual - rec.required,
        zeroWork,
        signReturnDate: document.getElementById("l_signReturnDate").value,
        // v12：表單移除「根基自辦」（未填代辦即為自辦）；舊單既有自辦資料原樣承繼保留
        selfDoneWork: (rec.report && rec.report.selfDoneWork != null) ? rec.report.selfDoneWork : null,
        selfDoneHours: (rec.report && rec.report.selfDoneHours != null) ? rec.report.selfDoneHours : null,
        selfDoneNote: (rec.report && (rec.report.selfDoneNote || rec.report.selfDone)) || "",
        vendorDoneWork: numFieldVal("l_vendorWork"),
        vendorDoneHours: numFieldVal("l_vendorHours"),
        vendorDoneNote: document.getElementById("l_vendorNote").value.trim(),
        conclusion: document.getElementById("l_conclusion").value.trim()
      }
    });

    try{
      const resp = await apiSaveRecord("labor", updated, rec.v || 0);
      updated.v = resp.v; updated.updatedAt = resp.updatedAt;
    }catch(err){
      if(err.status === 409){
        toast("⚠ 此單剛被其他人修改或刪除，您的回報未儲存；已重新載入最新內容，請重新填寫");
        await refetchSite(MASTER.currentSite).catch(()=>{});
        resetLaborReportForm();
        return;
      }
      toast("⚠ 雲端儲存失敗，回報未送出，請檢查網路後再按一次送出");
      return;
    }

    const idx = store.labor.findIndex(r=>r.id===updated.id);
    store.labor[idx] = updated;
    toast(zeroWork ? "已以 0 工寫入共用資料庫" : "回報已儲存至共用資料庫");
    resetLaborReportForm();
    renderDashboard();
  });

  resetLaborReportForm();
}

function collectLaborWarnings(types, actual, ot2Total, otOverTotal, zeroWork){
  const w = [];
  if(zeroWork) return w;
  types.forEach(t=>{
    if(!(t.work > 0)) w.push(`${t.type}：已加入工種，但出工數為 0`);
    // 加班前 2 小時的上限＝人數 × 2 小時
    if(t.work > 0 && t.ot2 > t.work * 2) w.push(`${t.type}：前 2 小時加班 ${fmt(t.ot2)} 小時，超過 出工數 ${fmt(t.work)} 工 × 2 小時的上限`);
    if(t.work > 0 && (t.ot2 + t.otOver) > t.work * 8) w.push(`${t.type}：加班合計 ${fmt(t.ot2 + t.otOver)} 小時，相對出工數 ${fmt(t.work)} 工異常偏高`);
    if(t.otOver > 0 && !(t.ot2 > 0)) w.push(`${t.type}：填了第 3 小時起的加班，但前 2 小時為 0（加班時數應先計入前 2 小時）`);
  });
  if(actual > 0 && types.length === 0){
    w.push("未填工種明細（粗工／技術工／打石工⋯）——建議逐工種記錄以利計價");
  }
  const totalOT = ot2Total + otOverTotal;
  if(actual > 0 && ot2Total > actual * 2) w.push(`前 2 小時加班總計 ${fmt(ot2Total)} 小時，超過 出工數 ${fmt(actual)} 工 × 2 小時的上限`);
  if(actual > 0 && totalOT > actual * 8) w.push(`加班總時數 ${fmt(totalOT)} 小時已超過出工數 ${fmt(actual)} 工的合理上限（每工 8 小時）`);
  return w;
}

function renderTypeRows(){
  const box = document.getElementById("l_typeRows");
  const zero = document.getElementById("l_zeroWork").checked;
  // 有工種明細時，總數欄自動加總（唯讀）；無明細時開放手填（相容舊單）
  const lock = typeState.length > 0;
  ["l_actual","l_ot2","l_otOver"].forEach(id=>{
    const el = document.getElementById(id);
    el.readOnly = lock;
    el.classList.toggle("readonly-field", lock);
  });
  if(!typeState.length){
    box.innerHTML = '<div class="empty-row">尚未加入工種——請在下方選擇工種（粗工／技術工／打石工⋯）逐工種記錄；若當日完全無人出工，勾選「0 工確認」</div>';
    return;
  }
  box.classList.toggle("disabled", zero);
  box.innerHTML = typeState.map((t,i)=>`
    <div class="att-row present">
      <span class="tr-name">${esc(t.type)}</span>
      <div class="att-fields">
        <label>出工數<input type="number" class="tr-work" data-i="${i}" step="0.5" min="0" value="${t.work}" ${zero?'disabled':''}></label>
        <label>加班·前2小時<input type="number" class="tr-ot2" data-i="${i}" step="0.5" min="0" value="${t.ot2}" ${zero?'disabled':''}></label>
        <label>加班·第3小時起<input type="number" class="tr-otover" data-i="${i}" step="0.5" min="0" value="${t.otOver}" ${zero?'disabled':''}></label>
      </div>
      <button type="button" class="att-remove" data-i="${i}" title="移除此工種">×</button>
    </div>`).join("");
}

/* v11 回報改逐工種：選工種加入一列（工程師不需知道點工姓名） */
function addTypeRow(type){
  if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
  if(document.getElementById("l_zeroWork").checked){ toast("已勾選 0 工確認，請先取消再加入工種"); return; }
  if(typeState.some(t=>t.type===type)){ toast(`「${type}」已在覆核清單中，請直接修改該列數字`); return; }
  typeState.push({ type, work:1, ot2:0, otOver:0 });
  renderTypeRows();
  syncTotalsFromTypes();
}

function syncTotalsFromTypes(){
  if(!typeState.length) { updateLaborDiff(); return; }
  document.getElementById("l_actual").value = typeState.reduce((s,t)=>s+(t.work||0),0);
  document.getElementById("l_ot2").value = typeState.reduce((s,t)=>s+(t.ot2||0),0);
  document.getElementById("l_otOver").value = typeState.reduce((s,t)=>s+(t.otOver||0),0);
  updateLaborDiff();
}

function onZeroWorkToggle(){
  const zero = document.getElementById("l_zeroWork").checked;
  if(zero){
    typeState = [];
    document.getElementById("l_actual").value = 0;
    document.getElementById("l_ot2").value = 0;
    document.getElementById("l_otOver").value = 0;
  }
  renderTypeRows();
  updateLaborDiff();
}

function updateLaborDiff(){
  if(!editingLaborReportId){ document.getElementById("l_diff").value = ""; return; }
  const rec = cur().labor.find(r=>r.id===editingLaborReportId);
  if(!rec) return;
  const actual = parseFloat(document.getElementById("l_actual").value) || 0;
  const diff = actual - rec.required;
  document.getElementById("l_diff").value = diff===0 ? "0（相符）" : (diff>0 ? "+"+fmt(diff)+"（超出申報）" : fmt(diff)+"（短少，需追查）");
}

function resetLaborReportForm(){
  editingLaborReportId = null;
  typeState = [];
  document.getElementById("laborReportForm").reset();
  setCombo("cb_l_engineer", "");
  document.getElementById("l_typeRows").innerHTML = "";
  document.getElementById("l_diff").value = "";
  document.getElementById("laborReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  document.getElementById("laborReportSubmitBtn").disabled = true;
  if(READY) renderLaborList();
}

async function loadLaborReportRecord(id){
  try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
  const rec = cur().labor.find(r=>r.id===id);
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderLaborList(); return; }
  editingLaborReportId = id;

  // v11：逐工種覆核；舊單（僅逐人 attendance）帶總數手填即可
  const prevTypes = (rec.report && rec.report.workTypes) || [];
  typeState = prevTypes.map(t=>({type:t.type, work:t.work||0, ot2:t.ot2||0, otOver:t.otOver||0}));

  document.getElementById("laborReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(MASTER.currentSite)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　需求工數：${fmt(rec.required)}　申請人：${esc(rec.applicant)}
    ${(rec.locations||[]).length ? "　地點："+esc(rec.locations.join("、")) : ""}
  </div>`;

  const rep = rec.report || {};
  document.getElementById("l_check_face").checked = !!rep.checkFace;
  document.getElementById("l_check_card").checked = !!rep.checkCard;
  document.getElementById("l_check_toolbox").checked = !!rep.checkToolbox;
  document.getElementById("l_zeroWork").checked = !!rep.zeroWork;
  renderTypeRows();
  document.getElementById("l_actual").value = rep.actual != null ? rep.actual : 0;
  // 分段加班：新單帶 ot2/otOver；舊單（只有 totalOT）帶入前 2 小時欄供編輯
  document.getElementById("l_ot2").value = rep.ot2Total != null ? rep.ot2Total : (rep.totalOT || 0);
  document.getElementById("l_otOver").value = rep.otOverTotal != null ? rep.otOverTotal : 0;
  if(typeState.length) syncTotalsFromTypes();
  updateLaborDiff();
  document.getElementById("l_signReturnDate").value = rep.signReturnDate || "";
  setCombo("cb_l_engineer", rep.engineer || "");
  setNumField("l_vendorWork", rep.vendorDoneWork);
  setNumField("l_vendorHours", rep.vendorDoneHours);
  document.getElementById("l_vendorNote").value = rep.vendorDoneNote || rep.vendorDone || "";
  document.getElementById("l_conclusion").value = rep.conclusion || "";
  document.getElementById("laborReportSubmitBtn").disabled = false;

  switchSubTab("tab-labor", "labor-report");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});
}

async function deleteLaborRecord(id){
  const rec = cur().labor.find(r=>r.id===id);
  if(rec && rec.status === "已回報" && !isAdmin()){
    toast("已回報的單據是計價依據，僅限管理員刪除");
    return;
  }
  if(rec && isLockedDate(rec.date)){
    toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員刪除`);
    return;
  }
  if(!confirm("確定要刪除這筆點工紀錄（含其回報）嗎？此操作影響所有使用者且無法復原。")) return;
  try{
    await apiDeleteRecord("labor", id);
  }catch(err){
    toast("⚠ 雲端刪除失敗，請檢查網路後再試");
    return;
  }
  const store = cur();
  store.labor = store.labor.filter(r=>r.id!==id);
  if(editingLaborApplyId===id) resetLaborApplyForm();
  if(editingLaborReportId===id) resetLaborReportForm();
  toast("已刪除");
  renderLaborList();
  renderDashboard();
}

function renderLaborList(){
  const list = cur().labor;
  const el = document.getElementById("laborList");
  if(!list.length){ el.innerHTML = '<div class="empty-row">目前工地尚無點工紀錄</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>狀態</th><th>出工日期</th><th>分包商</th><th>申請人</th><th>需求工數</th><th>簽單實際出工數</th><th>差異</th>
    <th>加班時數</th><th>簽單繳回日</th><th>簽單責任工程師</th><th>現場查核回饋</th><th>操作</th>
  </tr></thead><tbody>
    ${list.map(r=>{
      const rep = r.report;
      const reported = r.status==="已回報" && rep;
      const statusTag = reported
        ? (rep.zeroWork ? '<span class="tag bad">0工</span>' : '<span class="tag ok">已回報</span>')
        : '<span class="tag warn">待回報</span>';
      const diffTag = !reported ? "—" : (rep.diff===0 ? '<span class="tag ok">相符</span>' : '<span class="tag bad">'+fmt(rep.diff)+'</span>');
      const reportBtnLabel = reported ? "編輯回報" : "填寫回報";
      return `<tr>
        <td>${statusTag}</td>
        <td>${esc(r.date)}</td><td>${esc(r.vendor)}</td><td>${esc(r.applicant)}</td>
        <td>${fmt(r.required)}</td>
        <td>${reported ? fmt(rep.actual) : "—"}</td><td>${diffTag}</td>
        <td>${reported ? fmt(rep.totalOT) : "—"}</td>
        <td>${reported ? esc(rep.signReturnDate||"—") : "—"}</td>
        <td>${reported ? esc(rep.engineer||"—") : "—"}</td>
        <td>${reported ? esc(rep.conclusion||"—") : "—"}</td>
        <td class="row-actions">
          <button type="button" class="btn-mini btn-edit" data-id="${esc(r.id)}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${esc(r.id)}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${esc(r.id)}">刪除</button>
        </td>
      </tr>`;
    }).join("")}
  </tbody></table>`;

  el.querySelectorAll(".btn-edit").forEach(btn=>btn.addEventListener("click", ()=>loadLaborApplyRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-report").forEach(btn=>btn.addEventListener("click", ()=>loadLaborReportRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-del").forEach(btn=>btn.addEventListener("click", ()=>deleteLaborRecord(btn.dataset.id)));
}

/* ==========================================================
   機具 — 申請
   ========================================================== */
let editingEquipApplyId = null;

function initEquipApplyForm(){
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("equipApplyNewBtn").addEventListener("click", resetEquipApplyForm);

  document.getElementById("equipApplyForm").addEventListener("submit", async e=>{
    e.preventDefault();
    const vendor = requireCombo("cb_e_vendor", "機具廠商");
    if(vendor === null) return;
    const applicant = requireCombo("cb_e_applicant", "申請人");
    if(applicant === null) return;
    const types = tagState.e_type.slice();
    if(!types.length){ toast("請選擇機具類型"); return; }
    const requiredQty = parseFloat(document.getElementById("e_requiredQty").value) || 0;
    const date = document.getElementById("e_date").value;

    if(isLockedDate(date)){
      toast(`此日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員操作`);
      return;
    }

    // 防呆：送出前確認工地
    const okSite = confirm(`⚠ 工地確認\n\n本筆機具申請將寫入共用資料庫的工地：\n「${MASTER.currentSite}」\n\n${date}・${vendor}・${types.join("、")}・需求 ${fmt(requiredQty)}\n\n工地正確嗎？`);
    if(!okSite) return;

    const store = cur();
    const existing = editingEquipApplyId ? store.equipment.find(r=>r.id===editingEquipApplyId) : null;

    const rec = {
      id: editingEquipApplyId || uid(),
      date, vendor, applicant, types,
      model: document.getElementById("e_model").value.trim(),
      requiredQty,
      contracted: document.querySelector('input[name="e_contract"]:checked').value,
      locations: tagState.e_locations.slice(),
      content: document.getElementById("e_content").value.trim(),
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null
    };

    try{
      const resp = await apiSaveRecord("equipment", rec, existing ? existing.v : 0);
      rec.v = resp.v; rec.updatedAt = resp.updatedAt;
    }catch(err){
      if(err.status === 409){
        toast("⚠ 此單剛被其他人修改或刪除，您的變更未儲存；已重新載入最新內容，請確認後再編輯");
        await refetchSite(MASTER.currentSite).catch(()=>{});
        resetEquipApplyForm();
        return;
      }
      toast("⚠ 雲端儲存失敗，資料未送出，請檢查網路後再按一次送出");
      return;
    }

    if(existing){
      const idx = store.equipment.findIndex(r=>r.id===rec.id);
      store.equipment[idx] = rec;
      toast("申請資料已更新（所有人皆可看到）");
    }else{
      store.equipment.unshift(rec);
      toast("機具申請已送出至共用資料庫，待現場回報");
    }
    resetEquipApplyForm();
    renderDashboard();
  });

  resetEquipApplyForm();
}

function resetEquipApplyForm(){
  editingEquipApplyId = null;
  document.getElementById("equipApplyForm").reset();
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("e_requiredQty").value = 1;
  setCombo("cb_e_vendor", "");
  setCombo("cb_e_applicant", "");
  setTags("e_type", []);
  setTags("e_locations", []);
  document.getElementById("equipApplyTitle").textContent = "新增機具申請";
  document.getElementById("equipApplySubmitBtn").textContent = "送出機具申請";
  document.getElementById("equipApplyNewBtn").style.display = "none";
  if(READY) renderEquipList();
}

async function loadEquipApplyRecord(id){
  try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
  const rec = cur().equipment.find(r=>r.id===id);
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderEquipList(); return; }
  editingEquipApplyId = id;

  document.getElementById("e_date").value = rec.date;
  setCombo("cb_e_vendor", rec.vendor);
  setCombo("cb_e_applicant", rec.applicant);
  setTags("e_type", rec.types);
  document.getElementById("e_model").value = rec.model || "";
  document.getElementById("e_requiredQty").value = rec.requiredQty;
  document.querySelector(`input[name="e_contract"][value="${rec.contracted||"是"}"]`).checked = true;
  setTags("e_locations", rec.locations);
  document.getElementById("e_content").value = rec.content || "";

  document.getElementById("equipApplyTitle").textContent = `編輯機具申請：${rec.date}・${rec.vendor}`;
  document.getElementById("equipApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("equipApplyNewBtn").style.display = "";

  switchSubTab("tab-equipment", "equip-apply");
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});
}

/* ==========================================================
   機具 — 回報覆核
   ========================================================== */
let editingEquipReportId = null;
let usageState = [];

function initEquipReportForm(){
  document.getElementById("e_actualHours").addEventListener("input", updateEquipDiff);
  document.getElementById("equipReportCancelBtn").addEventListener("click", resetEquipReportForm);
  document.getElementById("e_zeroUse").addEventListener("change", onZeroUseToggle);

  const usageBox = document.getElementById("e_usage");
  usageBox.addEventListener("change", e=>{
    const cb = e.target.closest("input[type=checkbox][data-i]");
    if(!cb) return;
    const i = parseInt(cb.dataset.i,10);
    usageState[i].present = cb.checked;
    if(cb.checked && !(usageState[i].hours > 0)) usageState[i].hours = 8;
    renderUsage();
    syncTotalsFromUsage();
  });
  usageBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i)) return;
    if(el.classList.contains("usage-hours")) usageState[i].hours = parseFloat(el.value)||0;
    syncTotalsFromUsage();
  });

  document.getElementById("equipReportForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!editingEquipReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const store = cur();
    const rec = store.equipment.find(r=>r.id===editingEquipReportId);
    if(!rec) return;

    const checker = requireCombo("cb_e_checker", "簽單責任工程師");
    if(checker === null) return;
    if(checker === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    const actualHours = parseFloat(document.getElementById("e_actualHours").value) || 0;
    const zeroUse = document.getElementById("e_zeroUse").checked;

    if(actualHours === 0 && !zeroUse){
      toast("實際使用時數為 0：若機具確實未到場／未使用，請先勾選「0 使用確認」再送出");
      return;
    }
    if(zeroUse && actualHours !== 0){
      toast("已勾選 0 使用確認，但實際使用時數不為 0，請修正其中一項");
      return;
    }

    const warnings = collectEquipWarnings(usageState, actualHours, zeroUse);
    if(warnings.length){
      const ok = confirm("⚠ 系統偵測到以下數據配置異常，請確認是否輸入錯誤：\n\n- " + warnings.join("\n- ") + "\n\n確認無誤仍要送出嗎？");
      if(!ok) return;
    }

    const updated = Object.assign({}, rec, {
      status: "已回報",
      report: {
        reportedAt: localDate(),
        checker,
        usage: usageState.map(u=>({type:u.type, present:u.present, hours:u.present?u.hours:0})),
        actualHours,
        diff: actualHours - rec.requiredQty,
        zeroUse,
        signReturnDate: document.getElementById("e_signReturnDate").value,
        // v12：表單移除「根基自辦」；舊單既有自辦資料原樣承繼保留
        selfDoneWork: (rec.report && rec.report.selfDoneWork != null) ? rec.report.selfDoneWork : null,
        selfDoneHours: (rec.report && rec.report.selfDoneHours != null) ? rec.report.selfDoneHours : null,
        selfDoneNote: (rec.report && (rec.report.selfDoneNote || rec.report.selfDone)) || "",
        vendorDoneWork: numFieldVal("e_vendorWork"),
        vendorDoneHours: numFieldVal("e_vendorHours"),
        vendorDoneNote: document.getElementById("e_vendorNote").value.trim()
      }
    });

    try{
      const resp = await apiSaveRecord("equipment", updated, rec.v || 0);
      updated.v = resp.v; updated.updatedAt = resp.updatedAt;
    }catch(err){
      if(err.status === 409){
        toast("⚠ 此單剛被其他人修改或刪除，您的回報未儲存；已重新載入最新內容，請重新填寫");
        await refetchSite(MASTER.currentSite).catch(()=>{});
        resetEquipReportForm();
        return;
      }
      toast("⚠ 雲端儲存失敗，回報未送出，請檢查網路後再按一次送出");
      return;
    }

    const idx = store.equipment.findIndex(r=>r.id===updated.id);
    store.equipment[idx] = updated;
    toast(zeroUse ? "已以 0 時數寫入共用資料庫" : "回報已儲存至共用資料庫");
    resetEquipReportForm();
    renderDashboard();
  });

  resetEquipReportForm();
}

function collectEquipWarnings(usage, actualHours, zeroUse){
  const w = [];
  if(zeroUse) return w;
  usage.filter(u=>u.present).forEach(u=>{
    if(!(u.hours > 0)) w.push(`${u.type}：已勾選到場，但實際使用時數為 0`);
    if(u.hours > 12) w.push(`${u.type}：單日使用 ${fmt(u.hours)} 小時，高於常態`);
  });
  return w;
}

function renderUsage(){
  const box = document.getElementById("e_usage");
  const zero = document.getElementById("e_zeroUse").checked;
  const lock = usageState.length > 0;
  const hoursEl = document.getElementById("e_actualHours");
  hoursEl.readOnly = lock;
  hoursEl.classList.toggle("readonly-field", lock);
  if(!usageState.length){
    box.innerHTML = '<div class="empty-row">此申請單未填寫機具類型，請直接於下方輸入實際使用時數</div>';
    return;
  }
  box.classList.toggle("disabled", zero);
  box.innerHTML = usageState.map((u,i)=>`
    <div class="att-row ${u.present?'present':''}">
      <label class="att-check"><input type="checkbox" data-i="${i}" ${u.present?'checked':''} ${zero?'disabled':''}><span>${esc(u.type)}</span></label>
      <div class="att-fields" ${u.present?'':'style="visibility:hidden;"'}>
        <label>使用時數<input type="number" class="usage-hours" data-i="${i}" step="0.5" min="0" value="${u.hours}" ${zero?'disabled':''}></label>
      </div>
    </div>`).join("");
}

function syncTotalsFromUsage(){
  if(!usageState.length){ updateEquipDiff(); return; }
  const present = usageState.filter(u=>u.present);
  document.getElementById("e_actualHours").value = present.reduce((s,u)=>s+(u.hours||0),0);
  updateEquipDiff();
}

function onZeroUseToggle(){
  const zero = document.getElementById("e_zeroUse").checked;
  if(zero){
    usageState.forEach(u=>{ u.present = false; });
    document.getElementById("e_actualHours").value = 0;
  }
  renderUsage();
  updateEquipDiff();
}

function updateEquipDiff(){
  if(!editingEquipReportId){ document.getElementById("e_diff").value = ""; return; }
  const rec = cur().equipment.find(r=>r.id===editingEquipReportId);
  if(!rec) return;
  const actualHours = parseFloat(document.getElementById("e_actualHours").value) || 0;
  const diff = actualHours - rec.requiredQty;
  document.getElementById("e_diff").value = diff===0 ? "0（相符）" : fmt(diff);
}

function resetEquipReportForm(){
  editingEquipReportId = null;
  usageState = [];
  document.getElementById("equipReportForm").reset();
  setCombo("cb_e_checker", "");
  document.getElementById("e_usage").innerHTML = "";
  document.getElementById("e_diff").value = "";
  document.getElementById("equipReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  document.getElementById("equipReportSubmitBtn").disabled = true;
  if(READY) renderEquipList();
}

async function loadEquipReportRecord(id){
  try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
  const rec = cur().equipment.find(r=>r.id===id);
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderEquipList(); return; }
  editingEquipReportId = id;

  const prev = (rec.report && rec.report.usage) || [];
  usageState = (rec.types||[]).map(type=>{
    const p = prev.find(x=>x.type===type);
    return p ? {type, present:!!p.present, hours:p.hours||0} : {type, present:false, hours:8};
  });

  document.getElementById("equipReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(MASTER.currentSite)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　類型：${esc((rec.types||[]).join("、"))}　需求數量：${fmt(rec.requiredQty)}　申請人：${esc(rec.applicant)}
  </div>`;

  const rep = rec.report || {};
  document.getElementById("e_zeroUse").checked = !!rep.zeroUse;
  renderUsage();
  document.getElementById("e_actualHours").value = rep.actualHours != null ? rep.actualHours : 0;
  updateEquipDiff();
  document.getElementById("e_signReturnDate").value = rep.signReturnDate || "";
  setCombo("cb_e_checker", rep.checker || "");
  setNumField("e_vendorWork", rep.vendorDoneWork);
  setNumField("e_vendorHours", rep.vendorDoneHours);
  document.getElementById("e_vendorNote").value = rep.vendorDoneNote || rep.vendorDone || "";
  document.getElementById("equipReportSubmitBtn").disabled = false;

  switchSubTab("tab-equipment", "equip-report");
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});
}

async function deleteEquipRecord(id){
  const rec = cur().equipment.find(r=>r.id===id);
  if(rec && rec.status === "已回報" && !isAdmin()){
    toast("已回報的單據是計價依據，僅限管理員刪除");
    return;
  }
  if(rec && isLockedDate(rec.date)){
    toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員刪除`);
    return;
  }
  if(!confirm("確定要刪除這筆機具紀錄（含其回報）嗎？此操作影響所有使用者且無法復原。")) return;
  try{
    await apiDeleteRecord("equipment", id);
  }catch(err){
    toast("⚠ 雲端刪除失敗，請檢查網路後再試");
    return;
  }
  const store = cur();
  store.equipment = store.equipment.filter(r=>r.id!==id);
  if(editingEquipApplyId===id) resetEquipApplyForm();
  if(editingEquipReportId===id) resetEquipReportForm();
  toast("已刪除");
  renderEquipList();
  renderDashboard();
}

function renderEquipList(){
  const list = cur().equipment;
  const el = document.getElementById("equipList");
  if(!list.length){ el.innerHTML = '<div class="empty-row">目前工地尚無機具紀錄</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>狀態</th><th>日期</th><th>廠商</th><th>申請人</th><th>類型</th><th>型號</th><th>需求數量</th><th>機具實際工作使用時數</th><th>差異</th>
    <th>簽單繳回日</th><th>簽單責任工程師</th><th>操作</th>
  </tr></thead><tbody>
    ${list.map(x=>{
      const rep = x.report;
      const reported = x.status==="已回報" && rep;
      const statusTag = reported
        ? (rep.zeroUse ? '<span class="tag bad">0時數</span>' : '<span class="tag ok">已回報</span>')
        : '<span class="tag warn">待回報</span>';
      const diffTag = !reported ? "—" : (rep.diff===0 ? '<span class="tag ok">相符</span>' : '<span class="tag bad">'+fmt(rep.diff)+'</span>');
      const reportBtnLabel = reported ? "編輯回報" : "填寫回報";
      return `<tr>
        <td>${statusTag}</td>
        <td>${esc(x.date)}</td><td>${esc(x.vendor)}</td><td>${esc(x.applicant||"—")}</td>
        <td>${esc((x.types||[]).join("、"))}</td>
        <td>${esc(x.model||"—")}</td><td>${fmt(x.requiredQty)}</td>
        <td>${reported ? fmt(rep.actualHours) : "—"}</td><td>${diffTag}</td>
        <td>${reported ? esc(rep.signReturnDate||"—") : "—"}</td>
        <td>${reported ? esc(rep.checker||"—") : "—"}</td>
        <td class="row-actions">
          <button type="button" class="btn-mini btn-edit" data-id="${esc(x.id)}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${esc(x.id)}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${esc(x.id)}">刪除</button>
        </td>
      </tr>`;
    }).join("")}
  </tbody></table>`;

  el.querySelectorAll(".btn-edit").forEach(btn=>btn.addEventListener("click", ()=>loadEquipApplyRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-report").forEach(btn=>btn.addEventListener("click", ()=>loadEquipReportRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-del").forEach(btn=>btn.addEventListener("click", ()=>deleteEquipRecord(btn.dataset.id)));
}

/* ==========================================================
   總覽（跨全部工地彙總，資料來自共用資料庫快取）
   ========================================================== */
function isThisMonth(dateStr){
  if(!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
}

function renderDashboard(){
  if(!READY) return;
  let allLabor = [], allEquip = [];
  MASTER.sites.forEach(site=>{
    const s = SITE_CACHE[site];
    if(!s) return;
    s.labor.forEach(r=>allLabor.push({site, r}));
    s.equipment.forEach(x=>allEquip.push({site, x}));
  });

  const reportedThisMonth = allLabor.filter(({r})=>r.status==="已回報" && r.report && isThisMonth(r.report.reportedAt));
  const abnormal = reportedThisMonth.filter(({r})=>r.report.diff!==0);
  const laborPending = allLabor.filter(({r})=>r.status!=="已回報");
  const equipPending = allEquip.filter(({x})=>x.status!=="已回報");
  const pendingSign = allLabor.filter(({r})=>r.status==="已回報" && r.report && !r.report.signReturnDate);

  const cards = [
    {label:"本月出工回報次數", value:reportedThisMonth.length, cls:""},
    {label:"本月人數異常件數", value:abnormal.length, cls: abnormal.length? "bad":""},
    {label:"點工待回報", value:laborPending.length, cls: laborPending.length? "warn":""},
    {label:"機具待回報", value:equipPending.length, cls: equipPending.length? "warn":""},
    {label:"簽單尚未繳回", value:pendingSign.length, cls: pendingSign.length? "warn":""},
  ];
  document.getElementById("dashCards").innerHTML = cards.map(c=>`
    <div class="card ${c.cls}"><div class="num">${c.value}</div><div class="lbl">${esc(c.label)}</div></div>
  `).join("");

  renderSiteBreakdown();

  const dueEl = document.getElementById("dueList");
  if(!pendingSign.length){
    dueEl.innerHTML = '<div class="empty-row">目前沒有待繳回的簽單</div>';
  }else{
    dueEl.innerHTML = pendingSign.slice(0,10).map(({site,r})=>`
      <div class="row-item">
        <span>${esc(site)}・${esc(r.date)}・${esc(r.vendor)}・${esc((r.report&&r.report.engineer)||"—")}</span>
        <span class="tag warn">尚未填寫簽單繳回日</span>
      </div>
    `).join("");
  }

  const recentEl = document.getElementById("recentAudits");
  const reported = allLabor.filter(({r})=>r.status==="已回報" && r.report)
    .sort((a,b)=>(b.r.report.reportedAt||"").localeCompare(a.r.report.reportedAt||""));
  if(!reported.length){
    recentEl.innerHTML = '<div class="empty-row">尚無出工回報紀錄</div>';
  }else{
    recentEl.innerHTML = reported.slice(0,8).map(({site,r})=>`
      <div class="row-item">
        <span>${esc(site)}・${esc(r.date)}・${esc(r.vendor)}・${esc(r.report.engineer||"—")}</span>
        <span>${r.report.zeroWork ? '<span class="tag bad">0工</span>' : (r.report.diff===0 ? '<span class="tag ok">人數相符</span>' : '<span class="tag bad">差異'+fmt(r.report.diff)+'</span>')}</span>
      </div>
    `).join("");
  }
}

function renderSiteBreakdown(){
  const el = document.getElementById("siteBreakdown");
  const rows = MASTER.sites.map(site=>{
    const s = SITE_CACHE[site] || {labor:[], equipment:[]};
    const lPending = s.labor.filter(r=>r.status!=="已回報").length;
    const ePending = s.equipment.filter(x=>x.status!=="已回報").length;
    const reportedM = s.labor.filter(r=>r.status==="已回報" && r.report && isThisMonth(r.report.reportedAt));
    const abnormalM = reportedM.filter(r=>r.report.diff!==0).length;
    const pendingSign = s.labor.filter(r=>r.status==="已回報" && r.report && !r.report.signReturnDate).length;
    const total = s.labor.length + s.equipment.length;
    return {site, lPending, ePending, reportedCount:reportedM.length, abnormalM, pendingSign, total};
  });

  el.innerHTML = `<table><thead><tr>
    <th>工地</th><th>點工待回報</th><th>機具待回報</th><th>本月出工回報</th><th>本月人數異常</th><th>簽單尚未繳回</th>
  </tr></thead><tbody>
    ${rows.map(r=>`
      <tr class="clickable ${r.site===MASTER.currentSite?'current-site-row':''}" data-site="${esc(r.site)}">
        <td class="site-name-cell">${esc(r.site)}${r.site===MASTER.currentSite?'<span class="tag ok" style="margin-left:6px;">目前</span>':''}${r.total===0?'<span class="tag" style="margin-left:6px;background:#eef1f0;color:var(--ink-400);">尚無紀錄</span>':''}</td>
        <td>${r.lPending? '<span class="tag warn">'+r.lPending+'</span>' : '0'}</td>
        <td>${r.ePending? '<span class="tag warn">'+r.ePending+'</span>' : '0'}</td>
        <td>${r.reportedCount}</td>
        <td>${r.abnormalM? '<span class="tag bad">'+r.abnormalM+'</span>' : '0'}</td>
        <td>${r.pendingSign? '<span class="tag warn">'+r.pendingSign+'</span>' : '0'}</td>
      </tr>
    `).join("")}
  </tbody></table>`;

  el.querySelectorAll("tr[data-site]").forEach(tr=>{
    tr.addEventListener("click", ()=>{
      switchSiteContext(tr.dataset.site);
      switchMainTab("labor");
    });
  });
}

/* ==========================================================
   歷程報表 + CSV 匯出（目前工地）
   ========================================================== */
let currentReport = "labor";
let reportFrom = "", reportTo = "";
let reportVendor = "", reportCat = "";

function matchReportVendor(r){ return !reportVendor || r.vendor === reportVendor; }
function matchReportCat(r, kind){
  if(!reportCat) return true;
  return kind === "labor" ? (r.categories||[]).includes(reportCat) : (r.types||[]).includes(reportCat);
}

function inReportRange(d){
  if(!reportFrom && !reportTo) return true;
  if(!d) return false;
  if(reportFrom && d < reportFrom) return false;
  if(reportTo && d > reportTo) return false;
  return true;
}
function monthRange(offset){
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth()+offset, 1);
  const last = new Date(now.getFullYear(), now.getMonth()+offset+1, 0);
  return [localDate(first), localDate(last)];
}

/* 出工明細：v11 逐工種（粗工(2工/前2h:4h/逾2h:2h)）；舊單 fallback 逐人明細 */
function laborDetail(rep){
  if(!rep) return "";
  if(Array.isArray(rep.workTypes) && rep.workTypes.length){
    return rep.workTypes.map(t=>{
      const parts = [`${fmt(t.work)}工`];
      if(t.ot2) parts.push(`前2h:${fmt(t.ot2)}h`);
      if(t.otOver) parts.push(`逾2h:${fmt(t.otOver)}h`);
      return `${t.type}(${parts.join("/")})`;
    }).join("、");
  }
  if(Array.isArray(rep.attendance)){
    return rep.attendance.filter(a=>a.present)
      .map(a=>`${a.name}(${fmt(a.work)}工${a.ot?`/加班${fmt(a.ot)}h`:""})`).join("、");
  }
  return "";
}

/* 自辦/代辦欄位：新結構（工數/時數/備註）優先，舊版單一文字歸入備註 */
function doneCols(rep){
  return [
    rep.selfDoneWork != null ? fmt(rep.selfDoneWork) : "",
    rep.selfDoneHours != null ? fmt(rep.selfDoneHours) : "",
    rep.selfDoneNote || rep.selfDone || "",
    rep.vendorDoneWork != null ? fmt(rep.vendorDoneWork) : "",
    rep.vendorDoneHours != null ? fmt(rep.vendorDoneHours) : "",
    rep.vendorDoneNote || rep.vendorDone || ""
  ];
}

const REPORT_DEFS = {
  labor: {
    title:"點工紀錄",
    headers:["出工日期","廠商","需求工數","工作內容","工作地點","申請人","狀態","人臉紀錄","白卡紀錄","工具箱紀錄","簽單繳回日","簽單實際出工數","差異","0工確認","簽單責任工程師","加班時數(前2小時)","加班時數(第3小時起)","加班總時數","出工明細(工種)","根基自辦工數","根基自辦時數","根基自辦備註","廠商代辦工數","廠商代辦時數","廠商代辦備註","現場查核回饋"],
    records: ()=>cur().labor.filter(r=>inReportRange(r.date) && matchReportVendor(r) && matchReportCat(r,"labor")),
    rows(){ return this.records().map(r=>{
      const rep = r.report || {};
      const reported = r.status==="已回報" && r.report;
      return [
        r.date, r.vendor, fmt(r.required),
        (r.categories||[]).join("、")+(r.categoryNote?"・"+r.categoryNote:""),
        (r.locations||[]).join("、"), r.applicant, r.status,
        rep.checkFace?"V":"", rep.checkCard?"V":"", rep.checkToolbox?"V":"",
        rep.signReturnDate||"", reported?fmt(rep.actual):"", reported?fmt(rep.diff):"",
        rep.zeroWork?"V":"",
        rep.engineer||"",
        reported ? (rep.ot2Total != null ? fmt(rep.ot2Total) : "") : "",
        reported ? (rep.otOverTotal != null ? fmt(rep.otOverTotal) : "") : "",
        reported ? fmt(rep.totalOT) : "",
        laborDetail(rep)
      ].concat(doneCols(rep), [rep.conclusion||""]);
    }); }
  },
  equipment: {
    title:"機具紀錄",
    headers:["出工日期","機具廠商","機具類型","型號","工作內容","工作地點","責任廠商","預計使用時數(需求數量)","申請人","狀態","簽單繳回日","機具實際工作使用時數","差異","0使用確認","機具使用明細","簽單責任工程師","根基自辦工數","根基自辦時數","根基自辦備註","廠商代辦工數","廠商代辦時數","廠商代辦備註"],
    records: ()=>cur().equipment.filter(x=>inReportRange(x.date) && matchReportVendor(x) && matchReportCat(x,"equipment")),
    rows(){ return this.records().map(x=>{
      const rep = x.report || {};
      const reported = x.status==="已回報" && x.report;
      const usageDetail = (rep.usage||[]).filter(u=>u.present)
        .map(u=>`${u.type}(${fmt(u.hours)}h)`).join("、");
      return [
        x.date, x.vendor, (x.types||[]).join("、"), x.model, x.content,
        (x.locations||[]).join("、"), x.vendor, fmt(x.requiredQty), x.applicant, x.status,
        rep.signReturnDate||"", reported?fmt(rep.actualHours):"", reported?fmt(rep.diff):"",
        rep.zeroUse?"V":"", usageDetail,
        rep.checker||""
      ].concat(doneCols(rep));
    }); }
  }
};

/* ==========================================================
   計價彙總：依廠商分組（僅統計已回報單），供承辦快速對計價
   ========================================================== */
function buildPricingSummary(kind){
  const recs = REPORT_DEFS[kind].records().filter(r=>r.status==="已回報" && r.report);
  const groups = {};
  recs.forEach(r=>{
    const key = r.vendor || "（未填廠商）";
    const g = groups[key] || (groups[key] = {vendor:key, count:0, zero:0, work:0, ot2:0, otOver:0, hours:0, selfW:0, selfH:0, vendW:0, vendH:0, cats:new Set()});
    const rep = r.report;
    g.count++;
    if(kind === "labor"){
      if(rep.zeroWork) g.zero++;
      g.work += rep.actual || 0;
      // 分段加班；舊單只有 totalOT 時計入前 2 小時段
      g.ot2 += rep.ot2Total != null ? rep.ot2Total : (rep.totalOT || 0);
      g.otOver += rep.otOverTotal || 0;
      (r.categories||[]).forEach(c=>g.cats.add(c));
    }else{
      if(rep.zeroUse) g.zero++;
      g.hours += rep.actualHours || 0;
      (r.types||[]).forEach(t=>g.cats.add(t));
    }
    g.selfW += rep.selfDoneWork || 0;
    g.selfH += rep.selfDoneHours || 0;
    g.vendW += rep.vendorDoneWork || 0;
    g.vendH += rep.vendorDoneHours || 0;
  });
  return Object.values(groups).sort((a,b)=>a.vendor.localeCompare(b.vendor,"zh-Hant"));
}

/* 彙總的期間標示（計價 CSV 需帶日期範圍） */
function reportPeriodLabel(){
  return (reportFrom || reportTo) ? `${reportFrom||"起"}~${reportTo||"今"}` : "全部期間";
}

function pricingSummaryTable(kind){
  const gs = buildPricingSummary(kind);
  const period = reportPeriodLabel();
  if(kind === "labor"){
    return {
      headers:["期間","廠商","已回報單數","0工單數","總出工數","加班時數(前2小時)","加班時數(第3小時起)","根基自辦工數","根基自辦時數","廠商代辦工數","廠商代辦時數","工作內容"],
      rows: gs.map(g=>[period, g.vendor, g.count, g.zero, fmt(g.work), fmt(g.ot2), fmt(g.otOver), fmt(g.selfW), fmt(g.selfH), fmt(g.vendW), fmt(g.vendH), [...g.cats].join("、")])
    };
  }
  return {
    headers:["期間","機具廠商","已回報單數","0使用單數","總實際使用時數","根基自辦工數","根基自辦時數","廠商代辦工數","廠商代辦時數","機具類型"],
    rows: gs.map(g=>[period, g.vendor, g.count, g.zero, fmt(g.hours), fmt(g.selfW), fmt(g.selfH), fmt(g.vendW), fmt(g.vendH), [...g.cats].join("、")])
  };
}

function initReportTabs(){
  document.querySelectorAll(".rtab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".rtab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      currentReport = btn.dataset.r;
      reportCat = "";           // 點工/機具的內容池不同，切換頁籤時重置內容篩選
      document.getElementById("reportCat").value = "";
      renderReport(currentReport);
    });
  });
  document.getElementById("exportBtn").addEventListener("click", ()=>exportCSV(currentReport));
  document.getElementById("exportSummaryBtn").addEventListener("click", ()=>exportSummaryCSV(currentReport));
  document.getElementById("reportVendor").addEventListener("change", e=>{
    reportVendor = e.target.value;
    renderReport(currentReport);
  });
  document.getElementById("reportCat").addEventListener("change", e=>{
    reportCat = e.target.value;
    renderReport(currentReport);
  });

  const fromEl = document.getElementById("reportFrom");
  const toEl = document.getElementById("reportTo");
  const syncRange = ()=>{
    reportFrom = fromEl.value || "";
    reportTo = toEl.value || "";
    renderReport(currentReport);
  };
  fromEl.addEventListener("change", syncRange);
  toEl.addEventListener("change", syncRange);
  document.getElementById("rangeThisMonth").addEventListener("click", ()=>{
    [fromEl.value, toEl.value] = monthRange(0); syncRange();
  });
  document.getElementById("rangeLastMonth").addEventListener("click", ()=>{
    [fromEl.value, toEl.value] = monthRange(-1); syncRange();
  });
  document.getElementById("rangeAll").addEventListener("click", ()=>{
    fromEl.value = ""; toEl.value = ""; syncRange();
  });
}

/* 篩選下拉選項：由目前工地該類紀錄的實際值彙集（含期間外，方便先選條件再選期間） */
function populateReportFilters(key){
  const vendSel = document.getElementById("reportVendor");
  const catSel = document.getElementById("reportCat");
  const recs = key==="labor" ? cur().labor : cur().equipment;
  const vendors = [...new Set(recs.map(r=>r.vendor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const cats = [...new Set(recs.flatMap(r=>(key==="labor" ? r.categories : r.types) || []))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const vendLabel = key==="labor" ? "全部廠商" : "全部機具廠商";
  const catLabel = key==="labor" ? "全部工作內容" : "全部機具類型";
  vendSel.innerHTML = `<option value="">${esc(vendLabel)}</option>` + vendors.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  catSel.innerHTML = `<option value="">${esc(catLabel)}</option>` + cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if(vendors.includes(reportVendor)) vendSel.value = reportVendor; else { reportVendor = ""; vendSel.value = ""; }
  if(cats.includes(reportCat)) catSel.value = reportCat; else { reportCat = ""; catSel.value = ""; }
}

function renderReport(key){
  if(!READY) return;
  populateReportFilters(key);
  const def = REPORT_DEFS[key];
  const rows = def.rows();
  const cnt = document.getElementById("reportCount");
  const filterTags = [
    (reportFrom||reportTo) ? `${reportFrom||"起"} ~ ${reportTo||"今"}` : "",
    reportVendor, reportCat
  ].filter(Boolean).join("・");
  if(cnt) cnt.textContent = `共 ${rows.length} 筆` + (filterTags ? `（${filterTags}）` : "");
  const el = document.getElementById("reportTable");
  if(!rows.length){ el.innerHTML = '<div class="empty-row">此條件內尚無「'+esc(def.title)+'」資料</div>'; }
  else{
    el.innerHTML = `<table><thead><tr>${def.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c===undefined||c===null?"":c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  renderPricingSummary(key);
}

function renderPricingSummary(key){
  const el = document.getElementById("reportSummary");
  if(!el) return;
  const sum = pricingSummaryTable(key);
  if(!sum.rows.length){
    el.innerHTML = '<div class="summary-title">計價彙總（依廠商，僅統計已回報單）</div><div class="empty-row">此條件內尚無已回報資料可彙總</div>';
    return;
  }
  el.innerHTML = `<div class="summary-title">計價彙總（依廠商，僅統計已回報單）</div>
    <div class="table-wrap"><table><thead><tr>${sum.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${sum.rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c===undefined||c===null?"":c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function downloadCSV(headers, rows, filename){
  const cell = c=>{
    let v = (c===undefined||c===null?"":String(c));
    // 防 CSV 公式注入：非純數字卻以 = + - @ 開頭的儲存格，前置 ' 讓 Excel 視為文字
    if(/^[=+\-@]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
    v = v.replace(/"/g,'""');
    return /[,\n"]/.test(v) ? `"${v}"` : v;
  };
  const csvLines = [headers.join(",")].concat(
    rows.map(r=>r.map(cell).join(","))
  );
  const csv = "﻿" + csvLines.join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV 已匯出");
}

function exportFilterTag(){
  const parts = [];
  if(reportFrom || reportTo) parts.push(`${reportFrom||"起"}至${reportTo||"今"}`);
  if(reportVendor) parts.push(reportVendor);
  if(reportCat) parts.push(reportCat);
  return parts.length ? "_" + parts.join("_") : "";
}

function exportCSV(key){
  const def = REPORT_DEFS[key];
  const rows = def.rows();
  if(!rows.length){ toast("目前沒有可匯出的資料"); return; }
  downloadCSV(def.headers, rows, `${MASTER.currentSite}_${def.title}${exportFilterTag()}_${localDate()}.csv`);
}

function exportSummaryCSV(key){
  const def = REPORT_DEFS[key];
  const sum = pricingSummaryTable(key);
  if(!sum.rows.length){ toast("此條件內尚無已回報資料可彙總"); return; }
  downloadCSV(sum.headers, sum.rows, `${MASTER.currentSite}_${def.title}計價彙總${exportFilterTag()}_${localDate()}.csv`);
}

/* ==========================================================
   成控現場稽核（v13；限管理員）
   - 連動申請父層：日期＋廠商 → 申請單 → 逐項相符/不相符查核
   - 每項必選；不相符必填原因；申請工數 vs 現場實點自動算差異
   - 查核項目文字可由 config.local.js 的 auditItems 覆蓋
     （格式：auditItems: { labor:[...], equipment:[...] }）
   - 稽核紀錄存於單據 audits[] 陣列（一單可多次稽核）；
     沿用 op:record 與版本檢查，後端零修改
   ========================================================== */
const AUDIT_ITEMS = {
  labor: (LOCAL.auditItems && LOCAL.auditItems.labor) || [
    "現場點名人數與申請工數相符",
    "人臉辨識紀錄相符",
    "白卡進出紀錄相符",
    "施作工項與申請內容相符",
    "施作地點與申請相符",
    "無同廠商重複計價疑慮",
    "簽單與出工紀錄核對相符"
  ],
  equipment: (LOCAL.auditItems && LOCAL.auditItems.equipment) || [
    "現場機具數量與申請台數相符",
    "機具類型與申請相符",
    "實際使用狀態正常（非閒置）",
    "使用地點與申請相符",
    "簽單與使用紀錄核對相符"
  ]
};

let auditKind = "labor";
let auditDate = localDate();   // 預設今天；使用者清空後不再被 renderAuditView 強制蓋回（v13 修復）
let auditVendor = "";
let auditSelectedId = null;
let auditItemState = [];
let editingAuditId = null;   // 非 null＝編輯既有稽核紀錄（更新取代，不新增）
let auditLogFrom = "", auditLogTo = "";

function auditFindRec(kind, id){
  const store = cur();
  return (kind==="labor" ? store.labor : store.equipment).find(r=>r.id===id);
}
function auditApplied(kind, rec){ return kind==="labor" ? (rec.required||0) : (rec.requiredQty||0); }
function auditAppliedLabel(){ return auditKind==="labor" ? "申請工數" : "申請台數"; }
function auditCountLabel(){ return auditKind==="labor" ? "現場實點人數" : "現場實點台數"; }
function auditRecCats(kind, rec){
  return (kind==="labor" ? (rec.categories||[]) : (rec.types||[])).join("、");
}

function resetAuditView(){
  auditSelectedId = null;
  auditItemState = [];
  editingAuditId = null;
  const wrap = document.getElementById("auditFormWrap");
  if(wrap) wrap.innerHTML = '<div class="empty-row">請先從上方選擇要稽核的申請單</div>';
}

function renderAuditView(){
  if(!READY || !isAdmin()) return;
  const siteSel = document.getElementById("auditSite");
  siteSel.innerHTML = MASTER.sites.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join("");
  siteSel.value = MASTER.currentSite;
  document.querySelectorAll("#auditKindSwitch .akind").forEach(b=>b.classList.toggle("active", b.dataset.akind===auditKind));
  document.getElementById("auditDate").value = auditDate;

  const store = cur();
  const list = auditKind==="labor" ? store.labor : store.equipment;
  const vendors = [...new Set(list.filter(r=>!auditDate || r.date===auditDate).map(r=>r.vendor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const vSel = document.getElementById("auditVendor");
  vSel.innerHTML = `<option value="">全部廠商</option>` + vendors.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if(vendors.includes(auditVendor)) vSel.value = auditVendor; else { auditVendor=""; vSel.value=""; }

  renderAuditRecList();
  renderAuditLog();
}

function renderAuditRecList(){
  const el = document.getElementById("auditRecList");
  const store = cur();
  const list = auditKind==="labor" ? store.labor : store.equipment;
  const recs = list.filter(r=>(!auditDate || r.date===auditDate) && (!auditVendor || r.vendor===auditVendor));
  if(!recs.length){
    el.innerHTML = '<div class="empty-row">此條件內沒有' + (auditKind==="labor"?"點工":"機具") + '申請單，請調整日期／廠商</div>';
    resetAuditView();
    return;
  }
  el.innerHTML = recs.map(r=>{
    const audited = (r.audits||[]).length;
    return `<button type="button" class="audit-pick ${r.id===auditSelectedId?"active":""}" data-id="${esc(r.id)}">
      <span class="ap-line1">${esc(r.date)}｜${esc(r.vendor||"（未填廠商）")}｜${auditAppliedLabel()} ${fmt(auditApplied(auditKind, r))}</span>
      <span class="ap-line2">${esc(auditRecCats(auditKind, r)||"—")}｜${esc((r.locations||[]).join("、")||"—")}｜${esc(r.status)}${audited?`｜已稽核 ${audited} 次`:""}</span>
    </button>`;
  }).join("");
}

// 稽核選單/編輯的 refetch 請求序號：避免較慢的回應在較快的回應之後覆寫畫面（v13 修復）
let auditFetchSeq = 0;

async function pickAuditRecord(id){
  const seq = ++auditFetchSeq;
  let refetchFailed = false;
  try{ await refetchSite(MASTER.currentSite); }catch(e){ refetchFailed = true; }
  if(seq !== auditFetchSeq) return;   // 已有更新的選取動作，捨棄這次較慢的回應
  if(refetchFailed) toast("⚠ 無法載入最新資料，請檢查網路後再試");
  const rec = auditFindRec(auditKind, id);
  if(!rec){ toast("找不到該單據，可能已被刪除"); renderAuditView(); return; }
  auditSelectedId = id;
  editingAuditId = null;
  auditItemState = AUDIT_ITEMS[auditKind].map(t=>({text:t, ok:null, reason:""}));
  renderAuditRecList();
  renderAuditForm(rec);
}

/* 編輯既有稽核紀錄：載入原內容進表單，儲存時原地更新（保留原稽核日期，另記編輯日） */
async function editAudit(kind, rid, aid){
  const seq = ++auditFetchSeq;
  let refetchFailed = false;
  try{ await refetchSite(MASTER.currentSite); }catch(e){ refetchFailed = true; }
  if(seq !== auditFetchSeq) return;   // 已有更新的選取動作，捨棄這次較慢的回應
  if(refetchFailed) toast("⚠ 無法載入最新資料，請檢查網路後再試");
  const rec = auditFindRec(kind, rid);
  const a = rec && (rec.audits||[]).find(x=>x.id===aid);
  if(!a){ toast("找不到該筆稽核紀錄，可能已被刪除"); renderAuditView(); return; }
  auditKind = kind;
  auditDate = rec.date;
  auditVendor = "";
  auditSelectedId = rid;
  editingAuditId = aid;
  auditItemState = (a.items||[]).map(it=>({text:it.text, ok: typeof it.ok === "boolean" ? it.ok : null, reason:it.reason||""}));
  renderAuditView();
  renderAuditForm(rec, a);
  document.getElementById("auditFormWrap").scrollIntoView({behavior:"smooth", block:"start"});
}

function renderAuditForm(rec, editA){
  const wrap = document.getElementById("auditFormWrap");
  // 編輯模式沿用原稽核當下的申請數快照（基準不因申請單事後修改而漂移）
  const applied = editA ? (editA.applied||0) : auditApplied(auditKind, rec);
  wrap.innerHTML = `
    <div class="audit-ctx${editA?" editing":""}">
      <div class="ac-line1">${editA?`✎ 編輯稽核紀錄（原稽核日期：${esc(editA.auditedAt)}）｜`:""}${esc(rec.date)}｜${esc(rec.vendor||"（未填廠商）")}｜${esc(rec.status)}</div>
      <div class="ac-line2">${esc(auditRecCats(auditKind, rec)||"—")}｜${esc((rec.locations||[]).join("、")||"—")}｜申請人：${esc(rec.applicant||"—")}</div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>${auditAppliedLabel()}（依申請單）</label>
        <input type="text" readonly class="readonly-field" value="${fmt(applied)}">
      </div>
      <div class="field">
        <label>${auditCountLabel()}（現場清點）</label>
        <input type="number" id="auditCount" min="0" step="0.5" value="${editA?fmt(editA.actualCount):""}">
      </div>
      <div class="field">
        <label>差異（自動計算）</label>
        <input type="text" id="auditCountDiff" readonly class="readonly-field" value="${editA?fmt((editA.actualCount||0)-applied):""}">
      </div>
      <div class="field">
        <label>稽核人</label>
        <input type="text" id="auditAuditor" placeholder="例：成控－某某某" value="${esc(editA?(editA.auditor||""):(sessionStorage.getItem("dm_auditor")||""))}">
      </div>
      <div class="field field-wide">
        <label>快速查核（每項必選「相符／不相符」；不相符需填寫原因）</label>
        <div id="auditItems"></div>
      </div>
      <div class="field field-wide">
        <label>現場狀況說明（選填，不限字數）</label>
        <textarea id="auditNote" rows="3" placeholder="例：現場清點與申請相符；其中 2 工無白卡紀錄，已提醒工地落實刷卡">${esc(editA?(editA.note||""):"")}</textarea>
      </div>
      <div class="field field-wide actions">
        <button type="button" class="btn-primary" id="auditSaveBtn">${editA?"更新稽核紀錄":"儲存稽核紀錄"}</button>
        <button type="button" class="btn-ghost" id="auditCancelBtn">取消</button>
      </div>
    </div>`;
  renderAuditItems();
  document.getElementById("auditCount").addEventListener("input", ()=>{
    const v = parseFloat(document.getElementById("auditCount").value);
    document.getElementById("auditCountDiff").value = isNaN(v) ? "" : fmt(v - applied);
  });
  document.getElementById("auditSaveBtn").addEventListener("click", ()=>saveAudit(rec.id));
  document.getElementById("auditCancelBtn").addEventListener("click", ()=>{ resetAuditView(); renderAuditRecList(); });
}

function renderAuditItems(){
  const box = document.getElementById("auditItems");
  if(!box) return;
  box.innerHTML = auditItemState.map((it,i)=>`
    <div class="audit-item ${it.ok===false?"bad":""}">
      <div class="ai-row">
        <span class="ai-text">${esc(it.text)}</span>
        <span class="ai-btns">
          <button type="button" class="ai-btn ok ${it.ok===true?"active":""}" data-i="${i}" data-val="1">相符</button>
          <button type="button" class="ai-btn bad ${it.ok===false?"active":""}" data-i="${i}" data-val="0">不相符</button>
        </span>
      </div>
      ${it.ok===false?`<input type="text" class="ai-reason" data-i="${i}" placeholder="請填寫不符原因（必填），例：2 工無白卡進出紀錄" value="${esc(it.reason)}">`:""}
    </div>`).join("");
}

async function saveAudit(id){
  const rec = auditFindRec(auditKind, id);
  if(!rec){ toast("找不到該單據，請重新選擇"); return; }
  const auditor = document.getElementById("auditAuditor").value.trim();
  if(!auditor){ toast("請填寫稽核人"); return; }
  const cntRaw = document.getElementById("auditCount").value.trim();
  if(cntRaw === ""){ toast("請填寫" + auditCountLabel()); return; }
  const actualCount = parseFloat(cntRaw) || 0;
  if(actualCount < 0){ toast(auditCountLabel() + "不可為負數"); return; }
  for(const it of auditItemState){
    if(it.ok === null){ toast(`「${it.text}」尚未選擇相符／不相符`); return; }
    if(it.ok === false && !it.reason.trim()){ toast(`「${it.text}」為不相符，請填寫不符原因`); return; }
  }
  const orig = editingAuditId ? (rec.audits||[]).find(x=>x.id===editingAuditId) : null;
  if(editingAuditId && !orig){ toast("原稽核紀錄不存在，可能已被刪除"); resetAuditView(); renderAuditView(); return; }
  // 編輯：保留原 id/稽核日期/申請數快照，另記編輯日；新增：全新快照
  const applied = orig ? (orig.applied||0) : auditApplied(auditKind, rec);
  const audit = {
    id: orig ? orig.id : uid(),
    auditedAt: orig ? orig.auditedAt : localDate(),
    auditor,
    applied,
    actualCount,
    diff: actualCount - applied,
    items: auditItemState.map(it=>({ text: it.text, ok: !!it.ok, reason: it.ok===false ? it.reason.trim() : "" })),
    note: document.getElementById("auditNote").value.trim(),
    statusAtAudit: orig ? orig.statusAtAudit : rec.status
  };
  if(orig) audit.editedAt = localDate();
  const updated = Object.assign({}, rec, {
    audits: orig ? rec.audits.map(x=>x.id===audit.id ? audit : x)
                 : (rec.audits||[]).concat([audit])
  });
  try{
    const resp = await apiSaveRecord(auditKind, updated, rec.v || 0);
    updated.v = resp.v; updated.updatedAt = resp.updatedAt;
  }catch(err){
    if(err.status === 409){
      toast("⚠ 此單剛被其他人修改，稽核未儲存；已重新載入最新內容，請重新填寫");
      await refetchSite(MASTER.currentSite).catch(()=>{});
      resetAuditView();
      renderAuditView();
      return;
    }
    toast("⚠ 雲端儲存失敗，稽核未送出，請檢查網路後再按一次儲存");
    return;
  }
  const store = cur();
  const list = auditKind==="labor" ? store.labor : store.equipment;
  const idx = list.findIndex(r=>r.id===id);
  if(idx >= 0) list[idx] = updated;
  sessionStorage.setItem("dm_auditor", auditor);
  toast(orig ? "稽核紀錄已更新" : "稽核紀錄已儲存至共用資料庫");
  resetAuditView();
  renderAuditView();
}

/* ---- 稽核紀錄清單／匯出 ---- */
function auditLogEntries(){
  const store = cur();
  const out = [];
  [["labor", store.labor], ["equipment", store.equipment]].forEach(([kind, list])=>{
    list.forEach(rec=>{
      (rec.audits||[]).forEach(a=>{
        if(auditLogFrom && a.auditedAt < auditLogFrom) return;
        if(auditLogTo && a.auditedAt > auditLogTo) return;
        out.push({kind, rec, a});
      });
    });
  });
  out.sort((x,y)=>String(y.a.auditedAt + y.a.id).localeCompare(String(x.a.auditedAt + x.a.id)));
  return out;
}

function renderAuditLog(){
  const el = document.getElementById("auditLogList");
  const entries = auditLogEntries();
  if(!entries.length){ el.innerHTML = '<div class="empty-row">此條件內尚無稽核紀錄</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>稽核日期</th><th>類型</th><th>出工日期</th><th>廠商</th><th>申請</th><th>實點</th><th>差異</th><th>查核結果</th><th>稽核人</th><th>操作</th></tr></thead><tbody>` +
    entries.map(e=>{
      const bad = e.a.items.filter(i=>!i.ok).length;
      const resTag = bad ? `<span class="tag warn">${bad} 項不符</span>` : `<span class="tag ok">全數相符</span>`;
      const ids = `data-kind="${e.kind}" data-rid="${esc(e.rec.id)}" data-aid="${esc(e.a.id)}"`;
      return `<tr>
        <td>${esc(e.a.auditedAt)}${e.a.editedAt?`<span class="edited-mark" title="編輯於 ${esc(e.a.editedAt)}">（已編輯）</span>`:""}</td>
        <td>${e.kind==="labor"?"點工":"機具"}</td>
        <td>${esc(e.rec.date)}</td>
        <td>${esc(e.rec.vendor||"")}</td>
        <td>${fmt(e.a.applied)}</td>
        <td>${fmt(e.a.actualCount)}</td>
        <td>${fmt(e.a.diff)}</td>
        <td>${resTag}</td>
        <td>${esc(e.a.auditor)}</td>
        <td>
          <button type="button" class="btn-mini btn-edit audit-edit" ${ids}>編輯</button>
          <button type="button" class="btn-mini btn-edit audit-one-pdf" ${ids}>PDF</button>
          <button type="button" class="btn-mini btn-del audit-del" ${ids}>刪除</button>
        </td>
      </tr>`;
    }).join("") + "</tbody></table>";
}

async function deleteAudit(kind, rid, aid){
  const rec = auditFindRec(kind, rid);
  if(!rec){ toast("找不到該單據，可能已被刪除；請重新整理後再試"); return; }
  const a = (rec.audits||[]).find(x=>x.id===aid);
  if(!a){ toast("找不到該筆稽核紀錄，可能已被刪除；請重新整理後再試"); return; }
  if(!confirm(`確定刪除這筆稽核紀錄嗎？（${a.auditedAt}／${rec.vendor||""}）\n此操作影響所有使用者且無法復原。`)) return;
  if(editingAuditId === aid) resetAuditView();   // 正被編輯的紀錄同時被刪除：關閉殘影表單（v13 修復）
  const updated = Object.assign({}, rec, { audits: rec.audits.filter(x=>x.id!==aid) });
  try{
    const resp = await apiSaveRecord(kind, updated, rec.v || 0);
    updated.v = resp.v; updated.updatedAt = resp.updatedAt;
  }catch(err){
    if(err.status === 409){
      toast("⚠ 此單剛被其他人修改，刪除未執行；已重新載入");
      await refetchSite(MASTER.currentSite).catch(()=>{});
      renderAuditView();
      return;
    }
    toast("⚠ 雲端儲存失敗，刪除未執行");
    return;
  }
  const store = cur();
  const list = kind==="labor" ? store.labor : store.equipment;
  const idx = list.findIndex(r=>r.id===rid);
  if(idx >= 0) list[idx] = updated;
  toast("稽核紀錄已刪除");
  renderAuditLog();
  renderAuditRecList();
}

/* ---- PDF 報告（開列印視圖 → 瀏覽器另存 PDF；零套件） ---- */
function auditPeriodLabel(){
  return (auditLogFrom || auditLogTo) ? `${auditLogFrom||"起"}~${auditLogTo||"今"}` : "全部期間";
}

function auditReportHTML(entries, subtitle){
  const secs = entries.map((e,n)=>{
    const bad = e.a.items.filter(i=>!i.ok).length;
    return `<div class="sec">
      <h3>${n+1}. ${esc(e.rec.date)}｜${e.kind==="labor"?"點工":"機具"}｜${esc(e.rec.vendor||"（未填廠商）")} — ${bad?`<span class="r-bad">${bad} 項不符</span>`:`<span class="r-ok">全數相符</span>`}</h3>
      <table class="info">
        <tr><th>工作內容</th><td>${esc(auditRecCats(e.kind, e.rec)||"—")}</td><th>工作地點</th><td>${esc((e.rec.locations||[]).join("、")||"—")}</td></tr>
        <tr><th>${e.kind==="labor"?"申請工數":"申請台數"}</th><td>${fmt(e.a.applied)}</td><th>現場實點</th><td>${fmt(e.a.actualCount)}（差異 ${fmt(e.a.diff)}）</td></tr>
        <tr><th>申請人</th><td>${esc(e.rec.applicant||"—")}</td><th>稽核時單據狀態</th><td>${esc(e.a.statusAtAudit||"—")}</td></tr>
      </table>
      <table class="items">
        <thead><tr><th>查核項目</th><th class="w1">結果</th><th>不符原因</th></tr></thead>
        <tbody>${e.a.items.map(i=>`<tr><td>${esc(i.text)}</td><td class="${i.ok?"r-ok":"r-bad"}">${i.ok?"相符":"不相符"}</td><td>${esc(i.reason||"")}</td></tr>`).join("")}</tbody>
      </table>
      ${e.a.note?`<p class="note"><strong>現場狀況說明：</strong>${esc(e.a.note)}</p>`:""}
      <p class="meta">稽核日期：${esc(e.a.auditedAt)}｜稽核人員：${esc(e.a.auditor)}${e.a.editedAt?`｜編輯於：${esc(e.a.editedAt)}`:""}</p>
    </div>`;
  }).join("");

  const sumRows = entries.map((e,n)=>{
    const bad = e.a.items.filter(i=>!i.ok).length;
    return `<tr><td>${n+1}</td><td>${esc(e.a.auditedAt)}</td><td>${e.kind==="labor"?"點工":"機具"}</td><td>${esc(e.rec.date)}</td><td>${esc(e.rec.vendor||"")}</td><td>${fmt(e.a.applied)}</td><td>${fmt(e.a.actualCount)}</td><td>${fmt(e.a.diff)}</td><td class="${bad?"r-bad":"r-ok"}">${bad?bad+" 項不符":"全數相符"}</td><td>${esc(e.a.auditor)}</td></tr>`;
  }).join("");

  const auditors = [...new Set(entries.map(e=>e.a.auditor).filter(Boolean))];

  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>成控現場稽核報告</title>
  <style>
    body{font-family:"Microsoft JhengHei","PingFang TC",sans-serif;color:#1c2b2a;margin:32px;font-size:13px;}
    h1{font-size:20px;margin:0 0 4px;} .sub{color:#5f6f6e;margin:0 0 20px;}
    h2{font-size:15px;border-left:4px solid #0f6e56;padding-left:8px;margin:24px 0 8px;}
    h3{font-size:14px;margin:20px 0 6px;}
    table{border-collapse:collapse;width:100%;margin:4px 0 8px;}
    th,td{border:1px solid #c8d4d2;padding:4px 8px;text-align:left;vertical-align:top;}
    thead th{background:#eef4f3;}
    .info th{background:#eef4f3;width:110px;white-space:nowrap;}
    .w1{width:64px;white-space:nowrap;}
    .r-ok{color:#1c7d43;font-weight:bold;} .r-bad{color:#b93226;font-weight:bold;}
    .note{margin:4px 0;} .meta{color:#5f6f6e;margin:2px 0 0;}
    .sec{page-break-inside:avoid;}
    .signs{display:flex;gap:40px;flex-wrap:wrap;margin-top:36px;page-break-inside:avoid;font-size:13px;}
    .toolbar{margin:0 0 16px;}
    .toolbar button{font-size:14px;padding:6px 16px;cursor:pointer;}
    @media print{.toolbar{display:none;} body{margin:12mm;}}
  </style></head><body>
  <div class="toolbar"><button onclick="window.print()">🖨 列印 / 另存 PDF</button>（於列印對話框選「另存為 PDF」）</div>
  <h1>成控現場稽核報告</h1>
  <p class="sub">工地：${esc(MASTER.currentSite)}｜${esc(subtitle)}｜共 ${entries.length} 筆稽核紀錄｜稽核人員：${esc(auditors.join("、")||"—")}｜產出日期：${esc(localDate())}</p>
  <h2>稽核彙總</h2>
  <table><thead><tr><th>#</th><th>稽核日期</th><th>類型</th><th>出工日期</th><th>廠商</th><th>申請</th><th>實點</th><th>差異</th><th>查核結果</th><th>稽核人員</th></tr></thead><tbody>${sumRows}</tbody></table>
  <h2>逐筆查核明細</h2>
  ${secs}
  <div class="signs">
    <div>稽核人員簽章：＿＿＿＿＿＿＿＿＿＿</div>
    <div>覆核主管簽章：＿＿＿＿＿＿＿＿＿＿</div>
    <div>日期：＿＿＿＿＿＿＿＿＿＿</div>
  </div>
  </body></html>`;
}

function openAuditPDF(entries, subtitle){
  if(!entries.length){ toast("此條件內沒有稽核紀錄可匯出"); return; }
  const w = window.open("", "_blank");
  if(!w){ toast("瀏覽器攔截了報告視窗，請允許彈出視窗後再試"); return; }
  w.document.write(auditReportHTML(entries, subtitle));
  w.document.close();
}

function exportAuditCSV(){
  const entries = auditLogEntries();
  if(!entries.length){ toast("此條件內沒有稽核紀錄可匯出"); return; }
  const headers = ["稽核日期","編輯日期","類型","工地","出工日期","廠商","工作內容","工作地點","申請","現場實點","差異","不符項數","不符項目與原因","現場狀況說明","稽核人","稽核時單據狀態"];
  const rows = entries.map(e=>{
    const badItems = e.a.items.filter(i=>!i.ok);
    return [
      e.a.auditedAt, e.a.editedAt||"", e.kind==="labor"?"點工":"機具", MASTER.currentSite,
      e.rec.date, e.rec.vendor||"", auditRecCats(e.kind, e.rec),
      (e.rec.locations||[]).join("、"),
      fmt(e.a.applied), fmt(e.a.actualCount), fmt(e.a.diff),
      badItems.length,
      badItems.map(i=>`${i.text}：${i.reason}`).join("；"),
      e.a.note||"", e.a.auditor, e.a.statusAtAudit||""
    ];
  });
  downloadCSV(headers, rows, `${MASTER.currentSite}_成控稽核紀錄_${auditPeriodLabel()}_${localDate()}.csv`);
}

function initAudit(){
  document.getElementById("auditSite").addEventListener("change", e=>{
    switchSiteContext(e.target.value);
    switchMainTab("audit");
    renderAuditView();
  });
  document.querySelectorAll("#auditKindSwitch .akind").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      auditKind = btn.dataset.akind;
      auditVendor = "";
      resetAuditView();
      renderAuditView();
    });
  });
  document.getElementById("auditDate").addEventListener("change", e=>{
    auditDate = e.target.value;
    resetAuditView();
    renderAuditView();
  });
  document.getElementById("auditVendor").addEventListener("change", e=>{
    auditVendor = e.target.value;
    resetAuditView();
    renderAuditRecList();
  });
  document.getElementById("auditRecList").addEventListener("click", e=>{
    const btn = e.target.closest(".audit-pick");
    if(btn) pickAuditRecord(btn.dataset.id);
  });
  document.getElementById("auditFormWrap").addEventListener("click", e=>{
    const btn = e.target.closest(".ai-btn");
    if(!btn) return;
    const i = parseInt(btn.dataset.i, 10);
    if(!auditItemState[i]) return;
    auditItemState[i].ok = btn.dataset.val === "1";
    renderAuditItems();
  });
  document.getElementById("auditFormWrap").addEventListener("input", e=>{
    if(!e.target.classList.contains("ai-reason")) return;
    const i = parseInt(e.target.dataset.i, 10);
    if(auditItemState[i]) auditItemState[i].reason = e.target.value;
  });
  document.getElementById("auditLogList").addEventListener("click", e=>{
    const ed = e.target.closest(".audit-edit");
    if(ed){ editAudit(ed.dataset.kind, ed.dataset.rid, ed.dataset.aid); return; }
    const pdf = e.target.closest(".audit-one-pdf");
    if(pdf){
      const rec = auditFindRec(pdf.dataset.kind, pdf.dataset.rid);
      const a = rec && (rec.audits||[]).find(x=>x.id===pdf.dataset.aid);
      if(a) openAuditPDF([{kind: pdf.dataset.kind, rec, a}], `單筆稽核（${a.auditedAt}）`);
      else toast("找不到該筆稽核紀錄，可能已被刪除；請重新整理後再試");
      return;
    }
    const del = e.target.closest(".audit-del");
    if(del) deleteAudit(del.dataset.kind, del.dataset.rid, del.dataset.aid);
  });
  const logSync = ()=>{
    auditLogFrom = document.getElementById("auditLogFrom").value || "";
    auditLogTo = document.getElementById("auditLogTo").value || "";
    renderAuditLog();
  };
  document.getElementById("auditLogFrom").addEventListener("change", logSync);
  document.getElementById("auditLogTo").addEventListener("change", logSync);
  document.getElementById("auditPdfBtn").addEventListener("click", ()=>openAuditPDF(auditLogEntries(), `稽核期間：${auditPeriodLabel()}`));
  document.getElementById("auditCsvBtn").addEventListener("click", exportAuditCSV);
}

/* ==========================================================
   管理員模式（前端層級防誤觸；密碼來自 config.local.js 的 adminPin）
   ========================================================== */
const ADMIN_PIN = (LOCAL.adminPin != null) ? String(LOCAL.adminPin) : "0000";

function isAdmin(){ return sessionStorage.getItem("dm_admin") === "1"; }

function initAdmin(){
  document.getElementById("adminToggleBtn").addEventListener("click", ()=>{
    if(isAdmin()){
      sessionStorage.removeItem("dm_admin");
      toast("已登出管理員模式");
    }else{
      const pin = prompt("請輸入管理員密碼：");
      if(pin === null) return;
      if(String(pin) === ADMIN_PIN){
        sessionStorage.setItem("dm_admin", "1");
        toast("已進入管理員模式");
      }else{
        toast("密碼錯誤");
      }
    }
    applyAdminUI();
  });
}

function applyAdminUI(){
  const admin = isAdmin();
  const status = document.getElementById("adminStatus");
  status.textContent = admin ? "管理員" : "一般使用者";
  status.className = admin ? "tag ok" : "tag warn";
  document.getElementById("adminToggleBtn").textContent = admin ? "登出管理員" : "管理員登入";

  document.getElementById("cfg_sites").readOnly = !admin;
  Object.keys(SITE_CFG_MAP).forEach(id=>{
    document.getElementById(id).readOnly = !admin;
  });
  document.getElementById("cfg_lockDate").disabled = !admin;
  document.getElementById("saveSettings").style.display = admin ? "" : "none";
  document.getElementById("resetSettings").style.display = admin ? "" : "none";
  document.getElementById("dangerZone").style.display = admin ? "" : "none";

  // v13：成控現場稽核頁籤——非管理員完全隱藏；登出時若正在稽核頁則跳回總覽，
  // 並重置稽核選取狀態（否則 auditSelectedId 殘留會讓 anyEditing() 卡在 true，
  // 使後續所有背景資料同步靜默失效，且稽核頁籤已隱藏、無法從 UI 內清除——v13 修復）
  document.getElementById("auditTabBtn").hidden = !admin;
  if(!admin){
    resetAuditView();
  }
  if(!admin && document.getElementById("tab-audit").classList.contains("active")){
    switchMainTab("dashboard");
  }
}

/* ==========================================================
   設定（工地清單為全域；其餘基礎資料屬於目前工地）
   ========================================================== */
const SITE_CFG_MAP = {
  cfg_vendors:"vendors", cfg_locations:"locations", cfg_categories:"categories",
  cfg_equipTypes:"equipTypes", cfg_people:"people", cfg_laborTypes:"laborTypes"
};

function renderSettings(){
  if(!READY) return;
  document.getElementById("cfg_sites").value = MASTER.sites.join("\n");
  document.getElementById("siteConfigTitle").childNodes[0].textContent = `目前工地基礎資料：${MASTER.currentSite}`;
  const c = cur().config;
  Object.entries(SITE_CFG_MAP).forEach(([id,key])=>{
    document.getElementById(id).value = (c[key]||[]).join("\n");
  });
  document.getElementById("cfg_lockDate").value = c.lockDate || "";
  applyAdminUI();
}

function initSettings(){
  document.getElementById("saveSettings").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    const siteLines = document.getElementById("cfg_sites").value.split("\n").map(s=>s.trim()).filter(Boolean);
    if(siteLines.length) MASTER.sites = Array.from(new Set(siteLines));

    const c = cur().config;
    Object.entries(SITE_CFG_MAP).forEach(([id,key])=>{
      const lines = document.getElementById(id).value.split("\n").map(s=>s.trim()).filter(Boolean);
      c[key] = Array.from(new Set(lines));
    });
    c.lockDate = document.getElementById("cfg_lockDate").value || "";

    try{
      const jobs = [apiSaveMaster(), apiSaveConfig(MASTER.currentSite)];
      for(const site of MASTER.sites){
        if(!SITE_CACHE[site]){
          SITE_CACHE[site] = { config: defaultSiteConfig(), labor: [], equipment: [] };
          jobs.push(apiSaveConfig(site));
        }
      }
      await Promise.all(jobs);
    }catch(err){
      toast("⚠ 設定雲端儲存失敗，請檢查網路後再試");
      return;
    }
    if(!MASTER.sites.includes(MASTER.currentSite)){
      MASTER.currentSite = MASTER.sites[0];
      sessionStorage.setItem("dm_site", MASTER.currentSite);
    }
    renderAll();
    toast("設定已儲存至共用資料庫");
  });

  document.getElementById("resetSettings").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm(`確定要將「${MASTER.currentSite}」的基礎資料還原為預設值嗎？（紀錄不受影響，影響所有使用者）`)) return;
    cur().config = defaultSiteConfig();
    try{
      await apiSaveConfig(MASTER.currentSite);
    }catch(err){
      toast("⚠ 雲端儲存失敗，請檢查網路後再試");
      return;
    }
    renderAll();
    toast("已還原目前工地的預設清單");
  });

  document.getElementById("clearSiteData").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm(`確定要清空「${MASTER.currentSite}」的所有點工/機具紀錄嗎？\n\n⚠ 此操作影響所有使用者且無法復原。（基礎資料清單保留）`)) return;
    try{
      await api("POST", { op:"clearSite", site: MASTER.currentSite });
    }catch(err){
      toast("⚠ 雲端清除失敗，請檢查網路後再試");
      return;
    }
    cur().labor = [];
    cur().equipment = [];
    resetLaborApplyForm(); resetLaborReportForm(); resetEquipApplyForm(); resetEquipReportForm();
    renderAll();
    toast("已清空目前工地的紀錄");
  });

  document.getElementById("backupBtn").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    try{
      const data = await api("GET", null, { scope: "all" });
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `點工機具_完整備份_${localDate()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("備份已下載，請妥善保存");
    }catch(e){
      toast("⚠ 備份下載失敗，請檢查網路");
    }
  });

  document.getElementById("clearAllData").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm("確定要清空全部工地的所有資料嗎？\n\n⚠ 此操作影響所有使用者且無法復原。")) return;
    try{
      await api("POST", { op:"clearAll" });
    }catch(err){
      toast("⚠ 雲端清除失敗，請檢查網路後再試");
      return;
    }
    sessionStorage.removeItem("dm_site");
    location.reload();
  });
}

/* ---------------- render everything ---------------- */
function renderAll(){
  if(!READY) return;
  renderSitePicker();
  renderSiteChips();
  renderOptionPools();
  renderLaborList();
  renderEquipList();
  renderDashboard();
  renderReport(currentReport);
  if(document.getElementById("tab-audit").classList.contains("active")) renderAuditView();
  renderSettings();
}

/* ---------------- init ---------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  initTabs();
  initSubTabs();
  initTagRemoveHandler();

  initCombobox("cb_l_vendor", "vendors", "輸入以搜尋分包商");
  initCombobox("cb_l_applicant", "people", "輸入以搜尋申請人");
  initCombobox("cb_l_engineer", "people", "輸入以搜尋簽單責任工程師");
  initCombobox("cb_l_type_add", "laborTypes", "加入出工工種：輸入搜尋（粗工／技術工／打石工⋯），選取後加入覆核清單", {onPick: addTypeRow});
  initCombobox("cb_l_locations", "locations", "輸入以搜尋工作地點", {multi:"l_locations"});
  initCombobox("cb_e_vendor", "vendors", "輸入以搜尋機具廠商");
  initCombobox("cb_e_applicant", "people", "輸入以搜尋申請人");
  initCombobox("cb_e_checker", "people", "輸入以搜尋簽單責任工程師");
  initCombobox("cb_e_locations", "locations", "輸入以搜尋工作地點", {multi:"e_locations"});

  initSelectTagPicker("l_categories_picker", "l_categories");
  initSelectTagPicker("e_type_picker", "e_type");

  setStepper();
  initLaborApplyForm();
  initLaborReportForm();
  initEquipApplyForm();
  initEquipReportForm();
  initReportTabs();
  initAudit();
  initAdmin();
  initSettings();
  document.getElementById("refreshBtn").addEventListener("click", ()=>refreshData(false));

  boot();
});
