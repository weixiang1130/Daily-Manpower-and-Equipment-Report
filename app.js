/* ==========================================================
   點工機具稽核系統 - 前端原型 v6
   資料以 localStorage 暫存（單機示範用，之後可換接後端 API）

   v6 重點：
   1. 多工地完全隔離：每個工地一把獨立的 localStorage key
      （dm_site_v6::<工地名>），基礎資料（分包商/人員/地點…）
      與紀錄（點工/機具）互不共用；頁首切換工地即切換資料環境。
   2. 點工申請(父) / 回報覆核(子)：申請單含「預計進場人員名單」，
      回報時逐人勾選到場並填實際出工數(可含小數)與加班時數；
      全無人出工需勾「0工確認」後以 0 工寫入。
   3. 智慧搜尋下拉（combobox）：分包商/申請人/工程師/工作地點/
      點工人員皆可輸入模糊搜尋，搜不到時選單底部「＋ 新增選項」
      直接寫入目前工地的基礎資料。
   4. 防呆警告：出工數與加班時數配置異常時彈出警告（可仍送出）。

   注意：以下 GENERIC_CONFIG 僅為範例佔位資料。實際工地／分包商
   ／人員名單請放在 config.local.js（已列入 .gitignore，不會被
   推上程式碼庫），格式為：
     window.LOCAL_CONFIG = { sites:[...], vendors:[...], people:[...] };
   vendors 會作為每個工地建立時的預設分包商名單。
   ========================================================== */

const MASTER_KEY = "dm_master_v6";
const SITE_KEY = s => "dm_site_v6::" + s;
const ADD_NEW = "__ADD_NEW__";

const GENERIC_CONFIG = {
  sites: ["工地A", "工地B", "工地C"],
  vendors: ["分包商A", "分包商B", "分包商C"],
  locations: ["一樓", "二樓", "三樓", "室外廣場", "地下室", "料場", "其他"],
  categories: ["搬料", "掃地/環境5S", "打石", "整地", "安衛設施維護", "鋼筋作業", "模板作業", "吊掛作業", "其他"],
  equipTypes: ["吊車", "挖土機", "堆高機", "洗車台", "發電機", "其他"],
  people: ["王小明", "李小華", "陳大文"]
};

const LOCAL = (typeof window !== "undefined" && window.LOCAL_CONFIG) ? window.LOCAL_CONFIG : {};

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function isoDate(d){ return d.toISOString().slice(0,10); }
function fmt(n){ const v = Math.round((Number(n)||0)*100)/100; return String(v); }

/* ==========================================================
   儲存層：master（工地清單＋目前工地）＋ 每工地獨立 store
   ========================================================== */
let MASTER = loadMaster();
const SITE_CACHE = {};

function loadMaster(){
  try{
    const raw = localStorage.getItem(MASTER_KEY);
    if(raw){
      const m = JSON.parse(raw);
      if(Array.isArray(m.sites) && m.sites.length) return m;
    }
  }catch(e){}
  const sites = (LOCAL.sites && LOCAL.sites.length ? LOCAL.sites : GENERIC_CONFIG.sites).slice();
  return { sites, currentSite: sites[0] };
}
function saveMaster(){
  if(!MASTER.sites.includes(MASTER.currentSite)) MASTER.currentSite = MASTER.sites[0];
  localStorage.setItem(MASTER_KEY, JSON.stringify(MASTER));
}

function defaultSiteConfig(){
  return {
    vendors: (LOCAL.vendors && LOCAL.vendors.length ? LOCAL.vendors : GENERIC_CONFIG.vendors).slice(),
    locations: GENERIC_CONFIG.locations.slice(),
    categories: GENERIC_CONFIG.categories.slice(),
    equipTypes: GENERIC_CONFIG.equipTypes.slice(),
    people: (LOCAL.people && LOCAL.people.length ? LOCAL.people : GENERIC_CONFIG.people).slice(),
    workers: []
  };
}

function loadSiteStore(site){
  if(SITE_CACHE[site]) return SITE_CACHE[site];
  let store = null;
  try{
    const raw = localStorage.getItem(SITE_KEY(site));
    if(raw) store = JSON.parse(raw);
  }catch(e){}
  if(!store) store = { config: defaultSiteConfig(), labor: [], equipment: [] };
  if(!store.config) store.config = defaultSiteConfig();
  Object.keys(defaultSiteConfig()).forEach(k=>{ if(!Array.isArray(store.config[k])) store.config[k] = []; });
  if(!store.labor) store.labor = [];
  if(!store.equipment) store.equipment = [];
  SITE_CACHE[site] = store;
  return store;
}
function saveSite(site){
  localStorage.setItem(SITE_KEY(site), JSON.stringify(SITE_CACHE[site]));
}
function cur(){ return loadSiteStore(MASTER.currentSite); }
function saveCur(){ saveSite(MASTER.currentSite); }

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove("show"), 2600);
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
  saveMaster();
  resetLaborApplyForm();
  resetLaborReportForm();
  resetEquipApplyForm();
  resetEquipReportForm();
  renderAll();
  if(!silent) toast(`已切換至：${site}`);
}

/* ---------------- Top-level / Sub Tabs ---------------- */
function initTabs(){
  document.querySelectorAll(".tabs > .tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tabs > .tab").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll("#app > .tab-panel").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
      if(btn.dataset.tab === "dashboard") renderDashboard();
      if(btn.dataset.tab === "history") renderReport(currentReport);
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
const tagState = { l_workers:[], l_locations:[], l_categories:[], e_locations:[], e_type:[] };

function initCombobox(rootId, pool, placeholder, opts={}){
  const root = document.getElementById(rootId);
  root.innerHTML = `<input type="text" class="cb-input" placeholder="${esc(placeholder)}" autocomplete="off"><div class="cb-list" hidden></div>`;
  const input = root.querySelector(".cb-input");
  const list = root.querySelector(".cb-list");
  COMBO[rootId] = { pool, input, list, multi: opts.multi || null, onChange: opts.onChange || null };

  const options = ()=> (cur().config[pool] || []);

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
    saveCur();
    toast(`已新增至本工地資料庫：${v}`);
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
    if(f === "l_workers") syncRequiredFromWorkers();
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
  const c = cur().config;
  fillSelect("l_categories_picker", c.categories, "點選以新增工作內容類別", "categories");
  fillSelect("e_type_picker", c.equipTypes, "點選以新增機具類型", "equipTypes");
}

function bindCharCounter(taId, countId){
  const ta = document.getElementById(taId);
  const cnt = document.getElementById(countId);
  ta.addEventListener("input", ()=>{ cnt.textContent = ta.value.length; });
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

function syncRequiredFromWorkers(){
  document.getElementById("l_required").value = tagState.l_workers.length;
}

function initLaborApplyForm(){
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("laborApplyNewBtn").addEventListener("click", resetLaborApplyForm);

  document.getElementById("laborApplyForm").addEventListener("submit", e=>{
    e.preventDefault();
    const vendor = requireCombo("cb_l_vendor", "分包商");
    if(vendor === null) return;
    const applicant = requireCombo("cb_l_applicant", "申請人");
    if(applicant === null) return;
    const required = parseFloat(document.getElementById("l_required").value) || 0;

    const store = cur();
    const existing = editingLaborApplyId ? store.labor.find(r=>r.id===editingLaborApplyId) : null;

    const rec = {
      id: editingLaborApplyId || uid(),
      date: document.getElementById("l_date").value,
      vendor, applicant, required,
      workers: tagState.l_workers.slice(),
      locations: tagState.l_locations.slice(),
      categories: tagState.l_categories.slice(),
      categoryNote: document.getElementById("l_categoryNote").value.trim(),
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null
    };

    if(editingLaborApplyId){
      const idx = store.labor.findIndex(r=>r.id===editingLaborApplyId);
      store.labor[idx] = rec;
      toast("申請資料已更新");
    }else{
      store.labor.unshift(rec);
      toast("點工申請已送出，待現場回報覆核");
    }
    saveCur();
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
  setTags("l_workers", []);
  setTags("l_locations", []);
  setTags("l_categories", []);
  document.getElementById("laborApplyTitle").textContent = "新增點工申請";
  document.getElementById("laborApplySubmitBtn").textContent = "送出點工申請";
  document.getElementById("laborApplyNewBtn").style.display = "none";
  renderLaborList();
}

function loadLaborApplyRecord(id){
  const rec = cur().labor.find(r=>r.id===id);
  if(!rec) return;
  editingLaborApplyId = id;

  document.getElementById("l_date").value = rec.date;
  setCombo("cb_l_vendor", rec.vendor);
  setCombo("cb_l_applicant", rec.applicant);
  document.getElementById("l_required").value = rec.required;
  setTags("l_workers", rec.workers);
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
   點工 — 回報覆核（子層，承繼父層人員名單逐人勾選）
   ========================================================== */
let editingLaborReportId = null;
let attState = [];

function initLaborReportForm(){
  bindCharCounter("l_conclusion","l_conclusionCount");
  document.getElementById("laborReportCancelBtn").addEventListener("click", resetLaborReportForm);
  document.getElementById("l_actual").addEventListener("input", updateLaborDiff);
  document.getElementById("l_zeroWork").addEventListener("change", onZeroWorkToggle);

  const attBox = document.getElementById("l_attendance");
  attBox.addEventListener("change", e=>{
    const cb = e.target.closest("input[type=checkbox][data-i]");
    if(!cb) return;
    const i = parseInt(cb.dataset.i,10);
    attState[i].present = cb.checked;
    if(cb.checked && !(attState[i].work > 0)) attState[i].work = 1;
    renderAttendance();
    syncTotalsFromAttendance();
  });
  attBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i)) return;
    if(el.classList.contains("att-work")) attState[i].work = parseFloat(el.value)||0;
    if(el.classList.contains("att-ot")) attState[i].ot = parseFloat(el.value)||0;
    syncTotalsFromAttendance();
  });

  document.getElementById("laborReportForm").addEventListener("submit", e=>{
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
    const totalOT = parseFloat(document.getElementById("l_totalOT").value) || 0;
    const zeroWork = document.getElementById("l_zeroWork").checked;

    if(actual === 0 && !zeroWork){
      toast("實際出工數為 0：若當日確實無人出工，請先勾選「0 工確認」再送出");
      return;
    }
    if(zeroWork && actual !== 0){
      toast("已勾選 0 工確認，但簽單實際出工數不為 0，請修正其中一項");
      return;
    }

    const warnings = collectLaborWarnings(attState, actual, totalOT, zeroWork);
    if(warnings.length){
      const ok = confirm("⚠ 系統偵測到以下數據配置異常，請確認是否輸入錯誤：\n\n- " + warnings.join("\n- ") + "\n\n確認無誤仍要送出嗎？");
      if(!ok) return;
    }

    rec.report = {
      reportedAt: isoDate(new Date()),
      engineer,
      checkFace: document.getElementById("l_check_face").checked,
      checkCard: document.getElementById("l_check_card").checked,
      checkToolbox: document.getElementById("l_check_toolbox").checked,
      attendance: attState.map(a=>({name:a.name, present:a.present, work:a.present?a.work:0, ot:a.present?a.ot:0})),
      actual, totalOT,
      diff: actual - rec.required,
      zeroWork,
      signReturnDate: document.getElementById("l_signReturnDate").value,
      selfDone: document.getElementById("l_selfDone").value.trim(),
      vendorDone: document.getElementById("l_vendorDone").value.trim(),
      conclusion: document.getElementById("l_conclusion").value.trim()
    };
    rec.status = "已回報";

    saveCur();
    toast(zeroWork ? "已以 0 工寫入回報" : "已儲存回報");
    resetLaborReportForm();
    renderDashboard();
  });

  resetLaborReportForm();
}

function collectLaborWarnings(att, actual, totalOT, zeroWork){
  const w = [];
  if(zeroWork) return w;
  att.filter(a=>a.present).forEach(a=>{
    if(!(a.work > 0)) w.push(`${a.name}：已勾選到場，但實際出工數為 0`);
    if(a.work > 0 && a.work <= 0.5 && a.ot > 4) w.push(`${a.name}：出工僅 ${fmt(a.work)} 工，加班卻達 ${fmt(a.ot)} 小時`);
    if(a.ot > 8) w.push(`${a.name}：加班時數 ${fmt(a.ot)} 小時，超過 8 小時`);
    if(a.work > 2) w.push(`${a.name}：單人單日出工數 ${fmt(a.work)} 工，高於常態`);
  });
  const hasAtt = att.some(a=>a.present);
  if(!hasAtt){
    if(actual > 0 && actual <= 0.5 && totalOT > 4) w.push(`出工僅 ${fmt(actual)} 工，加班總時數卻達 ${fmt(totalOT)} 小時`);
    if(totalOT > 8 && actual <= 1) w.push(`加班總時數 ${fmt(totalOT)} 小時相對出工數 ${fmt(actual)} 工異常偏高`);
  }
  if(actual > 0 && totalOT > actual * 8) w.push(`加班總時數 ${fmt(totalOT)} 小時已超過出工數 ${fmt(actual)} 工的合理上限（每工 8 小時）`);
  return w;
}

function renderAttendance(){
  const box = document.getElementById("l_attendance");
  const zero = document.getElementById("l_zeroWork").checked;
  if(!attState.length){
    box.innerHTML = '<div class="empty-row">此申請單未填寫預計進場人員名單，請直接於下方輸入簽單實際出工數</div>';
    return;
  }
  box.classList.toggle("disabled", zero);
  box.innerHTML = attState.map((a,i)=>`
    <div class="att-row ${a.present?'present':''}">
      <label class="att-check"><input type="checkbox" data-i="${i}" ${a.present?'checked':''} ${zero?'disabled':''}><span>${esc(a.name)}</span></label>
      <div class="att-fields" ${a.present?'':'style="visibility:hidden;"'}>
        <label>出工數<input type="number" class="att-work" data-i="${i}" step="0.5" min="0" value="${a.work}" ${zero?'disabled':''}></label>
        <label>加班時數<input type="number" class="att-ot" data-i="${i}" step="0.5" min="0" value="${a.ot}" ${zero?'disabled':''}></label>
      </div>
    </div>`).join("");
}

function syncTotalsFromAttendance(){
  if(!attState.length) { updateLaborDiff(); return; }
  const present = attState.filter(a=>a.present);
  document.getElementById("l_actual").value = present.reduce((s,a)=>s+(a.work||0),0);
  document.getElementById("l_totalOT").value = present.reduce((s,a)=>s+(a.ot||0),0);
  updateLaborDiff();
}

function onZeroWorkToggle(){
  const zero = document.getElementById("l_zeroWork").checked;
  if(zero){
    attState.forEach(a=>{ a.present = false; });
    document.getElementById("l_actual").value = 0;
    document.getElementById("l_totalOT").value = 0;
  }
  renderAttendance();
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
  attState = [];
  document.getElementById("laborReportForm").reset();
  setCombo("cb_l_engineer", "");
  document.getElementById("l_attendance").innerHTML = "";
  document.getElementById("l_diff").value = "";
  document.getElementById("l_conclusionCount").textContent = "0";
  document.getElementById("laborReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  document.getElementById("laborReportSubmitBtn").disabled = true;
  renderLaborList();
}

function loadLaborReportRecord(id){
  const rec = cur().labor.find(r=>r.id===id);
  if(!rec) return;
  editingLaborReportId = id;

  const prev = (rec.report && rec.report.attendance) || [];
  attState = (rec.workers||[]).map(name=>{
    const p = prev.find(x=>x.name===name);
    return p ? {name, present:!!p.present, work:p.work||0, ot:p.ot||0} : {name, present:false, work:1, ot:0};
  });

  document.getElementById("laborReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(MASTER.currentSite)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　需求工數：${fmt(rec.required)}　申請人：${esc(rec.applicant)}
    ${(rec.locations||[]).length ? "　地點："+esc(rec.locations.join("、")) : ""}
  </div>`;

  const rep = rec.report || {};
  document.getElementById("l_check_face").checked = !!rep.checkFace;
  document.getElementById("l_check_card").checked = !!rep.checkCard;
  document.getElementById("l_check_toolbox").checked = !!rep.checkToolbox;
  document.getElementById("l_zeroWork").checked = !!rep.zeroWork;
  renderAttendance();
  document.getElementById("l_actual").value = rep.actual != null ? rep.actual : 0;
  document.getElementById("l_totalOT").value = rep.totalOT != null ? rep.totalOT : 0;
  updateLaborDiff();
  document.getElementById("l_signReturnDate").value = rep.signReturnDate || "";
  setCombo("cb_l_engineer", rep.engineer || "");
  document.getElementById("l_selfDone").value = rep.selfDone || "";
  document.getElementById("l_vendorDone").value = rep.vendorDone || "";
  document.getElementById("l_conclusion").value = rep.conclusion || "";
  document.getElementById("l_conclusionCount").textContent = (rep.conclusion||"").length;
  document.getElementById("laborReportSubmitBtn").disabled = false;

  switchSubTab("tab-labor", "labor-report");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});
}

function deleteLaborRecord(id){
  if(!confirm("確定要刪除這筆點工紀錄（含其回報）嗎？此操作無法復原。")) return;
  const store = cur();
  store.labor = store.labor.filter(r=>r.id!==id);
  if(editingLaborApplyId===id) resetLaborApplyForm();
  if(editingLaborReportId===id) resetLaborReportForm();
  saveCur();
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
          <button type="button" class="btn-mini btn-edit" data-id="${r.id}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${r.id}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${r.id}">刪除</button>
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

  document.getElementById("equipApplyForm").addEventListener("submit", e=>{
    e.preventDefault();
    const vendor = requireCombo("cb_e_vendor", "機具廠商");
    if(vendor === null) return;
    const applicant = requireCombo("cb_e_applicant", "申請人");
    if(applicant === null) return;
    const types = tagState.e_type.slice();
    if(!types.length){ toast("請選擇機具類型"); return; }

    const requiredQty = parseFloat(document.getElementById("e_requiredQty").value) || 0;
    const store = cur();
    const existing = editingEquipApplyId ? store.equipment.find(r=>r.id===editingEquipApplyId) : null;

    const rec = {
      id: editingEquipApplyId || uid(),
      date: document.getElementById("e_date").value,
      vendor, applicant, types,
      model: document.getElementById("e_model").value.trim(),
      requiredQty,
      contracted: document.querySelector('input[name="e_contract"]:checked').value,
      locations: tagState.e_locations.slice(),
      content: document.getElementById("e_content").value.trim(),
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null
    };

    if(editingEquipApplyId){
      const idx = store.equipment.findIndex(r=>r.id===editingEquipApplyId);
      store.equipment[idx] = rec;
      toast("申請資料已更新");
    }else{
      store.equipment.unshift(rec);
      toast("機具申請已送出，待現場回報");
    }
    saveCur();
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
  renderEquipList();
}

function loadEquipApplyRecord(id){
  const rec = cur().equipment.find(r=>r.id===id);
  if(!rec) return;
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
   機具 — 回報
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

  document.getElementById("equipReportForm").addEventListener("submit", e=>{
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

    rec.report = {
      reportedAt: isoDate(new Date()),
      checker,
      usage: usageState.map(u=>({type:u.type, present:u.present, hours:u.present?u.hours:0})),
      actualHours,
      diff: actualHours - rec.requiredQty,
      zeroUse,
      signReturnDate: document.getElementById("e_signReturnDate").value,
      selfDone: document.getElementById("e_selfDone").value.trim(),
      vendorDone: document.getElementById("e_vendorDone").value.trim()
    };
    rec.status = "已回報";

    saveCur();
    toast(zeroUse ? "已以 0 時數寫入回報" : "已儲存回報");
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
  renderEquipList();
}

function loadEquipReportRecord(id){
  const rec = cur().equipment.find(r=>r.id===id);
  if(!rec) return;
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
  document.getElementById("e_selfDone").value = rep.selfDone || "";
  document.getElementById("e_vendorDone").value = rep.vendorDone || "";
  document.getElementById("equipReportSubmitBtn").disabled = false;

  switchSubTab("tab-equipment", "equip-report");
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});
}

function deleteEquipRecord(id){
  if(!confirm("確定要刪除這筆機具紀錄（含其回報）嗎？此操作無法復原。")) return;
  const store = cur();
  store.equipment = store.equipment.filter(r=>r.id!==id);
  if(editingEquipApplyId===id) resetEquipApplyForm();
  if(editingEquipReportId===id) resetEquipReportForm();
  saveCur();
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
          <button type="button" class="btn-mini btn-edit" data-id="${x.id}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${x.id}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${x.id}">刪除</button>
        </td>
      </tr>`;
    }).join("")}
  </tbody></table>`;

  el.querySelectorAll(".btn-edit").forEach(btn=>btn.addEventListener("click", ()=>loadEquipApplyRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-report").forEach(btn=>btn.addEventListener("click", ()=>loadEquipReportRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-del").forEach(btn=>btn.addEventListener("click", ()=>deleteEquipRecord(btn.dataset.id)));
}

/* ==========================================================
   總覽（跨全部工地彙總；各工地資料各自讀取，維持隔離）
   ========================================================== */
function isThisMonth(dateStr){
  if(!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
}

function renderDashboard(){
  let allLabor = [], allEquip = [];
  MASTER.sites.forEach(site=>{
    const s = loadSiteStore(site);
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
    const s = loadSiteStore(site);
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

function attendanceDetail(rep){
  if(!rep || !rep.attendance) return "";
  return rep.attendance.filter(a=>a.present)
    .map(a=>`${a.name}(${fmt(a.work)}工${a.ot?`/加班${fmt(a.ot)}h`:""})`).join("、");
}

const REPORT_DEFS = {
  labor: {
    title:"點工紀錄",
    headers:["出工日期","廠商","需求工數","預計進場人員","工作內容","工作地點","申請人","狀態","人臉紀錄","白卡紀錄","工具箱紀錄","簽單繳回日","簽單實際出工數","差異","0工確認","簽單責任工程師","實際加班時數(晚上)","出工人員明細","根基自辦","廠商代辦","現場查核回饋"],
    rows: ()=>cur().labor.map(r=>{
      const rep = r.report || {};
      const reported = r.status==="已回報" && r.report;
      return [
        r.date, r.vendor, fmt(r.required), (r.workers||[]).join("、"),
        (r.categories||[]).join("、")+(r.categoryNote?"・"+r.categoryNote:""),
        (r.locations||[]).join("、"), r.applicant, r.status,
        rep.checkFace?"V":"", rep.checkCard?"V":"", rep.checkToolbox?"V":"",
        rep.signReturnDate||"", reported?fmt(rep.actual):"", reported?fmt(rep.diff):"",
        rep.zeroWork?"V":"",
        rep.engineer||"", reported?fmt(rep.totalOT):"", attendanceDetail(rep),
        rep.selfDone||"", rep.vendorDone||"", rep.conclusion||""
      ];
    })
  },
  equipment: {
    title:"機具紀錄",
    headers:["出工日期","機具廠商","機具類型","型號","工作內容","工作地點","責任廠商","預計使用時數(需求數量)","申請人","狀態","簽單繳回日","機具實際工作使用時數","差異","0使用確認","機具使用明細","簽單責任工程師","根基自辦","廠商代辦"],
    rows: ()=>cur().equipment.map(x=>{
      const rep = x.report || {};
      const reported = x.status==="已回報" && x.report;
      const usageDetail = (rep.usage||[]).filter(u=>u.present)
        .map(u=>`${u.type}(${fmt(u.hours)}h)`).join("、");
      return [
        x.date, x.vendor, (x.types||[]).join("、"), x.model, x.content,
        (x.locations||[]).join("、"), x.vendor, fmt(x.requiredQty), x.applicant, x.status,
        rep.signReturnDate||"", reported?fmt(rep.actualHours):"", reported?fmt(rep.diff):"",
        rep.zeroUse?"V":"", usageDetail,
        rep.checker||"", rep.selfDone||"", rep.vendorDone||""
      ];
    })
  }
};

function initReportTabs(){
  document.querySelectorAll(".rtab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".rtab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      currentReport = btn.dataset.r;
      renderReport(currentReport);
    });
  });
  document.getElementById("exportBtn").addEventListener("click", ()=>exportCSV(currentReport));
}

function renderReport(key){
  const def = REPORT_DEFS[key];
  const rows = def.rows();
  const el = document.getElementById("reportTable");
  if(!rows.length){ el.innerHTML = '<div class="empty-row">目前工地尚無「'+esc(def.title)+'」資料</div>'; return; }
  el.innerHTML = `<table><thead><tr>${def.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c===undefined||c===null?"":c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function exportCSV(key){
  const def = REPORT_DEFS[key];
  const rows = def.rows();
  if(!rows.length){ toast("目前沒有可匯出的資料"); return; }
  const csvLines = [def.headers.join(",")].concat(
    rows.map(r=>r.map(c=>{
      const v = (c===undefined||c===null?"":String(c)).replace(/"/g,'""');
      return /[,\n"]/.test(v) ? `"${v}"` : v;
    }).join(","))
  );
  const csv = "﻿" + csvLines.join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${MASTER.currentSite}_${def.title}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV 已匯出");
}

/* ==========================================================
   管理員模式：清空／批次設定僅限管理員；一般使用者仍可透過
   表單搜尋欄位「＋ 新增選項」新增資料。密碼由 config.local.js
   的 adminPin 提供（程式碼庫預設為範例值 0000）。
   注意：此為前端層級的防誤觸設計，非真正的資安防線；正式的
   帳號權限控管需搭配後端服務。
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
  document.getElementById("saveSettings").style.display = admin ? "" : "none";
  document.getElementById("resetSettings").style.display = admin ? "" : "none";
  document.getElementById("dangerZone").style.display = admin ? "" : "none";
}

/* ==========================================================
   設定（工地清單為全域；其餘基礎資料屬於目前工地）
   ========================================================== */
const SITE_CFG_MAP = {
  cfg_vendors:"vendors", cfg_locations:"locations", cfg_categories:"categories",
  cfg_equipTypes:"equipTypes", cfg_people:"people", cfg_workers:"workers"
};

function renderSettings(){
  document.getElementById("cfg_sites").value = MASTER.sites.join("\n");
  document.getElementById("siteConfigTitle").childNodes[0].textContent = `目前工地基礎資料：${MASTER.currentSite}`;
  const c = cur().config;
  Object.entries(SITE_CFG_MAP).forEach(([id,key])=>{
    document.getElementById(id).value = (c[key]||[]).join("\n");
  });
  applyAdminUI();
}

function initSettings(){
  document.getElementById("saveSettings").addEventListener("click", ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    const siteLines = document.getElementById("cfg_sites").value.split("\n").map(s=>s.trim()).filter(Boolean);
    if(siteLines.length) MASTER.sites = Array.from(new Set(siteLines));
    saveMaster();

    const c = cur().config;
    Object.entries(SITE_CFG_MAP).forEach(([id,key])=>{
      const lines = document.getElementById(id).value.split("\n").map(s=>s.trim()).filter(Boolean);
      c[key] = Array.from(new Set(lines));
    });
    saveCur();
    renderAll();
    toast("設定已儲存");
  });

  document.getElementById("resetSettings").addEventListener("click", ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm(`確定要將「${MASTER.currentSite}」的基礎資料還原為預設值嗎？（紀錄不受影響）`)) return;
    cur().config = defaultSiteConfig();
    saveCur();
    renderAll();
    toast("已還原目前工地的預設清單");
  });

  document.getElementById("clearSiteData").addEventListener("click", ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm(`確定要清空「${MASTER.currentSite}」的所有點工/機具紀錄嗎？此操作無法復原。（基礎資料清單保留）`)) return;
    const store = cur();
    store.labor = [];
    store.equipment = [];
    saveCur();
    resetLaborApplyForm(); resetLaborReportForm(); resetEquipApplyForm(); resetEquipReportForm();
    renderAll();
    toast("已清空目前工地的紀錄");
  });

  document.getElementById("clearAllData").addEventListener("click", ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    if(!confirm("確定要清空全部工地的所有資料嗎？此操作無法復原。")) return;
    Object.keys(localStorage).filter(k=>k===MASTER_KEY || k.startsWith("dm_site_v6::")).forEach(k=>localStorage.removeItem(k));
    location.reload();
  });
}

/* ---------------- render everything ---------------- */
function renderAll(){
  renderSitePicker();
  renderOptionPools();
  renderLaborList();
  renderEquipList();
  renderDashboard();
  renderReport(currentReport);
  renderSettings();
}

/* ---------------- init ---------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  saveMaster();
  initTabs();
  initSubTabs();
  initTagRemoveHandler();

  initCombobox("cb_l_vendor", "vendors", "輸入以搜尋分包商");
  initCombobox("cb_l_applicant", "people", "輸入以搜尋申請人");
  initCombobox("cb_l_engineer", "people", "輸入以搜尋簽單責任工程師");
  initCombobox("cb_l_workers", "workers", "輸入以搜尋/新增點工人員，選取後加入名單", {multi:"l_workers", onChange: syncRequiredFromWorkers});
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
  initAdmin();
  initSettings();
  renderAll();
});
