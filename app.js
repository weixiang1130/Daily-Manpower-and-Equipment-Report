/* ==========================================================
   點工機具稽核系統 - 前端原型
   資料以 localStorage 暫存（單機示範用，之後可換接後端 API）

   資料模型：申請與回報合併為同一筆紀錄，但畫面上拆成「申請」
   「回報」兩個獨立模組（各自的表單、各自送出），避免同一次
   填寫就把兩階段一起做完。回報欄位對應既有 Excel 查核表：
   點工出工列控 → 簽單繳回日／簽單實際出工數／差異／簽單責任
   工程師／實際工作時數(白天)／實際加班時數(晚上)／根基自辦／
   廠商代辦／現場查核回饋；機具出工列控 → 簽單繳回日／機具實際
   工作使用時數／差異／簽單責任工程師／根基自辦／廠商代辦。

   注意：以下 DEFAULT_CONFIG 僅為範例佔位資料，實際工地／分包商
   ／人員名單請於「設定」頁面輸入，資料僅存於各自瀏覽器的
   localStorage，不會寫回本程式碼庫。
   ========================================================== */

const STORAGE_KEY = "site_audit_v5";
const ADD_NEW = "__ADD_NEW__";
const ALL_SITES = "__ALL__";

const DEFAULT_CONFIG = {
  sites: ["工地A", "工地B", "工地C"],
  vendors: ["分包商A", "分包商B"],
  locations: ["一樓", "二樓", "三樓", "室外廣場", "地下室", "料場", "其他"],
  categories: ["搬料", "掃地/環境5S", "打石", "整地", "安衛設施維護", "鋼筋作業", "模板作業", "吊掛作業", "其他"],
  equipTypes: ["吊車", "挖土機", "堆高機", "洗車台", "發電機", "其他"],
  people: ["王小明", "李小華", "陳大文"]
};

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

function seedSampleData(){
  return {
    config: structuredClone(DEFAULT_CONFIG),
    labor: [],
    equipment: []
  };
}

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}

let STATE = loadState() || seedSampleData();
if(!STATE.config) STATE.config = structuredClone(DEFAULT_CONFIG);
if(!STATE.labor) STATE.labor = [];
if(!STATE.equipment) STATE.equipment = [];

function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
}

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove("show"), 2400);
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function isoDate(d){ return d.toISOString().slice(0,10); }

/* ---------------- Top-level Tabs ---------------- */
function initTabs(){
  document.querySelectorAll(".tabs > .tab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tabs > .tab").forEach(b=>b.classList.remove("active"));
      document.querySelectorAll("#app > .tab-panel").forEach(p=>p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-"+btn.dataset.tab).classList.add("active");
      if(btn.dataset.tab === "dashboard") renderDashboard();
      if(btn.dataset.tab === "history") renderReport(currentReport);
    });
  });
}

/* ---------------- Sub Tabs (申請／回報) ---------------- */
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

/* ---------------- Site filter dropdowns (list views / report) ---------------- */
let laborListFilter = ALL_SITES;
let equipListFilter = ALL_SITES;
let reportSiteFilter = ALL_SITES;

function fillSiteFilterSelect(id, currentValue){
  const el = document.getElementById(id);
  if(!el) return;
  el.innerHTML = `<option value="${ALL_SITES}">全部工地</option>` +
    STATE.config.sites.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join("");
  el.value = STATE.config.sites.includes(currentValue) ? currentValue : ALL_SITES;
}

function renderSiteFilters(){
  fillSiteFilterSelect("laborListFilter", laborListFilter);
  fillSiteFilterSelect("equipListFilter", equipListFilter);
  fillSiteFilterSelect("reportSiteFilter", reportSiteFilter);
}

function initSiteFilters(){
  document.getElementById("laborListFilter").addEventListener("change", (e)=>{
    laborListFilter = e.target.value;
    renderLaborList();
  });
  document.getElementById("equipListFilter").addEventListener("change", (e)=>{
    equipListFilter = e.target.value;
    renderEquipList();
  });
  document.getElementById("reportSiteFilter").addEventListener("change", (e)=>{
    reportSiteFilter = e.target.value;
    renderReport(currentReport);
  });
}

function jumpToSite(tabId, filterId, site){
  if(tabId==="labor") laborListFilter = site;
  if(tabId==="equipment") equipListFilter = site;
  document.getElementById(filterId).value = site;
  document.querySelectorAll(".tabs > .tab").forEach(b=>b.classList.toggle("active", b.dataset.tab===tabId));
  document.querySelectorAll("#app > .tab-panel").forEach(p=>p.classList.toggle("active", p.id==="tab-"+tabId));
  if(tabId==="labor") renderLaborList();
  if(tabId==="equipment") renderEquipList();
}

/* ---------------- Generic single-select dropdown (with "+ 新增選項") ---------------- */
function fillSelect(id, options, placeholder, configKey){
  const el = document.getElementById(id);
  if(!el) return;
  const prev = el.value;
  let html = "";
  if(placeholder) html += `<option value="">${esc(placeholder)}</option>`;
  html += options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join("");
  if(configKey) html += `<option value="${ADD_NEW}">＋ 新增選項…</option>`;
  el.innerHTML = html;
  if(options.includes(prev)) el.value = prev;
  if(configKey) el.dataset.configKey = configKey;
}

function initAddNewOptionHandler(){
  document.addEventListener("change", (e)=>{
    const el = e.target;
    if(el.tagName !== "SELECT" || !el.dataset.configKey) return;
    if(el.value === ADD_NEW) handleAddNewOption(el, el.dataset.configKey);
  });
}

function handleAddNewOption(el, configKey){
  const val = prompt("請輸入要新增的選項名稱：");
  const v = (val||"").trim();
  if(!v){ el.value = ""; return; }
  if(!STATE.config[configKey].includes(v)){
    STATE.config[configKey].push(v);
    save();
  }
  renderOptionLists();
  if(el.id.endsWith("_picker")){
    const fieldId = el.id.slice(0, -"_picker".length);
    if(!tagPickerState[fieldId]) tagPickerState[fieldId] = [];
    if(!tagPickerState[fieldId].includes(v)) tagPickerState[fieldId].push(v);
    renderTagPicker(fieldId);
    const target = document.getElementById(el.id);
    if(target) target.value = "";
  }else{
    const target = document.getElementById(el.id);
    if(target) target.value = v;
  }
  toast(`已新增選項：${v}`);
}

/* ---------------- Tag picker (dropdown-to-add, chip-list-to-remove) ---------------- */
const tagPickerState = {};

function initTagPicker(fieldId){
  tagPickerState[fieldId] = tagPickerState[fieldId] || [];
  const sel = document.getElementById(fieldId+"_picker");
  sel.addEventListener("change", ()=>{
    const v = sel.value;
    if(!v || v===ADD_NEW) return;
    if(!tagPickerState[fieldId].includes(v)){
      tagPickerState[fieldId].push(v);
      renderTagPicker(fieldId);
    }
    sel.value = "";
  });
  renderTagPicker(fieldId);
}
function renderTagPicker(fieldId){
  const container = document.getElementById(fieldId+"_tags");
  if(!container) return;
  const values = tagPickerState[fieldId] || [];
  container.innerHTML = values.length
    ? values.map(v=>`<span class="tag-pill">${esc(v)}<button type="button" class="tag-remove" data-field="${fieldId}" data-value="${esc(v)}">×</button></span>`).join("")
    : '<span class="tag-empty">尚未選擇</span>';
}
function getTagPickerValues(fieldId){ return (tagPickerState[fieldId]||[]).slice(); }
function setTagPickerValues(fieldId, values){ tagPickerState[fieldId] = (values||[]).slice(); renderTagPicker(fieldId); }

function initTagRemoveHandler(){
  document.addEventListener("click", (e)=>{
    const btn = e.target.closest(".tag-remove");
    if(!btn) return;
    const fieldId = btn.dataset.field;
    const value = btn.dataset.value;
    tagPickerState[fieldId] = (tagPickerState[fieldId]||[]).filter(v=>v!==value);
    renderTagPicker(fieldId);
  });
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
      const delta = parseInt(btn.dataset.delta,10);
      const val = Math.max(0, (parseInt(input.value,10)||0) + delta);
      input.value = val;
      input.dispatchEvent(new Event("input"));
    });
  });
}

/* ---------------- Render all dynamic option lists ---------------- */
function renderOptionLists(){
  const c = STATE.config;
  fillSelect("l_site", c.sites, "請選擇工地", "sites");
  fillSelect("e_site", c.sites, "請選擇工地", "sites");

  fillSelect("l_vendor", c.vendors, "請選擇分包商", "vendors");
  fillSelect("e_vendor", c.vendors, "請選擇機具廠商", "vendors");

  fillSelect("l_applicant", c.people, "請選擇申請人", "people");
  fillSelect("l_engineer", c.people, "請選擇簽單責任工程師", "people");
  fillSelect("e_applicant", c.people, "請選擇申請人", "people");
  fillSelect("e_checker", c.people, "請選擇簽單責任工程師", "people");

  fillSelect("l_locations_picker", c.locations, "點選以新增工作地點", "locations");
  fillSelect("l_categories_picker", c.categories, "點選以新增工作內容類別", "categories");
  fillSelect("e_locations_picker", c.locations, "點選以新增工作地點", "locations");
  fillSelect("e_type_picker", c.equipTypes, "點選以新增機具類型", "equipTypes");

  renderSiteFilters();
}

/* ==========================================================
   點工 — 申請模組
   ========================================================== */
let editingLaborApplyId = null;

function initLaborApplyForm(){
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("laborApplyNewBtn").addEventListener("click", resetLaborApplyForm);

  document.getElementById("laborApplyForm").addEventListener("submit", e=>{
    e.preventDefault();
    const required = parseInt(document.getElementById("l_required").value,10) || 0;
    const existing = editingLaborApplyId ? STATE.labor.find(r=>r.id===editingLaborApplyId) : null;
    const site = document.getElementById("l_site").value;
    const vendor = document.getElementById("l_vendor").value;
    const applicant = document.getElementById("l_applicant").value;
    if(!site || !vendor || !applicant){ toast("請完整填寫必要欄位（含工地）"); return; }

    const rec = {
      id: editingLaborApplyId || uid(),
      site,
      date: document.getElementById("l_date").value,
      vendor, required, applicant,
      locations: getTagPickerValues("l_locations"),
      categories: getTagPickerValues("l_categories"),
      categoryNote: document.getElementById("l_categoryNote").value.trim(),

      status: existing ? existing.status : "待回報",
      checkFace: existing ? existing.checkFace : false,
      checkCard: existing ? existing.checkCard : false,
      checkToolbox: existing ? existing.checkToolbox : false,
      actual: existing ? existing.actual : 0,
      diff: (existing ? existing.actual : 0) - required,
      signReturnDate: existing ? existing.signReturnDate : "",
      engineer: existing ? existing.engineer : "",
      dayHours: existing ? existing.dayHours : "",
      nightHours: existing ? existing.nightHours : "",
      selfDone: existing ? existing.selfDone : "",
      vendorDone: existing ? existing.vendorDone : "",
      conclusion: existing ? existing.conclusion : ""
    };

    if(editingLaborApplyId){
      const idx = STATE.labor.findIndex(r=>r.id===editingLaborApplyId);
      STATE.labor[idx] = rec;
      toast("申請資料已更新");
    }else{
      STATE.labor.unshift(rec);
      toast("點工申請已送出，待現場工程師回報");
    }
    save();
    resetLaborApplyForm();
    renderLaborList();
    renderDashboard();
  });

  resetLaborApplyForm();
}

function resetLaborApplyForm(){
  editingLaborApplyId = null;
  const form = document.getElementById("laborApplyForm");
  form.reset();
  document.getElementById("l_site").value = "";
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("l_required").value = 1;
  document.getElementById("l_applicant").value = "";
  setTagPickerValues("l_locations", []);
  setTagPickerValues("l_categories", []);
  document.getElementById("laborApplyTitle").textContent = "新增點工申請";
  document.getElementById("laborApplySubmitBtn").textContent = "送出點工申請";
  document.getElementById("laborApplyNewBtn").style.display = "none";
  renderLaborList();
}

function loadLaborApplyRecord(id){
  const rec = STATE.labor.find(r=>r.id===id);
  if(!rec) return;
  editingLaborApplyId = id;

  document.getElementById("l_site").value = rec.site;
  document.getElementById("l_date").value = rec.date;
  document.getElementById("l_vendor").value = rec.vendor;
  document.getElementById("l_required").value = rec.required;
  document.getElementById("l_applicant").value = rec.applicant;
  setTagPickerValues("l_locations", rec.locations);
  setTagPickerValues("l_categories", rec.categories);
  document.getElementById("l_categoryNote").value = rec.categoryNote || "";

  document.getElementById("laborApplyTitle").textContent = `編輯點工申請：${rec.date}・${rec.vendor}`;
  document.getElementById("laborApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("laborApplyNewBtn").style.display = "";

  switchSubTab("tab-labor", "labor-apply");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});
}

/* ==========================================================
   點工 — 回報模組
   ========================================================== */
let editingLaborReportId = null;
let auditTimer = { remaining: 600, handle: null, running:false };

function initLaborReportForm(){
  bindCharCounter("l_conclusion","l_conclusionCount");
  document.getElementById("l_actual").addEventListener("input", updateLaborReportDiff);
  document.getElementById("timerStart").addEventListener("click", startAuditTimer);
  document.getElementById("timerReset").addEventListener("click", resetAuditTimer);
  document.getElementById("laborReportCancelBtn").addEventListener("click", resetLaborReportForm);

  document.getElementById("laborReportForm").addEventListener("submit", e=>{
    e.preventDefault();
    if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const idx = STATE.labor.findIndex(r=>r.id===editingLaborReportId);
    if(idx===-1) return;
    const rec = STATE.labor[idx];

    const engineer = document.getElementById("l_engineer").value;
    if(!engineer){ toast("請選擇簽單責任工程師"); return; }
    if(engineer === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    const actual = parseInt(document.getElementById("l_actual").value,10) || 0;
    rec.checkFace = document.getElementById("l_check_face").checked;
    rec.checkCard = document.getElementById("l_check_card").checked;
    rec.checkToolbox = document.getElementById("l_check_toolbox").checked;
    rec.actual = actual;
    rec.diff = actual - rec.required;
    rec.signReturnDate = document.getElementById("l_signReturnDate").value;
    rec.engineer = engineer;
    rec.dayHours = document.getElementById("l_dayHours").value.trim();
    rec.nightHours = document.getElementById("l_nightHours").value.trim();
    rec.selfDone = document.getElementById("l_selfDone").value.trim();
    rec.vendorDone = document.getElementById("l_vendorDone").value.trim();
    rec.conclusion = document.getElementById("l_conclusion").value.trim();
    rec.status = "已回報";
    rec.reportedAt = isoDate(new Date());

    save();
    toast("已儲存回報");
    resetLaborReportForm();
    renderLaborList();
    renderDashboard();
  });

  resetLaborReportForm();
}

function updateLaborReportDiff(){
  if(!editingLaborReportId){ document.getElementById("l_diff").value=""; return; }
  const rec = STATE.labor.find(r=>r.id===editingLaborReportId);
  if(!rec) return;
  const actual = parseInt(document.getElementById("l_actual").value,10) || 0;
  const diff = actual - rec.required;
  document.getElementById("l_diff").value = diff===0? "0（人數相符）" : (diff>0? "+"+diff+"（超出申報）" : diff+"（短少，需追查）");
}

function resetLaborReportForm(){
  editingLaborReportId = null;
  resetAuditTimer();
  document.getElementById("laborReportForm").reset();
  document.getElementById("l_diff").value = "";
  document.getElementById("l_conclusionCount").textContent = "0";
  document.getElementById("laborReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  document.getElementById("laborReportSubmitBtn").disabled = true;
  renderLaborList();
}

function loadLaborReportRecord(id){
  const rec = STATE.labor.find(r=>r.id===id);
  if(!rec) return;
  editingLaborReportId = id;
  resetAuditTimer();

  document.getElementById("laborReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(rec.site)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　需求工數：${rec.required}　申請人：${esc(rec.applicant)}
    ${(rec.locations||[]).length ? "　地點："+esc(rec.locations.join("、")) : ""}
  </div>`;

  document.getElementById("l_check_face").checked = !!rec.checkFace;
  document.getElementById("l_check_card").checked = !!rec.checkCard;
  document.getElementById("l_check_toolbox").checked = !!rec.checkToolbox;
  document.getElementById("l_actual").value = rec.actual || 0;
  updateLaborReportDiff();
  document.getElementById("l_signReturnDate").value = rec.signReturnDate || "";
  document.getElementById("l_engineer").value = rec.engineer || "";
  document.getElementById("l_dayHours").value = rec.dayHours || "";
  document.getElementById("l_nightHours").value = rec.nightHours || "";
  document.getElementById("l_selfDone").value = rec.selfDone || "";
  document.getElementById("l_vendorDone").value = rec.vendorDone || "";
  document.getElementById("l_conclusion").value = rec.conclusion || "";
  document.getElementById("l_conclusionCount").textContent = (rec.conclusion||"").length;
  document.getElementById("laborReportSubmitBtn").disabled = false;

  switchSubTab("tab-labor", "labor-report");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});
}

function deleteLaborRecord(id){
  if(!confirm("確定要刪除這筆點工紀錄嗎？此操作無法復原。")) return;
  STATE.labor = STATE.labor.filter(r=>r.id!==id);
  if(editingLaborApplyId===id) resetLaborApplyForm();
  if(editingLaborReportId===id) resetLaborReportForm();
  save();
  toast("已刪除");
  renderLaborList();
  renderDashboard();
}

function startAuditTimer(){
  const box = document.querySelector("#tab-labor .timer-box");
  if(auditTimer.running) return;
  auditTimer.running = true;
  box.classList.remove("expired");
  box.classList.add("running");
  auditTimer.handle = setInterval(()=>{
    auditTimer.remaining--;
    renderTimerDisplay();
    if(auditTimer.remaining<=0){
      clearInterval(auditTimer.handle);
      auditTimer.running = false;
      box.classList.remove("running");
      box.classList.add("expired");
      toast("已逾時10分鐘，請僅計實到人數");
    }
  },1000);
}
function resetAuditTimer(){
  clearInterval(auditTimer.handle);
  auditTimer = { remaining:600, handle:null, running:false };
  const box = document.querySelector("#tab-labor .timer-box");
  if(box) box.classList.remove("running","expired");
  renderTimerDisplay();
}
function renderTimerDisplay(){
  const m = Math.floor(auditTimer.remaining/60);
  const s = auditTimer.remaining%60;
  const el = document.getElementById("timerDisplay");
  if(el) el.textContent = `${m}:${String(s).padStart(2,"0")}`;
}

function renderLaborList(){
  const list = STATE.labor.filter(r=>laborListFilter===ALL_SITES || r.site===laborListFilter);
  const el = document.getElementById("laborList");
  if(!list.length){ el.innerHTML = '<div class="empty-row">尚無點工紀錄</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>工地</th><th>狀態</th><th>出工日期</th><th>分包商</th><th>申請人</th><th>需求工數</th><th>簽單實際出工數</th><th>差異</th>
    <th>工作地點</th><th>簽單繳回日</th><th>簽單責任工程師</th><th>現場查核回饋</th><th>操作</th>
  </tr></thead><tbody>
    ${list.map(r=>{
      const statusTag = r.status==="已回報"? '<span class="tag ok">已回報</span>' : '<span class="tag warn">待回報</span>';
      const diffTag = r.status!=="已回報" ? "—" : (r.diff===0? '<span class="tag ok">相符</span>' : '<span class="tag bad">'+r.diff+'</span>');
      const reportBtnLabel = r.status==="已回報" ? "編輯回報" : "填寫回報";
      return `<tr>
        <td>${esc(r.site)}</td>
        <td>${statusTag}</td>
        <td>${esc(r.date)}</td><td>${esc(r.vendor)}</td><td>${esc(r.applicant)}</td>
        <td>${r.required}</td><td>${r.status==="已回報"? r.actual : "—"}</td><td>${diffTag}</td>
        <td>${esc((r.locations||[]).join("、"))}</td>
        <td>${esc(r.signReturnDate||"—")}</td>
        <td>${esc(r.engineer||"—")}</td>
        <td>${esc(r.conclusion||"—")}</td>
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
   機具 — 申請模組
   ========================================================== */
let editingEquipApplyId = null;

function initEquipApplyForm(){
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("equipApplyNewBtn").addEventListener("click", resetEquipApplyForm);

  document.getElementById("equipApplyForm").addEventListener("submit", e=>{
    e.preventDefault();
    const requiredQty = parseInt(document.getElementById("e_requiredQty").value,10) || 0;
    const existing = editingEquipApplyId ? STATE.equipment.find(r=>r.id===editingEquipApplyId) : null;
    const site = document.getElementById("e_site").value;
    const vendor = document.getElementById("e_vendor").value;
    const applicant = document.getElementById("e_applicant").value;
    const types = getTagPickerValues("e_type");
    if(!site || !vendor || !applicant || !types.length){ toast("請完整填寫工地、機具廠商、申請人與類型"); return; }

    const rec = {
      id: editingEquipApplyId || uid(),
      site,
      date: document.getElementById("e_date").value,
      vendor, applicant, types,
      model: document.getElementById("e_model").value.trim(),
      requiredQty,
      contracted: document.querySelector('input[name="e_contract"]:checked').value,
      locations: getTagPickerValues("e_locations"),
      content: document.getElementById("e_content").value.trim(),

      status: existing ? existing.status : "待回報",
      actualHours: existing ? existing.actualHours : 0,
      diff: (existing ? existing.actualHours : 0) - requiredQty,
      signReturnDate: existing ? existing.signReturnDate : "",
      checker: existing ? existing.checker : "",
      selfDone: existing ? existing.selfDone : "",
      vendorDone: existing ? existing.vendorDone : ""
    };

    if(editingEquipApplyId){
      const idx = STATE.equipment.findIndex(r=>r.id===editingEquipApplyId);
      STATE.equipment[idx] = rec;
      toast("申請資料已更新");
    }else{
      STATE.equipment.unshift(rec);
      toast("機具申請已送出，待現場工程師回報");
    }
    save();
    resetEquipApplyForm();
    renderEquipList();
    renderDashboard();
  });

  resetEquipApplyForm();
}

function resetEquipApplyForm(){
  editingEquipApplyId = null;
  const form = document.getElementById("equipApplyForm");
  form.reset();
  document.getElementById("e_site").value = "";
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("e_applicant").value = "";
  document.getElementById("e_requiredQty").value = 1;
  setTagPickerValues("e_type", []);
  setTagPickerValues("e_locations", []);
  document.getElementById("equipApplyTitle").textContent = "新增機具申請";
  document.getElementById("equipApplySubmitBtn").textContent = "送出機具申請";
  document.getElementById("equipApplyNewBtn").style.display = "none";
  renderEquipList();
}

function loadEquipApplyRecord(id){
  const rec = STATE.equipment.find(r=>r.id===id);
  if(!rec) return;
  editingEquipApplyId = id;

  document.getElementById("e_site").value = rec.site;
  document.getElementById("e_date").value = rec.date;
  document.getElementById("e_vendor").value = rec.vendor;
  document.getElementById("e_applicant").value = rec.applicant;
  setTagPickerValues("e_type", rec.types);
  document.getElementById("e_model").value = rec.model || "";
  document.getElementById("e_requiredQty").value = rec.requiredQty;
  document.querySelector(`input[name="e_contract"][value="${rec.contracted||"是"}"]`).checked = true;
  setTagPickerValues("e_locations", rec.locations);
  document.getElementById("e_content").value = rec.content || "";

  document.getElementById("equipApplyTitle").textContent = `編輯機具申請：${rec.date}・${rec.vendor}`;
  document.getElementById("equipApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("equipApplyNewBtn").style.display = "";

  switchSubTab("tab-equipment", "equip-apply");
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});
}

/* ==========================================================
   機具 — 回報模組
   ========================================================== */
let editingEquipReportId = null;

function initEquipReportForm(){
  document.getElementById("e_actualHours").addEventListener("input", updateEquipReportDiff);
  document.getElementById("equipReportCancelBtn").addEventListener("click", resetEquipReportForm);

  document.getElementById("equipReportForm").addEventListener("submit", e=>{
    e.preventDefault();
    if(!editingEquipReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const idx = STATE.equipment.findIndex(r=>r.id===editingEquipReportId);
    if(idx===-1) return;
    const rec = STATE.equipment[idx];

    const checker = document.getElementById("e_checker").value;
    if(!checker){ toast("請選擇簽單責任工程師"); return; }
    if(checker === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    const actualHours = parseInt(document.getElementById("e_actualHours").value,10) || 0;
    rec.actualHours = actualHours;
    rec.diff = actualHours - rec.requiredQty;
    rec.signReturnDate = document.getElementById("e_signReturnDate").value;
    rec.checker = checker;
    rec.selfDone = document.getElementById("e_selfDone").value.trim();
    rec.vendorDone = document.getElementById("e_vendorDone").value.trim();
    rec.status = "已回報";
    rec.reportedAt = isoDate(new Date());

    save();
    toast("已儲存回報");
    resetEquipReportForm();
    renderEquipList();
    renderDashboard();
  });

  resetEquipReportForm();
}

function updateEquipReportDiff(){
  if(!editingEquipReportId){ document.getElementById("e_diff").value=""; return; }
  const rec = STATE.equipment.find(r=>r.id===editingEquipReportId);
  if(!rec) return;
  const actualHours = parseInt(document.getElementById("e_actualHours").value,10) || 0;
  const diff = actualHours - rec.requiredQty;
  document.getElementById("e_diff").value = diff===0? "0（相符）" : diff;
}

function resetEquipReportForm(){
  editingEquipReportId = null;
  document.getElementById("equipReportForm").reset();
  document.getElementById("e_diff").value = "";
  document.getElementById("equipReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  document.getElementById("equipReportSubmitBtn").disabled = true;
  renderEquipList();
}

function loadEquipReportRecord(id){
  const rec = STATE.equipment.find(r=>r.id===id);
  if(!rec) return;
  editingEquipReportId = id;

  document.getElementById("equipReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(rec.site)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　類型：${esc((rec.types||[]).join("、"))}　需求數量：${rec.requiredQty}　申請人：${esc(rec.applicant)}
  </div>`;

  document.getElementById("e_actualHours").value = rec.actualHours || 0;
  updateEquipReportDiff();
  document.getElementById("e_signReturnDate").value = rec.signReturnDate || "";
  document.getElementById("e_checker").value = rec.checker || "";
  document.getElementById("e_selfDone").value = rec.selfDone || "";
  document.getElementById("e_vendorDone").value = rec.vendorDone || "";
  document.getElementById("equipReportSubmitBtn").disabled = false;

  switchSubTab("tab-equipment", "equip-report");
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});
}

function deleteEquipRecord(id){
  if(!confirm("確定要刪除這筆機具紀錄嗎？此操作無法復原。")) return;
  STATE.equipment = STATE.equipment.filter(r=>r.id!==id);
  if(editingEquipApplyId===id) resetEquipApplyForm();
  if(editingEquipReportId===id) resetEquipReportForm();
  save();
  toast("已刪除");
  renderEquipList();
  renderDashboard();
}

function renderEquipList(){
  const list = STATE.equipment.filter(x=>equipListFilter===ALL_SITES || x.site===equipListFilter);
  const el = document.getElementById("equipList");
  if(!list.length){ el.innerHTML = '<div class="empty-row">尚無機具紀錄</div>'; return; }
  el.innerHTML = `<table><thead><tr>
    <th>工地</th><th>狀態</th><th>日期</th><th>廠商</th><th>申請人</th><th>類型</th><th>型號</th><th>需求數量</th><th>機具實際工作使用時數</th><th>差異</th>
    <th>簽單繳回日</th><th>簽單責任工程師</th><th>操作</th>
  </tr></thead><tbody>
    ${list.map(x=>{
      const statusTag = x.status==="已回報"? '<span class="tag ok">已回報</span>' : '<span class="tag warn">待回報</span>';
      const diffTag = x.status!=="已回報" ? "—" : (x.diff===0? '<span class="tag ok">相符</span>' : '<span class="tag bad">'+x.diff+'</span>');
      const reportBtnLabel = x.status==="已回報" ? "編輯回報" : "填寫回報";
      return `<tr>
        <td>${esc(x.site)}</td>
        <td>${statusTag}</td>
        <td>${esc(x.date)}</td><td>${esc(x.vendor)}</td><td>${esc(x.applicant||"—")}</td>
        <td>${esc((x.types||[]).join("、"))}</td>
        <td>${esc(x.model||"—")}</td><td>${x.requiredQty}</td>
        <td>${x.status==="已回報"? x.actualHours : "—"}</td><td>${diffTag}</td>
        <td>${esc(x.signReturnDate||"—")}</td>
        <td>${esc(x.checker||"—")}</td>
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
   總覽 Dashboard（跨全部工地彙總 + 各工地列控總覽）
   ========================================================== */
function isThisMonth(dateStr){
  if(!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth();
}

function renderDashboard(){
  const labor = STATE.labor;
  const equip = STATE.equipment;

  const reportedThisMonth = labor.filter(r=>r.status==="已回報" && isThisMonth(r.reportedAt));
  const abnormal = reportedThisMonth.filter(r=>r.diff!==0);
  const laborPending = labor.filter(r=>r.status!=="已回報");
  const equipPending = equip.filter(x=>x.status!=="已回報");
  const pendingSign = labor.filter(r=>r.status==="已回報" && !r.signReturnDate);

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

  renderSiteBreakdown(labor, equip);

  const dueEl = document.getElementById("dueList");
  if(!pendingSign.length){
    dueEl.innerHTML = '<div class="empty-row">目前沒有待繳回的簽單</div>';
  }else{
    dueEl.innerHTML = pendingSign.slice(0,10).map(r=>`
      <div class="row-item">
        <span>${esc(r.site)}・${esc(r.date)}・${esc(r.vendor)}・${esc(r.engineer||"—")}</span>
        <span class="tag warn">尚未填寫簽單繳回日</span>
      </div>
    `).join("");
  }

  const recentEl = document.getElementById("recentAudits");
  const reported = labor.filter(r=>r.status==="已回報").sort((a,b)=>(b.reportedAt||"").localeCompare(a.reportedAt||""));
  if(!reported.length){
    recentEl.innerHTML = '<div class="empty-row">尚無出工回報紀錄</div>';
  }else{
    recentEl.innerHTML = reported.slice(0,8).map(r=>`
      <div class="row-item">
        <span>${esc(r.site)}・${esc(r.date)}・${esc(r.vendor)}・${esc(r.engineer||"—")}</span>
        <span>${r.diff===0? '<span class="tag ok">人數相符</span>' : '<span class="tag bad">差異'+r.diff+'</span>'}</span>
      </div>
    `).join("");
  }
}

function renderSiteBreakdown(labor, equip){
  const el = document.getElementById("siteBreakdown");
  const rows = STATE.config.sites.map(site=>{
    const l = labor.filter(r=>r.site===site);
    const e = equip.filter(x=>x.site===site);
    const lPending = l.filter(r=>r.status!=="已回報").length;
    const ePending = e.filter(x=>x.status!=="已回報").length;
    const reportedThisMonthSite = l.filter(r=>r.status==="已回報" && isThisMonth(r.reportedAt));
    const abnormalSite = reportedThisMonthSite.filter(r=>r.diff!==0).length;
    const pendingSignSite = l.filter(r=>r.status==="已回報" && !r.signReturnDate).length;
    const totalRecords = l.length + e.length;
    return {site, lPending, ePending, reportedCount:reportedThisMonthSite.length, abnormalSite, pendingSignSite, totalRecords};
  });

  el.innerHTML = `<table><thead><tr>
    <th>工地</th><th>點工待回報</th><th>機具待回報</th><th>本月出工回報</th><th>本月人數異常</th><th>簽單尚未繳回</th>
  </tr></thead><tbody>
    ${rows.map(r=>`
      <tr class="clickable" data-site="${esc(r.site)}">
        <td class="site-name-cell">${esc(r.site)}${r.totalRecords===0?'<span class="tag" style="margin-left:6px;background:#eef1f0;color:var(--ink-400);">尚無紀錄</span>':''}</td>
        <td>${r.lPending? '<span class="tag warn">'+r.lPending+'</span>' : '0'}</td>
        <td>${r.ePending? '<span class="tag warn">'+r.ePending+'</span>' : '0'}</td>
        <td>${r.reportedCount}</td>
        <td>${r.abnormalSite? '<span class="tag bad">'+r.abnormalSite+'</span>' : '0'}</td>
        <td>${r.pendingSignSite? '<span class="tag warn">'+r.pendingSignSite+'</span>' : '0'}</td>
      </tr>
    `).join("")}
  </tbody></table>`;

  el.querySelectorAll("tr[data-site]").forEach(tr=>{
    tr.addEventListener("click", ()=>{
      jumpToSite("labor", "laborListFilter", tr.dataset.site);
    });
  });
}

/* ==========================================================
   歷程報表 + CSV 匯出
   ========================================================== */
let currentReport = "labor";

function reportSiteMatch(site){ return reportSiteFilter===ALL_SITES || site===reportSiteFilter; }

const REPORT_DEFS = {
  labor: {
    title:"點工紀錄",
    headers:["工地","出工日期","廠商","需求工數","工作內容","工作地點","申請人","狀態","人臉紀錄","白卡紀錄","工具箱紀錄","簽單繳回日","簽單實際出工數","差異","簽單責任工程師","實際工作時數(白天)","實際加班時數(晚上)","根基自辦","廠商代辦","現場查核回饋"],
    rows: ()=>STATE.labor.filter(r=>reportSiteMatch(r.site)).map(r=>[
      r.site, r.date, r.vendor, r.required, (r.categories||[]).join("、")+(r.categoryNote?"・"+r.categoryNote:""),
      (r.locations||[]).join("、"), r.applicant, r.status,
      r.checkFace?"V":"", r.checkCard?"V":"", r.checkToolbox?"V":"",
      r.signReturnDate||"", r.status==="已回報"?r.actual:"", r.status==="已回報"?r.diff:"",
      r.engineer, r.dayHours, r.nightHours, r.selfDone, r.vendorDone, r.conclusion
    ])
  },
  equipment: {
    title:"機具紀錄",
    headers:["工地","出工日期","機具廠商","機具類型","型號","工作內容","工作地點","責任廠商","預計使用時數(需求數量)","申請人","狀態","簽單繳回日","機具實際工作使用時數","差異","簽單責任工程師","根基自辦","廠商代辦"],
    rows: ()=>STATE.equipment.filter(x=>reportSiteMatch(x.site)).map(x=>[
      x.site, x.date, x.vendor, (x.types||[]).join("、"), x.model, x.content,
      (x.locations||[]).join("、"), x.vendor, x.requiredQty, x.applicant, x.status,
      x.signReturnDate||"", x.status==="已回報"?x.actualHours:"", x.status==="已回報"?x.diff:"",
      x.checker, x.selfDone, x.vendorDone
    ])
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
  if(!rows.length){ el.innerHTML = '<div class="empty-row">篩選條件下尚無「'+esc(def.title)+'」資料</div>'; return; }
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
  const siteLabel = reportSiteFilter===ALL_SITES ? "全部工地" : reportSiteFilter;
  a.download = `${siteLabel}_${def.title}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("CSV 已匯出");
}

/* ==========================================================
   設定
   ========================================================== */
function initSettings(){
  const map = {
    cfg_sites:"sites", cfg_vendors:"vendors", cfg_locations:"locations",
    cfg_categories:"categories", cfg_equipTypes:"equipTypes", cfg_people:"people"
  };
  Object.entries(map).forEach(([id,key])=>{
    document.getElementById(id).value = STATE.config[key].join("\n");
  });

  document.getElementById("saveSettings").addEventListener("click", ()=>{
    Object.entries(map).forEach(([id,key])=>{
      const lines = document.getElementById(id).value.split("\n").map(s=>s.trim()).filter(Boolean);
      if(lines.length) STATE.config[key] = lines;
    });
    save();
    renderOptionLists();
    renderAll();
    toast("設定已儲存");
  });

  document.getElementById("resetSettings").addEventListener("click", ()=>{
    if(!confirm("確定要還原所有清單為預設值嗎？")) return;
    STATE.config = structuredClone(DEFAULT_CONFIG);
    save();
    Object.entries(map).forEach(([id,key])=>{
      document.getElementById(id).value = STATE.config[key].join("\n");
    });
    renderOptionLists();
    renderAll();
    toast("已還原預設值");
  });

  document.getElementById("clearAllData").addEventListener("click", ()=>{
    if(!confirm("確定要清空所有紀錄嗎？此操作無法復原。")) return;
    STATE = seedSampleData();
    save();
    location.reload();
  });
}

/* ---------------- render everything ---------------- */
function renderAll(){
  renderOptionLists();
  renderLaborList();
  renderEquipList();
  renderDashboard();
  renderReport(currentReport);
}

/* ---------------- init ---------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  initTabs();
  initSubTabs();
  initAddNewOptionHandler();
  initTagRemoveHandler();
  renderOptionLists();
  initSiteFilters();
  ["l_locations","l_categories","e_locations","e_type"].forEach(initTagPicker);
  setStepper();
  initLaborApplyForm();
  initLaborReportForm();
  initEquipApplyForm();
  initEquipReportForm();
  initReportTabs();
  initSettings();
  renderAll();
});
