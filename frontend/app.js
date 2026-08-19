/* ==========================================================
   點工機具稽核系統 - 前端（雲端共用資料庫版；版本沿革見 CHANGELOG.md）

   v8 重點：
   1. 資料改存雲端共用資料庫（Netlify Functions + Blobs，
      API：/api/data）——所有使用者讀寫同一份資料，任何人的
      填報其他人重新整理後都看得到；不再使用 localStorage 存
      業務資料（僅 sessionStorage 記住本分頁的工地與管理員狀態）。
   2. 填錯工地防呆（三道）：
      a. 每次開啟頁面必須先在攔截頁明確選定工地
      b. 申請/回報表單面板常駐醒目的目前工地徽章
      c. 送出「申請」前彈出工地確認視窗
   3. 同筆紀錄並發編輯以版本檢查保護（baseV/409，v9 起；v18 起 baseV＝開表單當下快照）；
      不同紀錄互不影響（每筆獨立儲存）。

   注意：以下 GENERIC_CONFIG 僅為範例佔位資料。實際名單由
   config.local.js 提供（地端手動放置；Netlify 部署時由環境
   變數 LOCAL_CONFIG_JS 於建置時產生），不進入程式碼庫。
   ========================================================== */

/* ==========================================================
   計價呈現開關（v23.1）

   ⚠ 這是**畫面層**的開關，不是功能移除。費率書、費率綁定、金額計算、
     SQL 的費率三張表、地端 .NET 的對應實作**全部原樣保留**——
     把這個常數改成 true，整組計價就完整回來，不需要重寫。

   關掉時隱藏：設定頁的行情通報匯入與綁定、機具回報的計價品項下拉、
     明細報表與計價彙總的「計價金額／計價組成／未能計價單數」欄、
     兩張廠商排行榜的金額欄。

   **刻意保留：代辦扣抵金額**（合約 §4.10）。代付代扣是會議點名要
     「由系統自動統計、排除人工作業」的項目，把它一起關掉等於白做。
     它靠的是已匯入的費率書——費率書存在後端（rates: 鍵），不因為
     匯入入口隱藏而消失，所以照算。

   ⚠ **換季要匯入新費率時，必須先把這個開關打開**——匯入入口也在這組裡面。

   ⚠ **宣告必須留在檔案最前面**：REPORTS 的欄位陣列是 top-level 物件字面值，
     載入當下就會讀這個常數。放到後面會踩 const 的暫時性死區（TDZ），
     整支 app.js 在載入階段就中斷——2026-08-13 就是這樣壞過一次。
   ========================================================== */
const PRICING_UI = false;

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
/* sessionStorage 存取一律走這三個 wrapper：Safari 無痕／封鎖 Cookie 時
   原生 API 會丟 SecurityError，未攔截會讓開站流程整段中斷（畫面卡在
   載入中或空白）。**新增存取點請勿直接呼叫 sessionStorage。** */
function ssSet(k, v){ try{ sessionStorage.setItem(k, v); }catch(e){} }
function ssGet(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } }
function ssDel(k){ try{ sessionStorage.removeItem(k); }catch(e){} }
/* 以「本地時區」取日期字串——toISOString 是 UTC，台灣早上 8 點前
   會被記成前一天，直接影響按月計價的歸屬 */
function localDate(d = new Date()){
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
/* 顯示用數字：最多 4 位小數、去尾零。
   ⚠ 原本是 2 位小數，但工數自 v24 起可由「實際工作時數÷8」換算而來
   （例：5 小時＝0.625 工），2 位小數會顯示成 0.63——畫面與匯出的數字
   加總不回來，成本部對帳就會對不上。與排名的 fmtRank 統一為 4 位。 */
function fmt(n){ return String(+(Number(n)||0).toFixed(4)); }

/* 工數 ⇄ 時數：一工＝8 小時。
   這不是新發明的口徑——排名早就用「加班時數÷8」折算工數（v21.3），
   本工沿用同一基準只是把口徑補齊。
   **只存工數**，時數是它的另一種檢視（work×8 完全可逆），故資料結構不動。 */
const WORK_HOURS_PER_UNIT = 8;
const hoursToWork = h => +(((Number(h) || 0) / WORK_HOURS_PER_UNIT).toFixed(4));
const workToHours = w => +(((Number(w) || 0) * WORK_HOURS_PER_UNIT).toFixed(4));

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

/* v23.2：一併送管理員部門白名單（合約 §3.1）。
   ⚠ 只有在本機確實載入過 master.adminDepartments 時才送——沒載到就省略，
     讓後端保留既有值。若無條件送 `|| []`，任何一次存設定都會把它清空。 */
const apiSaveMaster = () => api("POST", Object.assign(
  { op:"master", sites: MASTER.sites },
  Array.isArray(MASTER.adminDepartments) ? { adminDepartments: MASTER.adminDepartments } : {}
));
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
  // v17.1：各工地名單一律自建，不再自動補預設工種（原 v11 相容邏輯移除）；
  // 僅確保欄位存在為陣列，避免舊資料缺鍵造成 render 出錯
  if(store.config && !Array.isArray(store.config.laborTypes)) store.config.laborTypes = [];
}

/* 各工地獨立管理名單（v17／v17.1）：新建工地一律不帶任何種子名單——
   分包商、工程師、工作地點、工作內容、機具類型、工種全部由該工地自行建立，
   確保 A 站建立的選項不會出現在 B 站。使用者可於表單「＋新增選項」或
   設定頁批次貼上建立。 */
function defaultSiteConfig(){
  return {
    vendors: [],
    locations: [],
    categories: [],
    equipTypes: [],
    people: [],
    workers: [],
    laborTypes: [],
    lockDate: ""
  };
}
function cur(){ return SITE_CACHE[MASTER.currentSite]; }

/* 單據的「有效廠商」（v22.6）——**清單/報表/彙總/稽核的唯一權威，勿各自實作**。
   機具是工地統一叫車再配車，申請當下不知道是哪家，所以廠商改由回報填；
   舊機具單的廠商在申請層，故回報沒填時回頭取申請層的值。
   合約 §4.4：有效廠商 ＝ report.vendor || vendor。
   點工的 report 不存在 vendor 欄位，一律落到 r.vendor，因此兩種單據可共用本函式。 */
function recVendor(r){
  return (r && r.report && r.report.vendor) || (r && r.vendor) || "";
}

/* ==========================================================
   共用表格工具：固定欄寬（v22.3 報表起用，v22.4 起清單頁共用）
   ==========================================================
   問題：全域 `th,td{white-space:nowrap}`（style.css）讓任何一筆長字串——最典型是
   「現場查核回饋」——把該格撐成一整列文字。桌機的 .table-wrap 是 overflow:visible
   （v16.1 為了讓表頭黏在頁籤下方而改），所以被撐開的是**整頁**而非表格內捲軸；
   而 table-layout:auto 下欄寬由「當頁最長那筆」決定，**翻頁時整個版面會跳**。
   實測點工明細曾達 4,525px、單欄查核回饋 1,748px。

   做法：table-layout:fixed ＋ <colgroup> 逐欄指定寬度（與排名表 v19.4 同一招）。
   欄寬只由 COL_W 決定，與資料無關，翻頁／換工地都是同一個版面。

   ⚠ 三個必要配套，缺一都會被使用者看見：
   1. 不能只在 td 設 max-width——auto 版面下那只是建議值，nowrap 的 min-content 照樣撐開。
   2. fixed 下欄寬不再自動長大，所以 .fixed-table 的 th/td 必須**全部**允許換行
      （見 style.css）；留任何一欄 nowrap，超寬內容會直接壓到隔壁欄上。
   3. 表格必須自帶總寬——width 為 auto 時 Chrome 會把 <col> 的 px 當成「比例」
      去縮放可用寬度（實測 26 欄被壓成每欄 34px、單列高 2,569px）。
      窄畫面（<901px）由 .table-wrap 的橫向捲軸吸收。

   欄寬對照走**表頭字串**，欄序調整時不必同步索引；未列出的欄位用 DEFAULT_COL_W。
   新增欄位若是自由文字，記得在這裡給寬度，否則會吃到 90px 的預設值而折得很碎。 */
const DEFAULT_COL_W = 90;
const COL_W = new Map([
  /* 日期：實測「2026-08-02」要 118px 才不會斷成兩行（欄寬含左右各 10px 內距） */
  ["出工日期",120], ["簽單繳回日",120], ["日期",120], ["稽核日期",150],
  /* 自由文字：字多，給足寬度讓它折成幾行就好 */
  ["現場查核回饋",220], ["出工明細(工種)",150], ["機具使用明細",150],
  ["工作內容",120], ["實際工作內容",180], ["申請備註",150],
  ["工作地點",120], ["機具類型",110], ["類型",110],
  ["根基自辦備註",100], ["廠商代辦備註",100], ["代辦明細(廠商)",190],
  ["廠商",110], ["分包商",110], ["機具廠商",110], ["責任廠商",110], ["型號",120],
  ["期間",110], ["工地",180], ["查核結果",100],
  /* 人名不折行：三字姓名 ＋ 少數四字，給 90 */
  ["申請人",90], ["簽單責任工程師",90], ["稽核人",90], ["稽核人員",90], ["狀態",78],
  /* 數值/記號：內容只有個位數或一個 V／tag，寬度由表頭決定——表頭折行後 2～3 字一行即可 */
  ["需求工數",62], ["需求數量",62], ["人臉紀錄",62], ["白卡紀錄",62], ["工具箱紀錄",62],
  ["0工確認",62], ["0使用確認",62], ["差異",68], ["申請",62], ["實點",62],
  ["簽單實際出工數",68], ["機具實際工作使用時數",78],
  ["需求數量(台)",62], ["預定使用時數",68], ["出工天數",62],
  ["加班時數",62], ["加班時數(前2小時)",68], ["加班時數(第3小時起)",68], ["加班總時數",62],
  ["根基自辦工數",62], ["根基自辦時數",62], ["廠商代辦工數",62], ["廠商代辦時數",62],
  ["已回報單數",62], ["0工單數",62], ["0使用單數",62],
  ["總出工數",62], ["總實際使用時數",68], ["總出工天數",62], ["總加班時數",62],
  /* v22.8 行情通報 */
  ["計價金額",96], ["計價組成",220], ["未能計價單數",68], ["計價品項",180], ["加班費率品項",180],
  /* 操作欄：內含按鈕，寬度要能整排放下，不足會擠成兩行。
     實測「編輯申請／編輯回報／刪除」整排需 255px，取 260 留餘裕；
     按鈕數或字數不同的表（如稽核紀錄）以 fixedTableOpen 的 opts.actionW 覆蓋。 */
  ["操作",260]
]);
/* 儲存格文字 → HTML。說明欄位若是自動列點的結果（1. 2. …），逐點包成區塊並做
   懸掛縮排，折行才不會跑到編號正下方；非列點文字原樣輸出，換行交給 pre-line。
   ⚠ 一律經 esc()——這是唯一把資料寫進 DOM 的路徑。 */
const LIST_TEXT = /(^|\n)\s*\d+[.、)]\s/;
function cellHTML(v){
  const s = v === undefined || v === null ? "" : String(v);
  if(!LIST_TEXT.test(s)) return esc(s);
  return s.split("\n").map(l=>`<div class="li">${esc(l)}</div>`).join("");
}

/* 產生 <table>＋<colgroup>＋<thead>，呼叫端只需接自己的 <tbody>。
   表頭與欄寬同一份來源，不會各改各的而對不起來。
   opts.actionCols：該表「操作」欄實際需要的寬度（按鈕數量不同時覆蓋預設 240）。 */
function fixedTableOpen(headers, opts={}){
  const ws = headers.map(h=>
    (h === "操作" && opts.actionW) || COL_W.get(h) || DEFAULT_COL_W);
  const cols = ws.map(w=>`<col style="width:${w}px">`).join("");
  return `<table class="fixed-table" style="width:${ws.reduce((a,b)=>a+b,0)}px">`
    + `<colgroup>${cols}</colgroup>`
    + `<thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead>`;
}

/* ==========================================================
   說明文字的自動列點（v22.5）
   ==========================================================
   現場查核回饋等說明欄位常一次寫好幾件事，擠成一段很難讀。做法是讓填寫者
   自己起「1.」，按 Enter 就自動接下一號，存下來的仍是純文字（每點一行），
   顯示端靠 CSS white-space:pre-line 還原成條列。

   刻意做成可預期的純文字，不做 rich text：
   - 只有「本行是編號行且有內容」按 Enter 才接號；一般文字照常換行
   - 空的編號行按 Enter ＝結束列點，把該行編號清掉（否則會一直長號碼）
   - 每次都重新編號：連續編號行算同一組，遇到非編號行（含空行）重新從 1 起算，
     所以中間插一行也會自動順下去
   - 接受 `1.` `1、` `1)` 三種起手式，一律正規化成 `1. `
   - **中文輸入法組字中（isComposing）不介入**——否則選字用的 Enter 會被吃掉

   ⚠ 不套用於設定頁名單池（cfg_*）：那是「一行一個名稱」，加編號會直接毀掉名單。
   ⚠ 不套用於工作內容補充（l_categoryNote）：那是接在工作內容後面用「・」串接的
     短後綴，換行會讓報表該欄變成兩段。 */
const NUM_LINE = /^(\d+)[.、)]\s?(.*)$/;

/* 重新編號並換算游標位置。位數變動（9.→10.）時直接沿用舊游標會跳格，
   所以逐行累計長度差；只有游標已越過本行編號時才算進位移。 */
function renumberLines(text, caret){
  const lines = text.split("\n");
  const out = [];
  let n = 0, pos = 0, delta = 0;
  for(const line of lines){
    const m = NUM_LINE.exec(line);
    let rebuilt;
    if(m){ n++; rebuilt = n + ". " + m[2]; }
    else { n = 0; rebuilt = line; }
    out.push(rebuilt);
    const d = rebuilt.length - line.length;
    const lineEnd = pos + line.length;
    if(caret > lineEnd) delta += d;                                  // 游標在本行之後
    else if(m && caret >= pos && caret >= lineEnd - m[2].length) delta += d;   // 在本行、且已越過編號
    pos = lineEnd + 1;
  }
  return { text: out.join("\n"), caret: Math.max(0, caret + delta) };
}

/* 行數變多時把 textarea 撐高（上限交給 CSS max-height），
   不然列到第四點就要在三行高的框裡捲動。
   ⚠ 面板收合／頁籤未切換時元素沒有版面，scrollHeight 是 0，照設會把欄位壓成
   高度 0 且不會自己恢復——所以量不到就直接不動它，等顯示後再由呼叫端補叫。 */
function autoGrow(ta){
  if(ta.offsetParent === null) return;
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

/* 以程式改寫 .value（載入既有單、清空表單）不會觸發 input 事件，
   高度會卡在改寫前的行數——這些地方要補叫一次 */
function refreshAutoGrow(root){
  (root || document).querySelectorAll("textarea[data-autonum]").forEach(autoGrow);
}

function initAutoNumber(ta){
  if(!ta || ta.dataset.autonum) return;    // 稽核表單會重複渲染，避免重複掛監聽
  ta.dataset.autonum = "1";
  const apply = (text, caret)=>{
    ta.value = text;
    ta.setSelectionRange(caret, caret);
    // 補派 input 事件：稽核不符原因靠 input 監聽回寫 auditItemState，
    // 直接改 .value 不會觸發，漏掉這行會存到舊值
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  ta.addEventListener("keydown", e=>{
    if(e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if(ta.selectionStart !== ta.selectionEnd) return;    // 有選取範圍時不介入
    const v = ta.value, pos = ta.selectionStart;
    const ls = v.lastIndexOf("\n", pos - 1) + 1;
    const m = NUM_LINE.exec(v.slice(ls, pos));
    if(!m) return;
    e.preventDefault();
    if(!m[2].trim()){ apply(v.slice(0, ls) + v.slice(pos), ls); return; }   // 空編號行 → 收掉
    const ins = "\n" + (Number(m[1]) + 1) + ". ";
    const r = renumberLines(v.slice(0, pos) + ins + v.slice(pos), pos + ins.length);
    apply(r.text, r.caret);
  });
  /* 離開欄位時整理一次：貼上、手動刪行之後號碼會斷，統一在這裡補正 */
  ta.addEventListener("blur", ()=>{
    const r = renumberLines(ta.value, ta.selectionStart);
    if(r.text !== ta.value) apply(r.text, r.caret);
  });
  ta.addEventListener("input", ()=>autoGrow(ta));
  autoGrow(ta);
}

/* ==========================================================
   日期防呆（v22.7）—— 點工與機具兩張回報表單共用，改規則只改這裡
   ==========================================================
   兩條都是硬性擋下，因為這兩個欄位最容易被拿來製造「有按時出工／按時繳回」的假象：

   1. **回報日不得早於出工日**：回報是「這天實際做了什麼」的紀錄，
      出工日還沒到就先回報，紀錄本身沒有意義。`reportedAt` 由系統以當天日期寫入，
      所以擋的方式是「出工日晚於今天就不讓回報」。
   2. **簽單繳回日必須落在 出工日 ～ 出工日＋20 天**：
      早於出工日不可能；晚於 20 天則視為逾期，不予採計（避免無限拖延）。
      繳回日可以是未來日期（簽單還沒收回來就先預定），只要在 20 天內。 */
const SIGN_RETURN_MAX_DAYS = 20;

/* 日期字串加減天數。用 "T00:00:00" 解析成**本地**時間——
   直接 new Date("2026-08-05") 會被當成 UTC，在 UTC+8 會退成前一天（計價紅線 2）。 */
function addDays(dateStr, n){
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return localDate(d);
}

/* 回報時機檢查：出工日還沒到就不能回報。回傳錯誤訊息或 null */
function reportTimingError(workDate){
  if(!workDate) return null;
  const today = localDate();
  if(workDate > today){
    return `出工日期（${workDate}）還沒到，無法回報——回報必須在出工當天或之後`;
  }
  return null;
}

/* 簽單繳回日檢查：必須落在 出工日 ～ 出工日＋20 天。回傳錯誤訊息或 null */
function signReturnError(signDate, workDate){
  if(!signDate || !workDate) return null;
  if(signDate < workDate){
    return `簽單繳回日（${signDate}）早於出工日期（${workDate}）——簽單不可能在出工前繳回，請確認日期`;
  }
  const deadline = addDays(workDate, SIGN_RETURN_MAX_DAYS);
  if(signDate > deadline){
    return `簽單繳回日（${signDate}）已超過出工日後 ${SIGN_RETURN_MAX_DAYS} 天的期限（最晚 ${deadline}），逾期不予採計`;
  }
  return null;
}

/* 開表單時把 min／max 掛上去，讓日期選擇器本身就選不到範圍外的日期——
   送出時的檢查是最後一道，不是唯一一道 */
function lockSignReturnRange(inputId, workDate){
  const el = document.getElementById(inputId);
  if(!el) return;
  if(workDate){
    el.min = workDate;
    el.max = addDays(workDate, SIGN_RETURN_MAX_DAYS);
  }else{
    el.removeAttribute("min");
    el.removeAttribute("max");
  }
}

/* 稽核以外的表單是否編輯中（點工/機具的申請與回報）。
   稽核選單/編輯前的 refetchSite 必須以此把關：整批刷新快取會讓這些表單
   送出時抓到漂移後的 v 當 baseV，繞過 409 併發保護（合約 §3.3 語意）。 */
function otherFormEditing(){
  return !!(editingLaborApplyId || editingLaborReportId || editingEquipApplyId || editingEquipReportId);
}
function anyEditing(){
  return otherFormEditing() || !!auditSelectedId;
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

    // v23.2：管理員部門白名單。先接住，apiSaveMaster() 才知道要不要送（見該函式註解）
    if(data.master && Array.isArray(data.master.adminDepartments))
      MASTER.adminDepartments = data.master.adminDepartments;

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

    const remembered = ssGet("dm_site");
    // 剛登出（含閒置逾時）這一輪一律停在選站畫面：否則單一工地時
    // v20 的自動進入會立刻把人放回站內，登出等同無效——權限上線後
    // 「可見工地只有一個」正是常態（AUTH-PLAN），這條不可省。
    // 旗標已由 initIdleLogout() 消費（它先於 boot 執行），故讀模組變數
    if(remembered && MASTER.sites.includes(remembered)){
      enterSite(remembered);
    }else if(MASTER.sites.length === 1 && !lastLogoutReason){
      enterSite(MASTER.sites[0]);   // v20：可見工地僅一個時免選直進（為未來 AD 權限過濾鋪路）
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
  ssSet("dm_site", site);
  READY = true;
  renderAll();
  switchMainTab("labor");   // v20：選定工地即進入點工頁開工，免再點一次（總覽仍在頁籤可隨時回）
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
    if(data.master && Array.isArray(data.master.adminDepartments))
      MASTER.adminDepartments = data.master.adminDepartments;   // v23.2
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
      ssSet("dm_site", MASTER.currentSite);
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
  ssSet("dm_site", site);
  resetLaborApplyForm();
  resetLaborReportForm();
  resetEquipApplyForm();
  resetEquipReportForm();
  resetAuditView();
  auditVendor = "";
  resetListFilters();   // v15：清單篩選屬於單一工地的檢視狀態，切站即重置
  renderAll();
  if(!silent) toast(`已切換至：${site}`);
  refreshData(true);
}
function renderSiteChips(){
  document.querySelectorAll("[data-site-chip]").forEach(el=>{
    el.textContent = "📍 " + (MASTER.currentSite || "");
  });
}

/* ---------------- 收合式表單面板（v15：表單太長回饋） ----------------
   四個申請/回報表單預設收合只留標題列；點標題展開/收回，
   「編輯申請/填寫回報」自動展開、送出或取消後自動收回 */
function expandPanel(id){ const p = document.getElementById(id); if(p) p.classList.remove("collapsed"); }
function collapsePanel(id){ const p = document.getElementById(id); if(p) p.classList.add("collapsed"); }
function initCollapsibles(){
  document.querySelectorAll(".panel.collapsible > .panel-head").forEach(head=>{
    head.addEventListener("click", e=>{
      if(e.target.closest("button, a, input, select, textarea")) return;   // 不攔表單元件
      head.parentElement.classList.toggle("collapsed");
    });
  });
}

/* ---------------- 清單篩選（v15：依日期/廠商找要覆核的單） ---------------- */
const listFilter = {
  labor: { date: "", vendor: "", applicant: "" },
  equipment: { date: "", vendor: "", applicant: "" }
};
/* v15.2：清單分頁（每頁 20 筆，取代 v15.1「顯示全部」展開——展開後仍是長頁面）。
   套用：點工清單、機具清單、稽核紀錄清單；篩選/切站自動回第 1 頁 */
const LIST_PAGE_SIZE = 10;   // v15.3：每頁 10 筆，配合放寬版面讓一頁清單盡量落在單一畫面內
const listPage = { labor: 1, equipment: 1, auditlog: 1, report: 1, ranking: 1 };
function resetListFilters(){
  listFilter.labor = { date: "", vendor: "" };
  listFilter.equipment = { date: "", vendor: "" };
  listPage.labor = 1;
  listPage.equipment = 1;
  listPage.auditlog = 1;
  listPage.report = 1;
  listPage.ranking = 1;
  ["laborListDate","equipListDate"].forEach(id=>{ const el = document.getElementById(id); if(el) el.value = ""; });
  ["laborListVendor","equipListVendor","laborListApplicant","equipListApplicant"]
    .forEach(id=>{ const el = document.getElementById(id); if(el) el.value = ""; });
}
/* 依 listPage[kind] 取當頁資料並產生頁碼列 HTML；unit＝總量的單位詞（排名報表分的是「個工種」不是「筆」） */
function paginate(kind, list, unit){
  const pages = Math.max(1, Math.ceil(list.length / LIST_PAGE_SIZE));
  if(listPage[kind] > pages) listPage[kind] = pages;
  if(listPage[kind] < 1) listPage[kind] = 1;
  const page = listPage[kind];
  const shown = list.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE);
  const pagerHTML = pages > 1 ? `<div class="list-pager">
      <button type="button" class="btn-mini pager-prev" data-kind="${kind}" ${page <= 1 ? "disabled" : ""}>‹ 上一頁</button>
      <span class="pager-info">第 ${page}／${pages} 頁（共 ${list.length} ${unit || "筆"}）</span>
      <button type="button" class="btn-mini pager-next" data-kind="${kind}" ${page >= pages ? "disabled" : ""}>下一頁 ›</button>
    </div>` : "";
  return { shown, pagerHTML };
}
function bindPager(el, kind, renderFn){
  el.querySelectorAll(".pager-prev, .pager-next").forEach(b => b.addEventListener("click", ()=>{
    listPage[kind] += b.classList.contains("pager-next") ? 1 : -1;
    renderFn();
    el.scrollTop = 0;   // 換頁後回到表頭
  }));
}
function initListFilter(kind, dateId, vendorId, clearId, renderFn, applicantId){
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if(el) el.addEventListener("change", e=>{ listFilter[kind][key] = e.target.value; listPage[kind] = 1; renderFn(); });
  };
  bind(dateId, "date"); bind(vendorId, "vendor"); bind(applicantId, "applicant");
  document.getElementById(clearId).addEventListener("click", ()=>{
    listFilter[kind] = { date: "", vendor: "", applicant: "" };
    listPage[kind] = 1;
    [dateId, vendorId, applicantId].forEach(id=>{
      const el = document.getElementById(id); if(el) el.value = "";
    });
    renderFn();
  });
}
/* 廠商下拉選項由該類紀錄實際值彙集；回傳套用篩選後的清單與計數文字 */
/* 下拉選項一律由「目前清單實際出現過的值」動態組出，不用名單池——
   名單池會列出全站所有人，但清單裡多半只有少數幾位，選了沒資料的等於空篩。
   選中的值若已不在清單中（例如又改了日期），自動退回「全部」而不是留著空篩。 */
function fillFilterSelect(selId, values, allLabel, current){
  const sel = document.getElementById(selId);
  if(!sel) return current;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>`
    + values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  if(values.includes(current)){ sel.value = current; return current; }
  sel.value = ""; return "";
}

function applyListFilter(kind, all, vendorSelId, countId, applicantSelId){
  const f = listFilter[kind];
  const uniq = arr => [...new Set(arr.filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));

  f.vendor = fillFilterSelect(vendorSelId, uniq(all.map(recVendor)), "全部廠商", f.vendor);
  /* 申請人篩選（現場回饋）：多位工程師常同時向同一家廠商叫工，
     只篩廠商還要再從一堆單裡找自己的名字。 */
  f.applicant = fillFilterSelect(applicantSelId, uniq(all.map(r=>r.applicant)), "全部申請人", f.applicant);

  const list = all.filter(r=>
    (!f.date || r.date === f.date)
    && (!f.vendor || recVendor(r) === f.vendor)
    && (!f.applicant || r.applicant === f.applicant));
  const cnt = document.getElementById(countId);
  const filtering = f.date || f.vendor || f.applicant;
  if(cnt) cnt.textContent = filtering ? `符合 ${list.length}／共 ${all.length} 筆` : `共 ${all.length} 筆`;
  return list;
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

/* 單一人名規則（v15.1）：人員池選項不得含任何多人並列分隔符——
   從「新增選項」源頭堵住「XXX/XXX」進入名單（送出驗證為第二道防線） */
const MULTI_NAME_RE = /[+＋/／\\、,，;；:：\s]/;

function addPoolOption(pool, v){
  if(pool === "people" && MULTI_NAME_RE.test(v)){
    toast("人員名單僅能逐一新增單一人名（請勿以「/」等符號並列多人）");
    return;
  }
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
let editingLaborApplyBaseV = 0;   // v18：開表單當下的版本快照（送出以此為 baseV）


/* ==========================================================
   樂觀渲染（v18）：點「編輯/填寫回報」先以快取即時開表單（免等 1–3 秒
   網路往返），再於背景抓最新版校正。
   併發安全：表單開啟當下即快照 baseV，送出一律以該快照為準
   （合約 §3.3「baseV＝前端載入當下的版本」），因此背景刷新不會讓
   版本號漂移而繞過 409——他人若已改過，送出時仍會正確衝突。
   ========================================================== */
let bgVerifySeq = 0;
function bgRefetchVerify(kind, id, baseV, stillEditing, onGone){
  // 稽核表單編輯中不整批刷新：saveAudit/deleteAudit 送出時讀快取即時 v，
  // 刷新會讓其 baseV 漂移繞過 409（對稱於稽核側以 otherFormEditing 把關）。
  // 跳過只是少了背景校正提示，本表單送出仍有自身快照的 409 保護。
  if(auditSelectedId) return;
  const seq = ++bgVerifySeq;
  refetchSite(MASTER.currentSite).then(()=>{
    if(seq !== bgVerifySeq || !stillEditing()) return;   // 使用者已切走，放棄
    const list = kind === "labor" ? cur().labor : cur().equipment;
    const fresh = list.find(r=>r.id===id);
    if(!fresh){ toast("⚠ 此單剛被其他人刪除，請重新選擇"); onGone(); return; }
    if((fresh.v || 0) !== baseV){
      toast("⚠ 此單剛被其他人更新；您填寫的內容已保留，送出時若衝突系統會提示重填");
    }
    renderLaborList(); renderEquipList();
  }).catch(()=>{ /* 網路失敗：維持快取內容，送出時仍有 409 保護 */ });
}

function initLaborApplyForm(){
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("laborApplyNewBtn").addEventListener("click", resetLaborApplyForm);
  initAttBox(laborAtt, "l_attachBox", "l_attachInput");

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

    // v14：先上傳新附件（失敗即中止、輸入保留可重試），再組單據
    let attachments;
    try{
      attachments = await attUploadPending(laborAtt);
    }catch(err){
      toast("⚠ 附件上傳失敗，資料未送出，請檢查網路後再按一次送出");
      return;
    }

    const rec = {
      id: editingLaborApplyId || uid(),
      date, vendor, applicant, required,
      workers: existing ? (existing.workers || []) : [],   // v11：申請不再填人員名單（工程師不會知道點工姓名）；保留舊單資料
      locations: tagState.l_locations.slice(),
      categories: tagState.l_categories.slice(),
      categoryNote: document.getElementById("l_categoryNote").value.trim(),
      attachments,
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null,
      audits: existing ? (existing.audits || []) : []
    };

    try{
      const resp = await apiSaveRecord("labor", rec, existing ? editingLaborApplyBaseV : 0);   // v18：編輯時以開表單快照為 baseV
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
    attFinalize(laborAtt);   // 儲存成功後才真正刪除被移除的附件
    resetLaborApplyForm();
    collapsePanel("laborApplyPanel");   // v15：送出後收回表單，清單一目了然
    renderDashboard();
  });

  resetLaborApplyForm();
}

function resetLaborApplyForm(){
  editingLaborApplyId = null;
  editingLaborApplyBaseV = 0;
  document.getElementById("laborApplyForm").reset();
  document.getElementById("l_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("l_required").value = 0;
  setCombo("cb_l_vendor", "");
  setCombo("cb_l_applicant", "");
  setTags("l_locations", []);
  setTags("l_categories", []);
  resetAttState(laborAtt, "l_attachBox");
  document.getElementById("laborApplyTitle").textContent = "新增點工申請";
  document.getElementById("laborApplySubmitBtn").textContent = "送出點工申請";
  document.getElementById("laborApplyNewBtn").style.display = "none";
  if(READY) renderLaborList();
}

async function loadLaborApplyRecord(id){
  // v18 樂觀渲染：優先用快取立即開表單；快取沒有才等待網路
  let rec = cur().labor.find(r=>r.id===id);
  if(!rec){
    if(auditSelectedId){ toast("稽核表單編輯中，請先儲存或取消稽核再操作"); return; }   // 同 bgRefetchVerify 守衛
    try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
    rec = cur().labor.find(r=>r.id===id);
  }
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderLaborList(); return; }
  editingLaborApplyId = id;
  editingLaborApplyBaseV = rec.v || 0;   // v18：版本快照，送出以此為 baseV

  document.getElementById("l_date").value = rec.date;
  setCombo("cb_l_vendor", rec.vendor);
  setCombo("cb_l_applicant", rec.applicant);
  document.getElementById("l_required").value = rec.required;
  setTags("l_locations", rec.locations);
  setTags("l_categories", rec.categories);
  document.getElementById("l_categoryNote").value = rec.categoryNote || "";
  resetAttState(laborAtt);
  laborAtt.existing = (rec.attachments || []).slice();
  renderAttBox(laborAtt, "l_attachBox");

  document.getElementById("laborApplyTitle").textContent = `編輯點工申請：${rec.date}・${rec.vendor}`;
  document.getElementById("laborApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("laborApplyNewBtn").style.display = "";

  expandPanel("laborApplyPanel");
  switchSubTab("tab-labor", "labor-apply");
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});

  // v18：表單已即時開啟，於背景抓最新版校正（不擋畫面）
  bgRefetchVerify("labor", id, editingLaborApplyBaseV, ()=>editingLaborApplyId === id, ()=>{ resetLaborApplyForm(); collapsePanel("laborApplyPanel"); });
}

/* ==========================================================
   點工 — 回報覆核（子層）
   ========================================================== */
let editingLaborReportId = null;
let editingLaborReportBaseV = 0;
let typeState = [];   // v11：逐工種覆核列 [{type, work, ot2, otOver}]

/* ==========================================================
   代辦（v23，合約 §4.10）：一張單可代辦多家廠商。
   代辦＝向**本單廠商**叫的工／機具，但成本歸屬另一家廠商，計價時扣回。
   v22 以前只有「代辦工數／時數／備註」三欄，責任歸屬廠商埋在自由文字備註裡
   （例「○○公司扣2工，扣款4200」）——無法自動統計，正是要消除的人工作業。
   ⚠ 點工的代辦列限本單已填的工種：代扣要用「本單廠商＋該工種」查費率，
     工種對不上就沒有費率依據。
   ========================================================== */
let agentState = [];        // 點工代辦列 [{vendor, type, work, ot2, otOver, note}]
let equipAgentState = [];   // 機具代辦列 [{vendor, qty, note}]

/* 數字欄位取值：空白回 null（與 0 區分），其餘轉數字 */
function numFieldVal(id){
  const v = document.getElementById(id).value.trim();
  return v === "" ? null : (parseFloat(v) || 0);
}
function setNumField(id, v){
  document.getElementById(id).value = (v === null || v === undefined) ? "" : v;
}

function initLaborReportForm(){
  document.getElementById("laborReportCancelBtn").addEventListener("click", ()=>{
    resetLaborReportForm();
    collapsePanel("laborReportPanel");   // v15：取消後收回表單
  });
  document.getElementById("l_actual").addEventListener("input", updateLaborDiff);
  document.getElementById("l_zeroWork").addEventListener("change", onZeroWorkToggle);

  const typeBox = document.getElementById("l_typeRows");
  typeBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i) || !typeState[i]) return;
    /* 出工數與實際時數是同一個值的兩種檢視——改一邊就同步另一邊。
       直接寫對方 input 的 value（不呼叫 renderTypeRows），否則重繪會讓游標跳掉。 */
    if(el.classList.contains("tr-work")){
      typeState[i].work = parseFloat(el.value)||0;
      const h = el.closest(".att-row").querySelector(".tr-hours");
      if(h) h.value = workToHours(typeState[i].work);
    }
    if(el.classList.contains("tr-hours")){
      typeState[i].work = hoursToWork(parseFloat(el.value)||0);
      const w = el.closest(".att-row").querySelector(".tr-work");
      if(w) w.value = typeState[i].work;
    }
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

  /* 代辦列（v23）。與逐工種列同一套事件委派寫法 */
  const agentBox = document.getElementById("l_agentRows");
  agentBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i) || !agentState[i]) return;
    if(el.classList.contains("ag-work")){
      agentState[i].work = parseFloat(el.value)||0;
      const h = el.closest(".att-row").querySelector(".ag-hours");
      if(h) h.value = workToHours(agentState[i].work);
    }
    if(el.classList.contains("ag-hours")){
      agentState[i].work = hoursToWork(parseFloat(el.value)||0);
      const w = el.closest(".att-row").querySelector(".ag-work");
      if(w) w.value = agentState[i].work;
    }
    if(el.classList.contains("ag-ot2")) agentState[i].ot2 = parseFloat(el.value)||0;
    if(el.classList.contains("ag-otover")) agentState[i].otOver = parseFloat(el.value)||0;
    if(el.classList.contains("ag-note-in")) agentState[i].note = el.value;
  });
  agentBox.addEventListener("click", e=>{
    const btn = e.target.closest(".att-remove");
    if(!btn) return;
    agentState.splice(parseInt(btn.dataset.i,10), 1);
    renderAgentRows();
  });
  document.getElementById("l_agentAddBtn").addEventListener("click", addAgentRow);

  document.getElementById("laborReportForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const store = cur();
    const rec = store.labor.find(r=>r.id===editingLaborReportId);
    if(!rec) return;

    const engineer = requireCombo("cb_l_engineer", "簽單責任工程師");
    if(engineer === null) return;
    // v15：回報覆核僅限一位工程師代表（申請可多人，回報統計要能歸到個人）
    if(MULTI_NAME_RE.test(engineer)){
      toast("簽單責任工程師僅限一位代表，請勿多人並列（申請可多人、回報限一人）");
      return;
    }
    if(engineer === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    const actual = parseFloat(document.getElementById("l_actual").value) || 0;
    const ot2Total = parseFloat(document.getElementById("l_ot2").value) || 0;
    const otOverTotal = parseFloat(document.getElementById("l_otOver").value) || 0;
    const totalOT = ot2Total + otOverTotal;
    const zeroWork = document.getElementById("l_zeroWork").checked;

    /* v24.1：「日間無出工、夜間才進場加班」是常見情形（現場簽單就長這樣）。
       這種單的出工數本來就是 0，但**有加班時數**——硬要使用者勾「0 工確認」，
       等於要他聲明「完全無人出工」，與事實不符，現場因此卡住送不出去。
       0 工確認的用意是攔「忘了填」，而加班時數就是「沒忘記填」的證據，
       所以只在**本工與加班都是 0** 時才硬性擋下；其餘走可確認的警告。 */
    const anyOT = ot2Total > 0 || otOverTotal > 0;
    if(actual === 0 && !zeroWork && !anyOT){
      toast("實際出工數與加班時數都是 0：若當日確實無人出工，請先勾選「0 工確認」再送出");
      return;
    }
    if(zeroWork && actual !== 0){
      toast("已勾選 0 工確認，但簽單實際出工數不為 0，請修正其中一項");
      return;
    }

    // v22.7：出工日還沒到不能回報；簽單繳回日須在 出工日～出工日+20 天
    const timingErr = reportTimingError(rec.date);
    if(timingErr){ toast(timingErr); return; }
    const signErr = signReturnError(document.getElementById("l_signReturnDate").value, rec.date);
    if(signErr){ toast(signErr); return; }

    /* v23：代辦列的檢查是**硬性擋下**（不是可確認的警告）——代辦超量會讓代扣金額
       大於我們實際付出去的錢，那是直接算錯帳，不能讓人按確認繞過去 */
    // 0 工單也可能只代扣加班時數——驗證一律執行；collectAgentErrors 本來就
    // 分開比對本工與兩段加班，不會誤擋
    const agentErrs = collectAgentErrors(typeState, agentState);
    if(agentErrs.length){ toast("代辦資料有誤，未送出：\n- " + agentErrs.join("\n- ")); return; }

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
        /* v24：0 工單保留工種（本工 0、加班照記）——工種是計價與排名的鍵，
           清空會讓夜間加班單對不到費率，也算不進該工種的排名 */
        workTypes: typeState.map(t=>({type:t.type, work: zeroWork ? 0 : (t.work||0), ot2:t.ot2||0, otOver:t.otOver||0})),
        attendance: (rec.report && rec.report.attendance) || [],
        actual, ot2Total, otOverTotal, totalOT,
        diff: actual - rec.required,
        zeroWork,
        signReturnDate: document.getElementById("l_signReturnDate").value,
        // v12：表單移除「根基自辦」（未填代辦即為自辦）；舊單既有自辦資料原樣承繼保留
        selfDoneWork: (rec.report && rec.report.selfDoneWork != null) ? rec.report.selfDoneWork : null,
        selfDoneHours: (rec.report && rec.report.selfDoneHours != null) ? rec.report.selfDoneHours : null,
        selfDoneNote: (rec.report && (rec.report.selfDoneNote || rec.report.selfDone)) || "",
        /* v23：表單移除「代辦三欄」，改逐筆 agentItems（合約 §4.10）。
           舊值與自辦同樣原樣承繼——新舊**不相加**，報表分兩欄呈現避免重複計算 */
        vendorDoneWork: (rec.report && rec.report.vendorDoneWork != null) ? rec.report.vendorDoneWork : null,
        vendorDoneHours: (rec.report && rec.report.vendorDoneHours != null) ? rec.report.vendorDoneHours : null,
        vendorDoneNote: (rec.report && (rec.report.vendorDoneNote || rec.report.vendorDone)) || "",
        agentItems: zeroWork ? [] : agentState.map(a=>({
          vendor: a.vendor, type: a.type,
          work: a.work || 0, ot2: a.ot2 || 0, otOver: a.otOver || 0, note: (a.note || "").trim()
        })),
        conclusion: document.getElementById("l_conclusion").value.trim()
      }
    });

    try{
      const resp = await apiSaveRecord("labor", updated, editingLaborReportBaseV);   // v18：以開表單快照為 baseV（合約 §3.3）
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
    collapsePanel("laborReportPanel");   // v15：送出後收回表單
    renderDashboard();
  });

  resetLaborReportForm();
}

function collectLaborWarnings(types, actual, ot2Total, otOverTotal, zeroWork){
  const w = [];
  if(zeroWork) return w;
  types.forEach(t=>{
    const tOT = (t.ot2 || 0) + (t.otOver || 0);
    if(!(t.work > 0) && !tOT) w.push(`${t.type}：已加入工種，但出工數與加班時數都是 0`);
    // 日間無出工、夜間加班：合法但少見，讓填報者再確認一次而不是直接擋下
    if(!(t.work > 0) && tOT) w.push(`${t.type}：本日無正常出工，僅有加班 ${fmt(tOT)} 小時（夜間進場）——請確認無誤`);
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
  fillAgentSelects();   // 代辦的工種下拉只列本單已填的工種，工種一變就要跟著重填
  if(!typeState.length){
    box.innerHTML = '<div class="empty-row">尚未加入工種——請在下方選擇工種（粗工／技術工／打石工⋯）逐工種記錄；若當日完全無人出工，勾選「0 工確認」</div>';
    return;
  }
  box.classList.toggle("disabled", zero);
  box.innerHTML = typeState.map((t,i)=>`
    <div class="att-row present">
      <span class="tr-name">${esc(t.type)}</span>
      <div class="att-fields">
        <label>出工數<input type="number" class="tr-work" data-i="${i}" step="any" min="0" value="${t.work}" ${zero?'disabled':''}></label>
        <label title="當日實際工作時數（不含休息）；系統以 8 小時＝1 工換算，與出工數雙向連動">實際時數<input type="number" class="tr-hours" data-i="${i}" step="0.5" min="0" value="${workToHours(t.work)}" ${zero?'disabled':''}></label>
        <label>加班·前2小時<input type="number" class="tr-ot2" data-i="${i}" step="0.5" min="0" value="${t.ot2}"></label>
        <label>加班·第3小時起<input type="number" class="tr-otover" data-i="${i}" step="0.5" min="0" value="${t.otOver}"></label>
      </div>
      <button type="button" class="att-remove" data-i="${i}" title="移除此工種">×</button>
    </div>`).join("");
}

/* ---- 代辦列（點工；v23，合約 §4.10） ---- */

function renderAgentRows(){
  const box = document.getElementById("l_agentRows");
  if(!box) return;
  const zero = document.getElementById("l_zeroWork").checked;
  box.classList.toggle("disabled", zero);
  if(!agentState.length){
    box.innerHTML = '<div class="empty-row">未填＝<strong>全數自辦</strong></div>';
    return;
  }
  box.innerHTML = agentState.map((a,i)=>`
    <div class="att-row present">
      <span class="tr-name">${esc(a.vendor)}<br><small>${esc(a.type)}</small></span>
      <div class="att-fields">
        <label>代辦工數<input type="number" class="ag-work" data-i="${i}" step="any" min="0" value="${a.work}" ${zero?"disabled":""}></label>
        <label title="只代扣幾小時的情形直接填時數；系統以 8 小時＝1 工換算，與代辦工數雙向連動">代辦時數<input type="number" class="ag-hours" data-i="${i}" step="0.5" min="0" value="${workToHours(a.work)}" ${zero?"disabled":""}></label>
        <label>加班·前2小時<input type="number" class="ag-ot2" data-i="${i}" step="0.5" min="0" value="${a.ot2}"></label>
        <label>加班·第3小時起<input type="number" class="ag-otover" data-i="${i}" step="0.5" min="0" value="${a.otOver}"></label>
        <label class="ag-note">代辦內容<input type="text" class="ag-note-in" data-i="${i}" value="${esc(a.note||"")}" placeholder="這家廠商來做了什麼（例：協助吊運鋼構）" ${zero?"disabled":""}></label>
      </div>
      <button type="button" class="att-remove" data-i="${i}" title="移除此代辦列">×</button>
    </div>`).join("");
}

/* 責任歸屬廠商的建議清單（v23.5）。
   ⚠ **必須可自由輸入，不能限制在名單池裡**——工地回饋：名單池裡是點工與機具廠商，
     但代扣的對象常是**施工廠商**，本來就不在那份名單。改用 datalist：
     打字不受限，同時把「名單池 ＋ 本站已用過的代辦廠商」列成建議，
     讓重複出現的廠商一次點選即可，避免同一家被打成好幾種寫法而拆成多列統計。 */
function agentVendorSuggestions(){
  const s = new Set((cur() && cur().config && cur().config.vendors) || []);
  const st = cur();
  if(st){
    ["labor","equipment"].forEach(kind=>{
      (st[kind] || []).forEach(r=>{
        ((r.report && r.report.agentItems) || []).forEach(a=>{
          if(a && a.vendor) s.add(a.vendor);
        });
      });
    });
  }
  // 也含「這張表單當下已加入但還沒存檔」的廠商——同一家要再加一個工種時可直接點選
  agentState.forEach(a=>{ if(a.vendor) s.add(a.vendor); });
  equipAgentState.forEach(a=>{ if(a.vendor) s.add(a.vendor); });
  return [...s].sort();
}

function fillDatalist(id, values){
  const dl = document.getElementById(id);
  if(dl) dl.innerHTML = values.map(v=>`<option value="${esc(v)}"></option>`).join("");
}

/* 工種**只列本單已填的工種**（合約 §4.10 的約束）——代扣要用該工種查費率。
   每次工種列變動都要重填，否則會選到已被移除的工種。 */
function fillAgentSelects(){
  const ts = document.getElementById("l_agentType");
  if(!ts) return;
  fillDatalist("l_agentVendorList", agentVendorSuggestions());
  const keepT = ts.value;
  ts.innerHTML = '<option value="">工種⋯</option>'
    + typeState.map(t=>`<option value="${esc(t.type)}">${esc(t.type)}</option>`).join("");
  ts.value = typeState.some(t=>t.type===keepT) ? keepT : "";
}

function addAgentRow(){
  if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
  const vEl = document.getElementById("l_agentVendor");
  const vendor = vEl.value.trim();   // v23.5：自由輸入，前後空白一律去掉（否則統計會拆成兩列）
  const type = document.getElementById("l_agentType").value;
  if(!vendor){ toast("請先填責任歸屬廠商"); return; }
  if(!type){
    toast(typeState.length ? "請選工種" : "請先在上方加入出工工種——代辦要歸屬到工種才查得到費率");
    return;
  }
  if(agentState.some(a=>a.vendor===vendor && a.type===type)){
    toast(`「${vendor}／${type}」已在代辦清單中，請直接修改該列數字`); return;
  }
  agentState.push({ vendor, type, work:0, ot2:0, otOver:0, note:"" });
  vEl.value = "";                    // 清空以便連續加下一家
  fillAgentSelects();                // 新廠商即刻進入建議清單
  renderAgentRows();
}

/* 代辦量不可超過該工種的回報量——代辦是回報量的**一部分**，不是額外量（合約 §4.10）。
   回傳擋下的訊息陣列（空陣列＝通過）。這是硬性擋下，不是可確認的警告：
   代辦超量會讓代扣金額大於實際付出的錢，直接算錯帳。 */
function collectAgentErrors(types, agents){
  const errs = [];
  const byType = new Map(types.map(t=>[t.type, t]));
  const sums = new Map();
  agents.forEach(a=>{
    const s = sums.get(a.type) || { work:0, ot2:0, otOver:0 };
    s.work += a.work||0; s.ot2 += a.ot2||0; s.otOver += a.otOver||0;
    sums.set(a.type, s);
  });
  sums.forEach((s, type)=>{
    const t = byType.get(type);
    if(!t){ errs.push(`代辦的工種「${type}」不在本單的出工工種中——請先加入該工種，或移除該代辦列`); return; }
    if(s.work > (t.work||0)) errs.push(`「${type}」代辦工數合計 ${fmt(s.work)} 工，超過回報的 ${fmt(t.work)} 工`);
    if(s.ot2 > (t.ot2||0)) errs.push(`「${type}」代辦加班(前2h)合計 ${fmt(s.ot2)} 小時，超過回報的 ${fmt(t.ot2)} 小時`);
    if(s.otOver > (t.otOver||0)) errs.push(`「${type}」代辦加班(3h起)合計 ${fmt(s.otOver)} 小時，超過回報的 ${fmt(t.otOver)} 小時`);
  });
  agents.forEach(a=>{
    if(!(a.work>0 || a.ot2>0 || a.otOver>0))
      errs.push(`代辦列「${a.vendor}／${a.type}」的工數與加班時數都是 0——請填數字或移除該列`);
  });
  return errs;
}

/* v11 回報改逐工種：選工種加入一列（工程師不需知道點工姓名） */
function addTypeRow(type){
  if(!editingLaborReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
  if(typeState.some(t=>t.type===type)){ toast(`「${type}」已在覆核清單中，請直接修改該列數字`); return; }
  // 0 工單（只有夜間加班）仍要能指定工種：本工從 0 起算、加班照填
  const zeroNow = document.getElementById("l_zeroWork").checked;
  typeState.push({ type, work: zeroNow ? 0 : 1, ot2:0, otOver:0 });
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
    /* v24：「0 工」＝**本工 0**，不等於「整張單沒有內容」——日間沒進工區、
       只有夜間進場加班的單就是 0 工＋加班時數，實務上很常見。
       舊寫法把 typeState 整個清空，工種跟著不見，報表只能回退成
       「（未填工種）」，排名與計價都對不到那個工種。
       改成只把本工歸零、**保留工種與加班時數**。 */
    typeState.forEach(t=>{ t.work = 0; });
    document.getElementById("l_actual").value = 0;
    if(!typeState.length){
      document.getElementById("l_ot2").value = 0;
      document.getElementById("l_otOver").value = 0;
    }
  }
  renderTypeRows();
  renderAgentRows();
  syncTotalsFromTypes();
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
  editingLaborReportBaseV = 0;
  typeState = [];
  agentState = [];
  document.getElementById("laborReportForm").reset();
  setCombo("cb_l_engineer", "");
  document.getElementById("l_typeRows").innerHTML = "";
  renderAgentRows();
  document.getElementById("l_diff").value = "";
  document.getElementById("laborReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  lockSignReturnRange("l_signReturnDate", null);                 // 清掉上一張單留下的範圍
  refreshAutoGrow(document.getElementById("laborReportForm"));   // form.reset() 不觸發 input，高度要收回
  document.getElementById("laborReportSubmitBtn").disabled = true;
  if(READY) renderLaborList();
}

async function loadLaborReportRecord(id){
  // v18 樂觀渲染：優先用快取立即開表單；快取沒有才等待網路
  let rec = cur().labor.find(r=>r.id===id);
  if(!rec){
    if(auditSelectedId){ toast("稽核表單編輯中，請先儲存或取消稽核再操作"); return; }   // 同 bgRefetchVerify 守衛
    try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
    rec = cur().labor.find(r=>r.id===id);
  }
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderLaborList(); return; }
  editingLaborReportId = id;
  editingLaborReportBaseV = rec.v || 0;   // v18：版本快照，送出以此為 baseV

  // v11：逐工種覆核；舊單（僅逐人 attendance）帶總數手填即可
  const prevTypes = (rec.report && rec.report.workTypes) || [];
  typeState = prevTypes.map(t=>({type:t.type, work:t.work||0, ot2:t.ot2||0, otOver:t.otOver||0}));

  document.getElementById("laborReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(MASTER.currentSite)}</strong>　${esc(rec.date)}・${esc(rec.vendor)}　需求工數：${fmt(rec.required)}　申請人：${esc(rec.applicant)}
    ${(rec.locations||[]).length ? "　地點："+esc(rec.locations.join("、")) : ""}
  </div>${attReadOnlyHTML(rec.attachments)}`;

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
  lockSignReturnRange("l_signReturnDate", rec.date);   // v22.7：選擇器直接限制在可採計範圍內
  setCombo("cb_l_engineer", rep.engineer || "");
  // v23：代辦逐筆（舊單的代辦三欄不進表單，原樣承繼並在報表另欄顯示）
  agentState = ((rep.agentItems || [])).map(a=>({
    vendor: a.vendor || "", type: a.type || "",
    work: a.work||0, ot2: a.ot2||0, otOver: a.otOver||0, note: a.note||""
  }));
  renderAgentRows();
  document.getElementById("l_conclusion").value = rep.conclusion || "";
  document.getElementById("laborReportSubmitBtn").disabled = false;

  expandPanel("laborReportPanel");
  switchSubTab("tab-labor", "labor-report");
  // 必須在面板展開、子頁切換之後——收合狀態下量不到高度（見 autoGrow 註解）
  refreshAutoGrow(document.getElementById("laborReportForm"));
  document.getElementById("tab-labor").scrollIntoView({behavior:"smooth", block:"start"});

  // v18：表單已即時開啟，於背景抓最新版校正（不擋畫面）
  bgRefetchVerify("labor", id, editingLaborReportBaseV, ()=>editingLaborReportId === id, ()=>{ resetLaborReportForm(); collapsePanel("laborReportPanel"); });
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
  const all = cur().labor;
  const el = document.getElementById("laborList");
  if(!all.length){ el.innerHTML = '<div class="empty-row">目前工地尚無點工紀錄</div>'; document.getElementById("laborListCount").textContent = ""; return; }
  const list = applyListFilter("labor", all, "laborListVendor", "laborListCount", "laborListApplicant");
  if(!list.length){ el.innerHTML = '<div class="empty-row">此篩選條件內沒有點工紀錄，請調整日期／廠商</div>'; return; }
  const { shown, pagerHTML } = paginate("labor", list);
  el.innerHTML = fixedTableOpen([
    "狀態","出工日期","分包商","申請人","需求工數","簽單實際出工數","差異",
    "加班時數","簽單繳回日","簽單責任工程師","現場查核回饋","操作"
  ]) + `<tbody>
    ${shown.map(r=>{
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
        <td>${reported ? cellHTML(rep.conclusion||"—") : "—"}</td>
        <td class="row-actions">
          <button type="button" class="btn-mini btn-edit" data-id="${esc(r.id)}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${esc(r.id)}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${esc(r.id)}">刪除</button>
        </td>
      </tr>`;
    }).join("")}
  </tbody></table>${pagerHTML}`;

  el.querySelectorAll(".btn-edit").forEach(btn=>btn.addEventListener("click", ()=>loadLaborApplyRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-report").forEach(btn=>btn.addEventListener("click", ()=>loadLaborReportRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-del").forEach(btn=>btn.addEventListener("click", ()=>deleteLaborRecord(btn.dataset.id)));
  bindPager(el, "labor", renderLaborList);
}

/* ==========================================================
   機具 — 申請
   ========================================================== */
let editingEquipApplyId = null;
let editingEquipApplyBaseV = 0;

function initEquipApplyForm(){
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("equipApplyNewBtn").addEventListener("click", resetEquipApplyForm);
  initAttBox(equipAtt, "e_attachBox", "e_attachInput");

  document.getElementById("equipApplyForm").addEventListener("submit", async e=>{
    e.preventDefault();
    const applicant = requireCombo("cb_e_applicant", "申請人");
    if(applicant === null) return;
    const types = tagState.e_type.slice();
    if(!types.length){ toast("請選擇機具類型"); return; }
    const requiredQty = parseFloat(document.getElementById("e_requiredQty").value) || 0;
    // v22.6：空白存 null 而非 0——0 代表「預定就是 0 小時」，null 代表「沒填」，
    // 差異計算要分得出來（舊單一律 null，差異顯示空白）
    const phRaw = document.getElementById("e_plannedHours").value.trim();
    const plannedHours = phRaw === "" ? null : (parseFloat(phRaw) || 0);
    const date = document.getElementById("e_date").value;

    if(isLockedDate(date)){
      toast(`此日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員操作`);
      return;
    }

    // 防呆：送出前確認工地
    const okSite = confirm(`⚠ 工地確認\n\n本筆機具申請將寫入共用資料庫的工地：\n「${MASTER.currentSite}」\n\n${date}・${types.join("、")}・需求 ${fmt(requiredQty)} 台${plannedHours != null ? `・預定 ${fmt(plannedHours)} 小時` : ""}\n\n工地正確嗎？`);
    if(!okSite) return;

    const store = cur();
    const existing = editingEquipApplyId ? store.equipment.find(r=>r.id===editingEquipApplyId) : null;

    // v14：先上傳新附件（失敗即中止、輸入保留可重試），再組單據
    let attachments;
    try{
      attachments = await attUploadPending(equipAtt);
    }catch(err){
      toast("⚠ 附件上傳失敗，資料未送出，請檢查網路後再按一次送出");
      return;
    }

    const rec = {
      id: editingEquipApplyId || uid(),
      date, applicant, types,
      // v22.9.1：申請時可選填廠商（已知車行就先填）。留白＝待回報時再填，
      // 沿用 v22.6 的「統一叫車再配車」流程。計價分組一律走 recVendor()（回報值優先）
      vendor: getCombo("cb_e_applyVendor"),
      model: document.getElementById("e_model").value.trim(),
      requiredQty,
      plannedHours,
      contracted: document.querySelector('input[name="e_contract"]:checked').value,
      locations: tagState.e_locations.slice(),
      content: document.getElementById("e_content").value.trim(),
      applyNote: document.getElementById("e_applyNote").value.trim(),
      attachments,
      status: existing ? existing.status : "待回報",
      report: existing ? existing.report : null,
      audits: existing ? (existing.audits || []) : []   // v14 修復：編輯申請單不可洗掉既有稽核紀錄
    };

    try{
      const resp = await apiSaveRecord("equipment", rec, existing ? editingEquipApplyBaseV : 0);   // v18：同上
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
    attFinalize(equipAtt);   // 儲存成功後才真正刪除被移除的附件
    resetEquipApplyForm();
    collapsePanel("equipApplyPanel");   // v15：送出後收回表單
    renderDashboard();
  });

  resetEquipApplyForm();
}

function resetEquipApplyForm(){
  editingEquipApplyId = null;
  editingEquipApplyBaseV = 0;
  document.getElementById("equipApplyForm").reset();
  document.getElementById("e_date").valueAsDate = new Date(Date.now()+86400000);
  document.getElementById("e_requiredQty").value = 1;
  setCombo("cb_e_applyVendor", "");   // v22.9.1
  setCombo("cb_e_applicant", "");
  setTags("e_type", []);
  setTags("e_locations", []);
  resetAttState(equipAtt, "e_attachBox");
  refreshAutoGrow(document.getElementById("equipApplyForm"));   // form.reset() 不觸發 input
  document.getElementById("equipApplyTitle").textContent = "新增機具申請";
  document.getElementById("equipApplySubmitBtn").textContent = "送出機具申請";
  document.getElementById("equipApplyNewBtn").style.display = "none";
  if(READY) renderEquipList();
}

async function loadEquipApplyRecord(id){
  // v18 樂觀渲染：優先用快取立即開表單；快取沒有才等待網路
  let rec = cur().equipment.find(r=>r.id===id);
  if(!rec){
    if(auditSelectedId){ toast("稽核表單編輯中，請先儲存或取消稽核再操作"); return; }   // 同 bgRefetchVerify 守衛
    try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
    rec = cur().equipment.find(r=>r.id===id);
  }
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderEquipList(); return; }
  editingEquipApplyId = id;
  editingEquipApplyBaseV = rec.v || 0;   // v18：版本快照，送出以此為 baseV

  document.getElementById("e_date").value = rec.date;
  setCombo("cb_e_applyVendor", rec.vendor || "");   // v22.9.1：帶回申請時填的廠商（可能為空）
  setCombo("cb_e_applicant", rec.applicant);
  setTags("e_type", rec.types);
  document.getElementById("e_model").value = rec.model || "";
  document.getElementById("e_requiredQty").value = rec.requiredQty;
  document.getElementById("e_plannedHours").value = rec.plannedHours != null ? rec.plannedHours : "";
  document.querySelector(`input[name="e_contract"][value="${rec.contracted||"是"}"]`).checked = true;
  setTags("e_locations", rec.locations);
  document.getElementById("e_content").value = rec.content || "";
  document.getElementById("e_applyNote").value = rec.applyNote || "";
  resetAttState(equipAtt);
  equipAtt.existing = (rec.attachments || []).slice();
  renderAttBox(equipAtt, "e_attachBox");

  // v22.6：申請單不再必有廠商，標題改用機具類型辨識
  document.getElementById("equipApplyTitle").textContent =
    `編輯機具申請：${rec.date}・${(rec.types||[]).join("、") || recVendor(rec) || "（未填類型）"}`;
  document.getElementById("equipApplySubmitBtn").textContent = "儲存變更";
  document.getElementById("equipApplyNewBtn").style.display = "";

  expandPanel("equipApplyPanel");
  switchSubTab("tab-equipment", "equip-apply");
  refreshAutoGrow(document.getElementById("equipApplyForm"));   // 面板展開後才量得到高度
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});

  // v18：表單已即時開啟，於背景抓最新版校正（不擋畫面）
  bgRefetchVerify("equipment", id, editingEquipApplyBaseV, ()=>editingEquipApplyId === id, ()=>{ resetEquipApplyForm(); collapsePanel("equipApplyPanel"); });
}

/* ==========================================================
   機具 — 回報覆核
   ========================================================== */
let editingEquipReportId = null;
let editingEquipReportBaseV = 0;
let usageState = [];

function initEquipReportForm(){
  /* v22.9.1：單台機具時「實際使用時數」直接可編輯，輸入即寫回該台。
     正式資料中一張多類型機具單都沒有，計價（時租）用的也是這個總時數而非逐台，
     所以單台情形不再要求去改那個不起眼的逐台小欄位——直接填這一格即可。 */
  document.getElementById("e_actualHours").addEventListener("input", ()=>{
    if(usageState.length === 1){
      const v = document.getElementById("e_actualHours").value.trim();
      usageState[0].hours = v === "" ? null : (parseFloat(v) || 0);
      if(usageState[0].hours != null && !usageState[0].present){
        usageState[0].present = true;   // 填了時數即視為到場，順手補勾核取方塊
        const cb = document.querySelector('#e_usage input[type=checkbox][data-i="0"]');
        if(cb) cb.checked = true;
      }
    }
    updateEquipDiff();
  });
  /* v22.8：換廠商就要換品項清單——不重填會留著上一家的品項，計價抓錯人 */
  const vendorInput = COMBO["cb_e_vendor"] && COMBO["cb_e_vendor"].input;
  if(vendorInput) vendorInput.addEventListener("change", ()=>{
    const rec = editingEquipReportId ? cur().equipment.find(r=>r.id===editingEquipReportId) : null;
    fillEquipRateSelects(rec ? rec.date : localDate(), "", "");
  });
  document.getElementById("equipReportCancelBtn").addEventListener("click", ()=>{
    resetEquipReportForm();
    collapsePanel("equipReportPanel");   // v15：取消後收回表單
  });
  document.getElementById("e_zeroUse").addEventListener("change", onZeroUseToggle);

  const usageBox = document.getElementById("e_usage");
  usageBox.addEventListener("change", e=>{
    const cb = e.target.closest("input[type=checkbox][data-i]");
    if(!cb) return;
    const i = parseInt(cb.dataset.i,10);
    usageState[i].present = cb.checked;
    /* v22.9：勾選**不預填時數**。改版前預設 8 小時，而總計欄位是唯讀的（逐台加總），
       使用者看到的就是「一勾就鎖 8 小時」——申請 4 小時、實際只用 1 小時的單子，
       只要沒人特地去改逐台欄位就會以 8 小時進計價（時租品項直接乘上去）。
       系統不猜數字，讓工地依實際使用情形填。 */
    if(!cb.checked) usageState[i].hours = null;
    renderUsage();
    syncTotalsFromUsage();
  });
  usageBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i)) return;
    // 空白＝還沒填（送出時擋下），0＝確實填了 0（走既有的異常警告）——兩者不可混為一談
    if(el.classList.contains("usage-hours"))
      usageState[i].hours = el.value.trim() === "" ? null : (parseFloat(el.value) || 0);
    syncTotalsFromUsage();
  });

  /* 代辦列（v23） */
  const eAgentBox = document.getElementById("e_agentRows");
  eAgentBox.addEventListener("input", e=>{
    const el = e.target;
    const i = parseInt(el.dataset.i,10);
    if(Number.isNaN(i) || !equipAgentState[i]) return;
    if(el.classList.contains("eag-qty")) equipAgentState[i].qty = parseFloat(el.value)||0;
    if(el.classList.contains("eag-note")) equipAgentState[i].note = el.value;
  });
  eAgentBox.addEventListener("click", e=>{
    const btn = e.target.closest(".att-remove");
    if(!btn) return;
    equipAgentState.splice(parseInt(btn.dataset.i,10), 1);
    renderEquipAgentRows();
  });
  document.getElementById("e_agentAddBtn").addEventListener("click", addEquipAgentRow);
  // 換品項會改變計價單位（全天→天／時租→小時），代辦列的欄位標籤要跟著變
  document.getElementById("e_rateItem").addEventListener("change", renderEquipAgentRows);

  document.getElementById("equipReportForm").addEventListener("submit", async e=>{
    e.preventDefault();
    if(!editingEquipReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
    const store = cur();
    const rec = store.equipment.find(r=>r.id===editingEquipReportId);
    if(!rec) return;

    const checker = requireCombo("cb_e_checker", "簽單責任工程師");
    if(checker === null) return;
    // v15：回報覆核僅限一位工程師代表
    if(MULTI_NAME_RE.test(checker)){
      toast("簽單責任工程師僅限一位代表，請勿多人並列（申請可多人、回報限一人）");
      return;
    }
    if(checker === rec.applicant){
      toast("⚠ 簽單責任工程師與申請人相同，建議由不同人員回報以維持查核獨立性");
    }

    // v22.6：實際配到的車行於回報時填（申請時工地只是叫車）。
    // 未填不擋送出——現場可能先回報時數、廠商稍後補；但計價要用得到，故提醒一次
    const vendor = getCombo("cb_e_vendor").trim();
    if(vendor && !comboValid("cb_e_vendor")){
      toast(`「${vendor}」不在機具廠商清單中，請從搜尋結果選取或點「＋ 新增選項」加入`);
      return;
    }
    if(!vendor && !document.getElementById("e_zeroUse").checked){
      const ok = confirm("⚠ 尚未填寫機具廠商\n\n廠商是計價彙總的分組依據，未填的單會被歸到「（未填廠商）」。\n\n仍要送出嗎？");
      if(!ok) return;
    }

    const actualHours = parseFloat(document.getElementById("e_actualHours").value) || 0;
    const zeroUse = document.getElementById("e_zeroUse").checked;
    const days = parseFloat(document.getElementById("e_days").value) || 0;
    const otHours = parseFloat(document.getElementById("e_otHours").value) || 0;

    /* v22.9：勾了到場卻沒填時數就擋下來。**空白與 0 是兩件事**——
       0 是「確實填了 0」（走下面的異常警告可確認送出），空白是還沒填，
       放行會靜默變成 0 小時進計價。
       ⚠ 必須擺在下面「時數為 0」那道之前：單台機具沒填時總計也是 0，
         會先被那道攔下而叫使用者去勾「0 使用確認」——那是錯的指引。 */
    if(!zeroUse){
      const blank = usageState.filter(u=>u.present && u.hours == null).map(u=>u.type);
      if(blank.length){
        toast(`請填寫實際使用時數：${blank.join("、")}`);
        return;
      }
    }

    if(actualHours === 0 && !zeroUse){
      toast("實際使用時數為 0：若機具確實未到場／未使用，請先勾選「0 使用確認」再送出");
      return;
    }
    if(zeroUse && actualHours !== 0){
      toast("已勾選 0 使用確認，但實際使用時數不為 0，請修正其中一項");
      return;
    }

    // v22.7：出工日還沒到不能回報；簽單繳回日須在 出工日～出工日+20 天
    const timingErr = reportTimingError(rec.date);
    if(timingErr){ toast(timingErr); return; }
    const signErr = signReturnError(document.getElementById("e_signReturnDate").value, rec.date);
    if(signErr){ toast(signErr); return; }

    /* v23：代辦超量是硬性擋下——代扣金額大於實際付出去的錢就是算錯帳 */
    if(!zeroUse){
      const agentErrs = collectEquipAgentErrors(equipAgentState, equipFormChargeCtx());
      if(agentErrs.length){ toast("代辦資料有誤，未送出：\n- " + agentErrs.join("\n- ")); return; }
    }

    const warnings = collectEquipWarnings(usageState, actualHours, zeroUse, days, otHours);
    if(warnings.length){
      const ok = confirm("⚠ 系統偵測到以下數據配置異常，請確認是否輸入錯誤：\n\n- " + warnings.join("\n- ") + "\n\n確認無誤仍要送出嗎？");
      if(!ok) return;
    }

    const updated = Object.assign({}, rec, {
      status: "已回報",
      report: {
        reportedAt: localDate(),
        checker,
        usage: usageState.map(u=>({type:u.type, present:u.present, hours:u.present?(u.hours ?? 0):0})),
        actualHours,
        // v22.6：差異＝實際時數 − **預定時數**。改版前是減 requiredQty（台數），
        // 等於拿時數減台數，算出來的差異沒有意義。舊單沒有預定時數 → null（不比較）
        diff: rec.plannedHours != null ? actualHours - rec.plannedHours : null,
        vendor,      // 實際配到的車行；計價分組走 recVendor()
        days,        // 出工天數（0.5／1／2…）
        otHours,     // 加班時數（單一欄，機具不分段）
        workContent: document.getElementById("e_workContent").value.trim(),
        // v22.8：只存「挑了哪一項」，不存金額——計價時依出工日回查當季費率
        rateItem: document.getElementById("e_rateItem").value || "",
        rateOtItem: document.getElementById("e_rateOtItem").value || "",
        zeroUse,
        signReturnDate: document.getElementById("e_signReturnDate").value,
        // v12：表單移除「根基自辦」；舊單既有自辦資料原樣承繼保留
        selfDoneWork: (rec.report && rec.report.selfDoneWork != null) ? rec.report.selfDoneWork : null,
        selfDoneHours: (rec.report && rec.report.selfDoneHours != null) ? rec.report.selfDoneHours : null,
        selfDoneNote: (rec.report && (rec.report.selfDoneNote || rec.report.selfDone)) || "",
        /* v23：表單移除「代辦三欄」，改逐筆 agentItems（合約 §4.10）。
           舊值原樣承繼；新舊**不相加**，報表分兩欄呈現 */
        vendorDoneWork: (rec.report && rec.report.vendorDoneWork != null) ? rec.report.vendorDoneWork : null,
        vendorDoneHours: (rec.report && rec.report.vendorDoneHours != null) ? rec.report.vendorDoneHours : null,
        vendorDoneNote: (rec.report && (rec.report.vendorDoneNote || rec.report.vendorDone)) || "",
        agentItems: zeroUse ? [] : equipAgentState.map(a=>({
          vendor: a.vendor, qty: a.qty || 0, note: (a.note || "").trim()
        }))
      }
    });

    try{
      const resp = await apiSaveRecord("equipment", updated, editingEquipReportBaseV);   // v18：同上
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
    collapsePanel("equipReportPanel");   // v15：送出後收回表單
    renderDashboard();
  });

  resetEquipReportForm();
}

function collectEquipWarnings(usage, actualHours, zeroUse, days, otHours){
  const w = [];
  if(zeroUse) return w;
  usage.filter(u=>u.present).forEach(u=>{
    if(!(u.hours > 0)) w.push(`${u.type}：已勾選到場，但實際使用時數為 0`);
    if(u.hours > 12) w.push(`${u.type}：單日使用 ${fmt(u.hours)} 小時，高於常態`);
  });
  // v22.6：出工天數與加班時數直接進計價，異常值要在送出前攔一次
  if(days === 0 && actualHours > 0) w.push("有實際使用時數，但出工天數為 0（計價會抓不到本張單的日數）");
  if(days > 3) w.push(`出工天數 ${fmt(days)} 天，高於常態（單張申請通常為單日）`);
  if(otHours > 12) w.push(`加班時數 ${fmt(otHours)} 小時，高於常態`);
  return w;
}

function renderUsage(){
  const box = document.getElementById("e_usage");
  const zero = document.getElementById("e_zeroUse").checked;
  /* 只有「多台不同機具」才需要逐台拆時數；單台（實務上的全部情形）與無類型
     一律讓上方「實際使用時數」直接可編輯——逐台唯讀加總正是 v22.9 造成
     「看到 0 卻改不動」的來源。 */
  const multi = usageState.length >= 2;
  const hoursEl = document.getElementById("e_actualHours");
  hoursEl.readOnly = multi;
  hoursEl.classList.toggle("readonly-field", multi);
  if(!usageState.length){
    box.innerHTML = '<div class="empty-row">此申請單未填寫機具類型，請直接於下方輸入實際使用時數</div>';
    return;
  }
  box.classList.toggle("disabled", zero);
  box.innerHTML = usageState.map((u,i)=>`
    <div class="att-row ${u.present?'present':''}">
      <label class="att-check"><input type="checkbox" data-i="${i}" ${u.present?'checked':''} ${zero?'disabled':''}><span>${esc(u.type)}</span></label>
      ${multi ? `<div class="att-fields" ${u.present?'':'style="visibility:hidden;"'}>
        <label>使用時數<input type="number" class="usage-hours" data-i="${i}" step="0.5" min="0" placeholder="請填寫" value="${u.hours ?? ""}" ${zero?'disabled':''}></label>
      </div>` : (u.present ? '<span style="color:var(--ink-600);font-size:13px;">時數請填於下方「實際使用時數」↓</span>' : '')}
    </div>`).join("");
}

function syncTotalsFromUsage(){
  const hoursEl = document.getElementById("e_actualHours");
  if(usageState.length >= 2){
    // 多台：總計＝各到場台加總；全部尚未填時留空白而非 0（0 會被誤看成「已填 0」）
    const present = usageState.filter(u=>u.present);
    const anyFilled = present.some(u=>u.hours != null);
    hoursEl.value = anyFilled ? present.reduce((s,u)=>s+(u.hours||0),0) : "";
  }else if(usageState.length === 1){
    // 單台：總時數欄由使用者直接填；取消勾選到場時清空
    if(!usageState[0].present) hoursEl.value = "";
  }
  updateEquipDiff();
}

function onZeroUseToggle(){
  const zero = document.getElementById("e_zeroUse").checked;
  if(zero){
    usageState.forEach(u=>{ u.present = false; u.hours = null; });
    document.getElementById("e_actualHours").value = 0;
  }else{
    // 取消 0 使用確認：清掉那個 0，讓使用者重新填實際時數（否則會殘留 0 看似已填）
    document.getElementById("e_actualHours").value = "";
  }
  renderUsage();
  updateEquipDiff();
}

/* v22.6：差異＝實際使用時數 − 預定使用時數（同單位才比得出來）。
   改版前是減 requiredQty（需求台數），拿時數減台數本就無意義。
   舊單沒有 plannedHours，顯示提示而非算出一個假的數字。 */
function updateEquipDiff(){
  if(!editingEquipReportId){ document.getElementById("e_diff").value = ""; return; }
  const rec = cur().equipment.find(r=>r.id===editingEquipReportId);
  if(!rec) return;
  const el = document.getElementById("e_diff");
  if(rec.plannedHours == null){ el.value = "（申請單未填預定時數）"; return; }
  const actualHours = parseFloat(document.getElementById("e_actualHours").value) || 0;
  const diff = actualHours - rec.plannedHours;
  el.value = diff===0 ? "0（相符）" : fmt(diff);
}

/* ---- 代辦列（機具；v23，合約 §4.10） ----
   機具的費率只綁到廠商層級，所以代辦列不需選品項；數量的單位跟著
   主計價品項的 chargeType 走（全天→天、時租→小時）。 */

function renderEquipAgentRows(){
  const box = document.getElementById("e_agentRows");
  if(!box) return;
  const zero = document.getElementById("e_zeroUse").checked;
  box.classList.toggle("disabled", zero);
  const unit = equipFormChargeCtx().unit || "數量";
  if(!equipAgentState.length){
    box.innerHTML = '<div class="empty-row">未填＝<strong>全數自辦</strong></div>';
    return;
  }
  box.innerHTML = equipAgentState.map((a,i)=>`
    <div class="att-row present">
      <span class="tr-name">${esc(a.vendor)}</span>
      <div class="att-fields">
        <label>代辦${esc(unit)}<input type="number" class="eag-qty" data-i="${i}" step="0.5" min="0" value="${a.qty}" ${zero?"disabled":""}></label>
        <label class="ag-note">代辦內容<input type="text" class="eag-note" data-i="${i}" value="${esc(a.note||"")}" placeholder="這家廠商來做了什麼（例：代叫水車洗街）" ${zero?"disabled":""}></label>
      </div>
      <button type="button" class="att-remove" data-i="${i}" title="移除此代辦列">×</button>
    </div>`).join("");
}

function fillEquipAgentSelect(){
  // v23.5：改自由輸入＋建議清單（理由見 agentVendorSuggestions）
  fillDatalist("e_agentVendorList", agentVendorSuggestions());
}

function addEquipAgentRow(){
  if(!editingEquipReportId){ toast("請先從清單選擇要回報的紀錄"); return; }
  if(document.getElementById("e_zeroUse").checked){ toast("已勾選 0 使用確認，無代辦可填"); return; }
  const vEl = document.getElementById("e_agentVendor");
  const vendor = vEl.value.trim();   // v23.5：自由輸入
  if(!vendor){ toast("請先填責任歸屬廠商"); return; }
  if(equipAgentState.some(a=>a.vendor===vendor)){
    toast(`「${vendor}」已在代辦清單中，請直接修改該列數量`); return;
  }
  equipAgentState.push({ vendor, qty:0, note:"" });
  vEl.value = "";
  fillEquipAgentSelect();
  renderEquipAgentRows();
}

/* 表單當下的計價數量與單位：用來標示欄位單位、並檢查代辦不得超量。
   品項未選或查無費率時回 {qty:null}——此時不做上限檢查，因為代扣金額
   本來就會顯示「無法計價」的原因，不會靜默變成 0。 */
function equipFormChargeCtx(){
  const rec = editingEquipReportId ? cur().equipment.find(r=>r.id===editingEquipReportId) : null;
  if(!rec) return { qty: null, unit: "" };
  const vendor = getCombo("cb_e_vendor").trim();
  const book = bookFor("equipment", rec.date);
  const code = rateBindings().equipment[vendor];
  const item = (document.getElementById("e_rateItem") || {}).value || "";
  if(!book || !code || !item) return { qty: null, unit: "" };
  const main = book.rows.find(r=>r.vendorCode === code && r.item === item);
  if(!main) return { qty: null, unit: "" };
  const days = parseFloat((document.getElementById("e_days")||{}).value) || 0;
  const hours = parseFloat((document.getElementById("e_actualHours")||{}).value) || 0;
  return equipQtyFor(main, { days, actualHours: hours });
}

function collectEquipAgentErrors(agents, ctx){
  const errs = [];
  agents.forEach(a=>{
    if(!(a.qty > 0)) errs.push(`代辦列「${a.vendor}」的數量是 0——請填數字或移除該列`);
  });
  if(ctx && ctx.qty != null){
    const sum = agents.reduce((s,a)=>s+(a.qty||0), 0);
    if(sum > ctx.qty)
      errs.push(`代辦數量合計 ${fmt(sum)} ${ctx.unit}，超過本單的計價數量 ${fmt(ctx.qty)} ${ctx.unit}——代辦是計價量的一部分，不是額外量`);
  }
  return errs;
}

function resetEquipReportForm(){
  editingEquipReportId = null;
  editingEquipReportBaseV = 0;
  usageState = [];
  equipAgentState = [];
  document.getElementById("equipReportForm").reset();
  setCombo("cb_e_checker", "");
  setCombo("cb_e_vendor", "");
  fillEquipRateSelects(null, "", "");     // v22.8：清掉上一張單的品項清單
  document.getElementById("e_usage").innerHTML = "";
  renderEquipAgentRows();
  document.getElementById("e_diff").value = "";
  document.getElementById("equipReportContext").innerHTML = '<div class="empty-row">請從下方清單點選「填寫回報」開始</div>';
  lockSignReturnRange("e_signReturnDate", null);                 // 清掉上一張單留下的範圍
  refreshAutoGrow(document.getElementById("equipReportForm"));   // form.reset() 不觸發 input，高度要收回
  document.getElementById("equipReportSubmitBtn").disabled = true;
  if(READY) renderEquipList();
}

async function loadEquipReportRecord(id){
  // v18 樂觀渲染：優先用快取立即開表單；快取沒有才等待網路
  let rec = cur().equipment.find(r=>r.id===id);
  if(!rec){
    if(auditSelectedId){ toast("稽核表單編輯中，請先儲存或取消稽核再操作"); return; }   // 同 bgRefetchVerify 守衛
    try{ await refetchSite(MASTER.currentSite); }catch(e){ toast("⚠ 無法載入最新資料，請檢查網路後再試"); return; }
    rec = cur().equipment.find(r=>r.id===id);
  }
  if(!rec){ toast("此紀錄已被其他人刪除"); renderAll(); return; }
  if(isLockedDate(rec.date)){ toast(`此單日期已在計價鎖定期間（${cur().config.lockDate} 含以前），僅限管理員修改`); renderEquipList(); return; }
  editingEquipReportId = id;
  editingEquipReportBaseV = rec.v || 0;   // v18：版本快照，送出以此為 baseV

  const prev = (rec.report && rec.report.usage) || [];
  usageState = (rec.types||[]).map(type=>{
    const p = prev.find(x=>x.type===type);
    // v22.9：未回報過的機具**不預填時數**（改版前是 8），避免沒人改就以 8 小時計價
    return p ? {type, present:!!p.present, hours:p.hours ?? null} : {type, present:false, hours:null};
  });

  // v22.6：申請單不再必有廠商；改秀「預定使用時數」——回報要跟它比對差異
  document.getElementById("equipReportContext").innerHTML = `<div class="context-box">
    <strong>${esc(MASTER.currentSite)}</strong>　${esc(rec.date)}　類型：${esc((rec.types||[]).join("、"))}　需求數量：${fmt(rec.requiredQty)} 台　預定使用時數：${rec.plannedHours != null ? fmt(rec.plannedHours) + " 小時" : "（未填）"}　申請人：${esc(rec.applicant)}
  </div>${attReadOnlyHTML(rec.attachments)}`;

  const rep = rec.report || {};
  document.getElementById("e_zeroUse").checked = !!rep.zeroUse;
  renderUsage();
  /* v22.9.1：未回報過的單**留空白**而非預設 0——0 加上單台唯讀（舊版）正是
     「看到 0 卻改不動」的來源。已回報單顯示原值。 */
  document.getElementById("e_actualHours").value = rep.actualHours != null ? rep.actualHours : "";
  updateEquipDiff();
  document.getElementById("e_signReturnDate").value = rep.signReturnDate || "";
  lockSignReturnRange("e_signReturnDate", rec.date);   // v22.7：選擇器直接限制在可採計範圍內
  setCombo("cb_e_checker", rep.checker || "");
  // v22.6：回報廠商——舊單的廠商在申請層，用 recVendor() 帶出來讓人接著編輯
  setCombo("cb_e_vendor", recVendor(rec));
  document.getElementById("e_days").value = rep.days != null ? rep.days : "";
  document.getElementById("e_otHours").value = rep.otHours != null ? rep.otHours : "";
  document.getElementById("e_workContent").value = rep.workContent || "";
  /* v22.8：費率書不在 scope=all，開表單時才抓；抓到後填品項下拉並帶回原選擇 */
  /* 代辦列要在費率書載入後重繪一次——欄位單位（天／小時）取自主品項的計價方式 */
  loadRates().then(()=>{ fillEquipRateSelects(rec.date, rep.rateItem, rep.rateOtItem); renderEquipAgentRows(); })
    .catch(()=>{ fillEquipRateSelects(rec.date, rep.rateItem, rep.rateOtItem); renderEquipAgentRows(); });
  // v23：代辦逐筆（舊單的代辦三欄不進表單，原樣承繼並在報表另欄顯示）
  fillEquipAgentSelect();
  equipAgentState = ((rep.agentItems || [])).map(a=>({
    vendor: a.vendor || "", qty: a.qty || 0, note: a.note || ""
  }));
  renderEquipAgentRows();
  document.getElementById("equipReportSubmitBtn").disabled = false;

  expandPanel("equipReportPanel");
  switchSubTab("tab-equipment", "equip-report");
  // 必須在面板展開、子頁切換之後——收合狀態下量不到高度（見 autoGrow 註解）
  refreshAutoGrow(document.getElementById("equipReportForm"));
  document.getElementById("tab-equipment").scrollIntoView({behavior:"smooth", block:"start"});

  // v18：表單已即時開啟，於背景抓最新版校正（不擋畫面）
  bgRefetchVerify("equipment", id, editingEquipReportBaseV, ()=>editingEquipReportId === id, ()=>{ resetEquipReportForm(); collapsePanel("equipReportPanel"); });
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
  const all = cur().equipment;
  const el = document.getElementById("equipList");
  if(!all.length){ el.innerHTML = '<div class="empty-row">目前工地尚無機具紀錄</div>'; document.getElementById("equipListCount").textContent = ""; return; }
  const list = applyListFilter("equipment", all, "equipListVendor", "equipListCount", "equipListApplicant");
  if(!list.length){ el.innerHTML = '<div class="empty-row">此篩選條件內沒有機具紀錄，請調整日期／廠商</div>'; return; }
  const { shown, pagerHTML } = paginate("equipment", list);
  el.innerHTML = fixedTableOpen([
    "狀態","日期","廠商","申請人","類型","型號","需求數量(台)","預定使用時數",
    "機具實際工作使用時數","差異","出工天數","加班時數",
    "簽單繳回日","簽單責任工程師","操作"
  ]) + `<tbody>
    ${shown.map(x=>{
      const rep = x.report;
      const reported = x.status==="已回報" && rep;
      const statusTag = reported
        ? (rep.zeroUse ? '<span class="tag bad">0時數</span>' : '<span class="tag ok">已回報</span>')
        : '<span class="tag warn">待回報</span>';
      // v22.6：差異可能是 null（申請單未填預定時數）——不可當成 0 顯示「相符」
      const diffTag = !reported ? "—"
        : rep.diff == null ? '<span class="tag">未填預定</span>'
        : rep.diff === 0 ? '<span class="tag ok">相符</span>'
        : '<span class="tag bad">'+fmt(rep.diff)+'</span>';
      const reportBtnLabel = reported ? "編輯回報" : "填寫回報";
      return `<tr>
        <td>${statusTag}</td>
        <td>${esc(x.date)}</td><td>${esc(recVendor(x)||"—")}</td><td>${esc(x.applicant||"—")}</td>
        <td>${esc((x.types||[]).join("、"))}</td>
        <td>${esc(x.model||"—")}</td><td>${fmt(x.requiredQty)}</td>
        <td>${x.plannedHours != null ? fmt(x.plannedHours) : "—"}</td>
        <td>${reported ? fmt(rep.actualHours) : "—"}</td><td>${diffTag}</td>
        <td>${reported ? fmt(rep.days||0) : "—"}</td>
        <td>${reported ? fmt(rep.otHours||0) : "—"}</td>
        <td>${reported ? esc(rep.signReturnDate||"—") : "—"}</td>
        <td>${reported ? esc(rep.checker||"—") : "—"}</td>
        <td class="row-actions">
          <button type="button" class="btn-mini btn-edit" data-id="${esc(x.id)}">編輯申請</button>
          <button type="button" class="btn-mini btn-report" data-id="${esc(x.id)}">${reportBtnLabel}</button>
          <button type="button" class="btn-mini btn-del" data-id="${esc(x.id)}">刪除</button>
        </td>
      </tr>`;
    }).join("")}
  </tbody></table>${pagerHTML}`;

  el.querySelectorAll(".btn-edit").forEach(btn=>btn.addEventListener("click", ()=>loadEquipApplyRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-report").forEach(btn=>btn.addEventListener("click", ()=>loadEquipReportRecord(btn.dataset.id)));
  el.querySelectorAll(".btn-del").forEach(btn=>btn.addEventListener("click", ()=>deleteEquipRecord(btn.dataset.id)));
  bindPager(el, "equipment", renderEquipList);
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

/* 兩個「YYYY-MM-DD」相差幾天（b - a）。
   ⚠ 一律用 Date.UTC 由年月日三段組出來比較，**不可** new Date(字串) 再相減——
   後者把純日期字串當 UTC 午夜、把帶時間的字串當本地時間，兩種混用會在
   UTC+8 的早晨差整整一天（計價紅線 2 的同源問題）。這裡兩邊都走 UTC，
   純粹當「日曆天」相減，不受時區與日光節約影響。 */
function daysBetween(a, b){
  if(!a || !b) return 0;
  const pa = String(a).split("-").map(Number), pb = String(b).split("-").map(Number);
  if(pa.length < 3 || pb.length < 3) return 0;
  return Math.round((Date.UTC(pb[0], pb[1]-1, pb[2]) - Date.UTC(pa[0], pa[1]-1, pa[2])) / 86400000);
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

  /* 戰情室：逾期未回報＝出工日已過、卻仍停在「待回報」的單（跨工地）。
     只算「出工日 < 今天」——當天的單還沒到回報時機，不是逾期。
     機具的廠商一律走 recVendor()（v22.6 起廠商在回報時才填，唯一權威）。 */
  const today = localDate();
  const overdue = [];
  allLabor.forEach(({site, r})=>{
    if(r.status !== "已回報" && r.date && r.date < today)
      overdue.push({ site, kind:"點工", date:r.date, vendor:r.vendor || "—",
                     who:r.applicant || "—", days: daysBetween(r.date, today) });
  });
  allEquip.forEach(({site, x})=>{
    if(x.status !== "已回報" && x.date && x.date < today)
      overdue.push({ site, kind:"機具", date:x.date, vendor:recVendor(x) || "—",
                     who:x.applicant || "—", days: daysBetween(x.date, today) });
  });
  overdue.sort((a,b)=> b.days - a.days || String(a.site).localeCompare(b.site));

  const cards = [
    {label:"本月出工回報次數", value:reportedThisMonth.length, cls:""},
    {label:"逾期未回報", value:overdue.length, cls: overdue.length? "bad":""},
    {label:"本月人數異常件數", value:abnormal.length, cls: abnormal.length? "bad":""},
    {label:"點工待回報", value:laborPending.length, cls: laborPending.length? "warn":""},
    {label:"機具待回報", value:equipPending.length, cls: equipPending.length? "warn":""},
    {label:"簽單尚未繳回", value:pendingSign.length, cls: pendingSign.length? "warn":""},
  ];
  document.getElementById("dashCards").innerHTML = cards.map(c=>`
    <div class="card ${c.cls}"><div class="num">${c.value}</div><div class="lbl">${esc(c.label)}</div></div>
  `).join("");

  renderSiteBreakdown();
  renderOverdueList(overdue);
  renderDashRanking(allLabor);

  /* 簽單提醒：改依「出工日後 20 天」的期限倒數排序，最急的在最上面。
     只列出尚未填繳回日者；已逾期與快到期分別給不同標記，讓人一眼看出要先追哪一張。 */
  const dueEl = document.getElementById("dueList");
  if(!pendingSign.length){
    dueEl.innerHTML = '<div class="empty-row">目前沒有待繳回的簽單</div>';
  }else{
    const dueRows = pendingSign
      .map(({site,r})=>({ site, r, left: SIGN_RETURN_MAX_DAYS - daysBetween(r.date, today) }))
      .sort((a,b)=> a.left - b.left);
    const tagOf = left => left < 0
      ? `<span class="tag bad">已逾期 ${-left} 天</span>`
      : (left <= 5 ? `<span class="tag warn">剩 ${left} 天</span>`
                   : `<span class="tag">尚有 ${left} 天</span>`);
    dueEl.innerHTML = dueRows.slice(0,10).map(({site,r,left})=>`
      <div class="row-item">
        <span>${esc(site)}・${esc(r.date)}・${esc(r.vendor)}・${esc((r.report&&r.report.engineer)||"—")}</span>
        ${tagOf(left)}
      </div>
    `).join("")
      + (dueRows.length > 10 ? `<div class="empty-row">…另有 ${dueRows.length - 10} 張未列出</div>` : "");
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

/* 戰情室：逾期未回報清單（跨工地）。
   這是「總覽跨工地待回報名單」那個擱置項的落地——工地端各自看得到自己的待回報，
   但沒有人看得到「全公司哪幾張拖最久」，而那正是成控要追的東西。
   列可點擊：切到該工地並跳到對應清單頁，直接接上處理動線。 */
function renderOverdueList(overdue){
  const el = document.getElementById("overdueList");
  if(!el) return;
  if(!overdue.length){
    el.innerHTML = '<div class="empty-row">目前沒有逾期未回報的單據</div>';
    return;
  }
  const sev = d => d >= 7 ? "bad" : (d >= 3 ? "warn" : "");
  el.innerHTML = overdue.slice(0, 12).map(o=>`
    <div class="row-item clickable" data-site="${esc(o.site)}" data-kind="${esc(o.kind)}">
      <span><strong>${esc(o.site)}</strong>・${esc(o.kind)}・${esc(o.date)}
        <span class="row-meta">${esc(o.vendor)}／${esc(o.who)}</span></span>
      <span class="tag ${sev(o.days)}">逾期 ${o.days} 天</span>
    </div>
  `).join("")
    + (overdue.length > 12 ? `<div class="empty-row">…另有 ${overdue.length - 12} 張未列出</div>` : "");

  // 事件綁定（不可用內聯 onclick，會被 CSP 的 script-src 'self' 擋下）
  el.querySelectorAll(".row-item[data-site]").forEach(row=>{
    row.addEventListener("click", ()=>{
      switchSiteContext(row.dataset.site);
      switchMainTab(row.dataset.kind === "機具" ? "equipment" : "labor");
    });
  });
}

/* 戰情室：本月出工量排名（工地榜／分包商榜）。
   ⚠ 工數一律取自 reportTypeRows()——逐工種展開的唯一權威（計價紅線 3）。
   自己在這裡另寫一套加總，就會多出一個與報表對不起來的口徑。
   只計本工工數、加班不折算：折算比例是計價議題，看板不該自創換算。 */
function renderDashRanking(allLabor){
  const siteEl = document.getElementById("rankBySite");
  const vendEl = document.getElementById("rankByVendor");
  if(!siteEl || !vendEl) return;

  const bySite = new Map(), byVendor = new Map();
  allLabor.forEach(({site, r})=>{
    if(!(r.status === "已回報" && r.report && isThisMonth(r.report.reportedAt))) return;
    const work = reportTypeRows(r).reduce((s,t)=> s + (Number(t.work) || 0), 0);
    if(!work) return;
    bySite.set(site, (bySite.get(site) || 0) + work);
    const v = r.vendor || "（未填廠商）";
    byVendor.set(v, (byVendor.get(v) || 0) + work);
  });

  const toRows = m => [...m.entries()]
    .map(([label, value])=>({ label, value }))
    .sort((a,b)=> b.value - a.value);

  // tableBelow:false —— 戰情室只放圖、下方沒有數值表（完整數值在「歷程報表」頁）
  siteEl.innerHTML = hBarChart(toRows(bySite), { max:8, unit:"工", title:"本月工地出工量", tableBelow:false });
  vendEl.innerHTML = hBarChart(toRows(byVendor), { max:8, unit:"工", title:"本月分包商出工量", tableBelow:false });
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
        <td class="site-name-cell">${esc(r.site)}${r.site===MASTER.currentSite?'<span class="tag ok" style="margin-left:6px;">目前</span>':''}${r.total===0?'<span class="tag" style="margin-left:6px;background:var(--bg-surface-2);color:var(--fg-muted);">尚無紀錄</span>':''}</td>
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
let reportVendor = "", reportCat = "", reportEngineer = "";

function matchReportVendor(r){ return !reportVendor || recVendor(r) === reportVendor; }
/* v15：依簽單責任工程師篩選（labor=rep.engineer；equip=rep.checker）——
   回報限一人代表後，選定工程師即可統計他經手叫了多少工 */
function matchReportEngineer(r, kind){
  if(!reportEngineer) return true;
  const rep = r.report || {};
  return (kind === "labor" ? rep.engineer : rep.checker) === reportEngineer;
}
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

/* 代辦逐筆（v23）→ 報表用的彙總與明細字串。

   ⚠ v23 起代辦改存 `rep.agentItems[]`，舊制三欄（vendorDoneWork/Hours/Note）只承繼歷史單。
   明細與計價彙總原本仍只讀舊欄位，導致 v23 之後回報的代辦在兩份**給成本部的報表**裡
   永遠是空白（畫面上有、匯出後沒有）——這個函式就是把那條線接回去。

   **新舊不相加**：有 agentItems 就以它為準，否則回退舊欄位。相加會把同一筆代辦算兩次
   （舊單被編輯過時兩邊都有值），那是直接算錯錢。 */
function agentSummary(rep, kind){
  const items = (rep && rep.agentItems) || [];
  if(!items.length) return null;
  const note = items.map(a=>a.note).filter(Boolean).join("；");
  if(kind === "equipment"){
    // 機具代辦綁廠商層級，只有數量（單位依主計價品項的 charge_type，見合約 §4.9）
    return { work: items.reduce((t,a)=> t + (Number(a.qty) || 0), 0), hours: 0,
             detail: items.map(a=>`${a.vendor}(${fmt(a.qty||0)})`).join("、"), note };
  }
  return {
    work:  items.reduce((t,a)=> t + (Number(a.work)   || 0), 0),
    hours: items.reduce((t,a)=> t + (Number(a.ot2)    || 0) + (Number(a.otOver) || 0), 0),
    detail: items.map(a=>{
      const parts = [`${fmt(a.work||0)}工`];
      if(a.ot2)    parts.push(`前2h:${fmt(a.ot2)}h`);
      if(a.otOver) parts.push(`逾2h:${fmt(a.otOver)}h`);
      return `${a.vendor}·${a.type}(${parts.join("/")})`;
    }).join("、"),
    note
  };
}

/* 自辦/代辦欄位：新結構（工數/時數/備註）優先，舊版單一文字歸入備註。
   代辦三欄 v23 起由 agentItems 供應；末欄「代辦明細(廠商)」把組成攤開，
   讓人看得見這筆扣工是扣給誰、哪個工種（計價紅線 4）。 */
function doneCols(rep, kind){
  const ag = agentSummary(rep, kind);
  return [
    rep.selfDoneWork != null ? fmt(rep.selfDoneWork) : "",
    rep.selfDoneHours != null ? fmt(rep.selfDoneHours) : "",
    rep.selfDoneNote || rep.selfDone || "",
    ag ? fmt(ag.work) : (rep.vendorDoneWork != null ? fmt(rep.vendorDoneWork) : ""),
    ag ? (ag.hours ? fmt(ag.hours) : "") : (rep.vendorDoneHours != null ? fmt(rep.vendorDoneHours) : ""),
    ag ? ag.note : (rep.vendorDoneNote || rep.vendorDone || ""),
    ag ? ag.detail : ""
  ];
}

const REPORT_DEFS = {
  labor: {
    title:"點工紀錄",
    headers:["出工日期","廠商","需求工數","工作內容","工作地點","申請人","狀態","人臉紀錄","白卡紀錄","工具箱紀錄","簽單繳回日","簽單實際出工數","差異","0工確認","簽單責任工程師","加班時數(前2小時)","加班時數(第3小時起)","加班總時數","出工明細(工種)",
      ...(PRICING_UI ? ["計價金額","計價組成"] : []),
      "根基自辦工數","根基自辦時數","根基自辦備註","廠商代辦工數","廠商代辦時數","廠商代辦備註","代辦明細(廠商)","現場查核回饋"],
    records: ()=>cur().labor.filter(r=>inReportRange(r.date) && matchReportVendor(r) && matchReportCat(r,"labor") && matchReportEngineer(r,"labor")),
    rows(recs){ return (recs || this.records()).map(r=>{
      const rep = r.report || {};
      const reported = r.status==="已回報" && r.report;
      const seg = otSegments(rep);   // 分段口徑唯一權威（同 buildPricingSummary/reportTypeRows 寫法）
      return [
        r.date, r.vendor, fmt(r.required),
        (r.categories||[]).join("、")+(r.categoryNote?"・"+r.categoryNote:""),
        (r.locations||[]).join("、"), r.applicant, r.status,
        rep.checkFace?"V":"", rep.checkCard?"V":"", rep.checkToolbox?"V":"",
        rep.signReturnDate||"", reported?fmt(rep.actual):"", reported?fmt(rep.diff):"",
        rep.zeroWork?"V":"",
        rep.engineer||"",
        // 歸段口徑走 otSegments()（唯一權威，計價紅線 1）——舊制單只有 totalOT
        // 時必須顯示為「前2h」，直接讀 ot2Total 會留空，與彙總/分欄對不起來
        reported ? fmt(seg.ot2) : "",
        reported ? fmt(seg.otOver) : "",
        reported ? fmt(rep.totalOT) : "",
        laborDetail(rep),
        // v22.8 金額＋組成（v23.1：畫面層開關關閉時整組不輸出，見 PRICING_UI）
        ...(PRICING_UI ? (reported ? amountCells(laborAmount(r)) : ["", ""]) : [])
      ].concat(doneCols(rep, "labor"), [rep.conclusion||""]);
    }); }
  },
  equipment: {
    title:"機具紀錄",
    /* v22.6 欄位調整：
       - 「機具廠商」＝有效廠商（回報優先，見 recVendor）；移除重複的「責任廠商」欄
       - 「預計使用時數(需求數量)」正名為「需求數量(台)」——它一直是台數，欄名寫錯
       - 新增：預定使用時數／申請備註／出工天數／加班時數／實際工作內容 */
    headers:["出工日期","機具廠商","機具類型","型號","工作內容","工作地點","需求數量(台)","預定使用時數","申請備註","申請人","狀態","簽單繳回日","機具實際工作使用時數","差異","出工天數","加班時數","實際工作內容",
      ...(PRICING_UI ? ["計價品項","加班費率品項","計價金額","計價組成"] : []),
      "0使用確認","機具使用明細","簽單責任工程師","根基自辦工數","根基自辦時數","根基自辦備註","廠商代辦工數","廠商代辦時數","廠商代辦備註","代辦明細(廠商)"],
    records: ()=>cur().equipment.filter(x=>inReportRange(x.date) && matchReportVendor(x) && matchReportCat(x,"equipment") && matchReportEngineer(x,"equipment")),
    rows(recs){ return (recs || this.records()).map(x=>{
      const rep = x.report || {};
      const reported = x.status==="已回報" && x.report;
      const usageDetail = (rep.usage||[]).filter(u=>u.present)
        .map(u=>`${u.type}(${fmt(u.hours)}h)`).join("、");
      return [
        x.date, recVendor(x), (x.types||[]).join("、"), x.model, x.content,
        (x.locations||[]).join("、"), fmt(x.requiredQty),
        x.plannedHours != null ? fmt(x.plannedHours) : "",
        x.applyNote || "",
        x.applicant, x.status,
        rep.signReturnDate||"", reported?fmt(rep.actualHours):"",
        // 差異可能是 null（申請單沒填預定時數）——不可 fmt(null) 印出 0，那會被當成「相符」
        reported && rep.diff != null ? fmt(rep.diff) : "",
        reported?fmt(rep.days||0):"", reported?fmt(rep.otHours||0):"", rep.workContent||"",
        // v22.8 品項＋金額＋組成（v23.1：畫面層開關關閉時整組不輸出，見 PRICING_UI）
        ...(PRICING_UI
            ? [rep.rateItem||"", rep.rateOtItem||"", ...(reported ? amountCells(equipAmount(x)) : ["", ""])]
            : []),
        rep.zeroUse?"V":"", usageDetail,
        rep.checker||""
      ].concat(doneCols(rep, "equipment"));
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
    const key = recVendor(r) || "（未填廠商）";
    const g = groups[key] || (groups[key] = {vendor:key, count:0, zero:0, work:0, ot2:0, otOver:0, hours:0, days:0, ot:0, selfW:0, selfH:0, vendW:0, vendH:0, cats:new Set(), amount:0, noRate:0});
    const rep = r.report;
    g.count++;
    /* v22.8：金額合計。算不出來的單獨立計數——**不可當 0 加進去**，
       那會讓總額看起來合理卻少算，是最難發現的錯 */
    const amt = kind === "labor" ? laborAmount(r) : equipAmount(r);
    if(amt.amount == null) g.noRate++; else g.amount += amt.amount;
    if(kind === "labor"){
      if(rep.zeroWork) g.zero++;
      g.work += rep.actual || 0;
      const seg = otSegments(rep);   // 分段口徑唯一權威（v21.3）
      g.ot2 += seg.ot2;
      g.otOver += seg.otOver;
      (r.categories||[]).forEach(c=>g.cats.add(c));
    }else{
      if(rep.zeroUse) g.zero++;
      g.hours += rep.actualHours || 0;
      // v22.6：機具計價＝出工天數＋加班時數（加班單一欄，不套用點工的分段規則）
      g.days += rep.days || 0;
      g.ot += rep.otHours || 0;
      (r.types||[]).forEach(t=>g.cats.add(t));
    }
    g.selfW += rep.selfDoneWork || 0;
    g.selfH += rep.selfDoneHours || 0;
    /* v23 代辦落在 agentItems；有就以它為準、否則回退舊欄位（新舊不相加，見 agentSummary）。
       原本只讀舊欄位，成本部拿到的計價彙總「廠商代辦工數/時數」對新單一律是 0。 */
    const ag = agentSummary(rep, kind);
    if(ag){ g.vendW += ag.work; g.vendH += ag.hours; }
    else  { g.vendW += rep.vendorDoneWork || 0; g.vendH += rep.vendorDoneHours || 0; }
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
      headers:["期間","廠商","已回報單數","0工單數","總出工數","加班時數(前2小時)","加班時數(第3小時起)",
        ...(PRICING_UI ? ["計價金額","未能計價單數"] : []),
        "根基自辦工數","根基自辦時數","廠商代辦工數","廠商代辦時數","工作內容"],
      rows: gs.map(g=>[period, g.vendor, g.count, g.zero, fmt(g.work), fmt(g.ot2), fmt(g.otOver),
        ...(PRICING_UI ? [g.amount, g.noRate] : []),
        fmt(g.selfW), fmt(g.selfH), fmt(g.vendW), fmt(g.vendH), [...g.cats].join("、")])
    };
  }
  /* v22.6：機具計價的組成是「出工天數＋加班時數」，兩者都要看得見
     （計價紅線 4：報表不能只給一個算完的數字）。實際使用時數保留供對帳。 */
  return {
    headers:["期間","機具廠商","已回報單數","0使用單數","總出工天數","總加班時數","總實際使用時數",
      ...(PRICING_UI ? ["計價金額","未能計價單數"] : []),
      "根基自辦工數","根基自辦時數","廠商代辦工數","廠商代辦時數","機具類型"],
    rows: gs.map(g=>[period, g.vendor, g.count, g.zero, fmt(g.days), fmt(g.ot), fmt(g.hours),
      ...(PRICING_UI ? [g.amount, g.noRate] : []),
      fmt(g.selfW), fmt(g.selfH), fmt(g.vendW), fmt(g.vendH), [...g.cats].join("、")])
  };
}

function initReportTabs(){
  document.querySelectorAll(".rtab").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".rtab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      currentReport = btn.dataset.r;
      listPage.report = listPage.ranking = 1;
      reportCat = "";           // 點工/機具的內容池不同，切換頁籤時重置內容篩選
      document.getElementById("reportCat").value = "";
      reportEngineer = "";      // 工程師池亦分屬兩類（engineer/checker），一併重置
      document.getElementById("reportEngineer").value = "";
      renderReport(currentReport);
    });
  });
  document.getElementById("exportBtn").addEventListener("click", ()=>{
    if(currentReport === "vendorRank") return exportVendorRankXls();
    if(currentReport === "ranking") return exportRankingXls();
    if(currentReport === "labor") return exportLaborXlsx();     // v21.1：點工改帶格式 xlsx
    exportCSV(currentReport);
  });
  document.getElementById("exportSummaryBtn").addEventListener("click", ()=>
    currentReport === "labor" ? exportLaborSummaryXlsx() : exportSummaryCSV(currentReport));
  document.getElementById("reportVendor").addEventListener("change", e=>{
    reportVendor = e.target.value;
    listPage.report = listPage.ranking = 1;
    renderReport(currentReport);
  });
  document.getElementById("reportCat").addEventListener("change", e=>{
    reportCat = e.target.value;
    listPage.report = listPage.ranking = 1;
    renderReport(currentReport);
  });
  document.getElementById("reportEngineer").addEventListener("change", e=>{
    reportEngineer = e.target.value;
    listPage.report = listPage.ranking = 1;
    renderReport(currentReport);
  });

  const fromEl = document.getElementById("reportFrom");
  const toEl = document.getElementById("reportTo");
  const syncRange = ()=>{
    reportFrom = fromEl.value || "";
    reportTo = toEl.value || "";
    listPage.report = listPage.ranking = 1;
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
  const engSel = document.getElementById("reportEngineer");
  const recs = key==="labor" ? cur().labor : cur().equipment;
  const vendors = [...new Set(recs.map(recVendor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const cats = [...new Set(recs.flatMap(r=>(key==="labor" ? r.categories : r.types) || []))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const engineers = [...new Set(recs.map(r=>{
    const rep = r.report || {};
    return key==="labor" ? rep.engineer : rep.checker;
  }).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  const vendLabel = key==="labor" ? "全部廠商" : "全部機具廠商";
  const catLabel = key==="labor" ? "全部工作內容" : "全部機具類型";
  vendSel.innerHTML = `<option value="">${esc(vendLabel)}</option>` + vendors.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");
  catSel.innerHTML = `<option value="">${esc(catLabel)}</option>` + cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");
  engSel.innerHTML = `<option value="">全部簽單責任工程師</option>` + engineers.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join("");
  if(vendors.includes(reportVendor)) vendSel.value = reportVendor; else { reportVendor = ""; vendSel.value = ""; }
  if(cats.includes(reportCat)) catSel.value = reportCat; else { reportCat = ""; catSel.value = ""; }
  if(engineers.includes(reportEngineer)) engSel.value = reportEngineer; else { reportEngineer = ""; engSel.value = ""; }
}

/* 明細與計價彙總共用；欄寬走上方 COL_W（共用表格工具） */
function reportTableHTML(headers, rows){
  const cell = v=>`<td>${cellHTML(v)}</td>`;
  return fixedTableOpen(headers)
    + `<tbody>${rows.map(r=>`<tr>${r.map(cell).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderReport(key){
  if(!READY) return;
  /* v22.8：費率書不在 scope=all 裡（合約 §2.4），首次進報表才抓；
     抓到後重繪一次把金額補上。
     ⚠ 用獨立旗標防重入，**不可拿空的 RATES 當佔位**——那樣一旦載入失敗，
     RATES 就永遠是非 null 的空物件、再也不會重試，所有金額都會變成
     「該出工日無適用季別」，而彙總的金額欄會靜靜地印 0。 */
  if(RATES === null && !ratesLoading){
    ratesLoading = true;
    loadRates(true)
      .then(()=>{ if(currentReport === key) renderReport(key); })
      .catch(()=>{ RATES = null; toast("⚠ 無法載入行情通報費率，重新整理報表可再試一次"); })
      .finally(()=>{ ratesLoading = false; });
  }
  /* v19：叫工排名、v23：廠商排名——兩者都是統計榜，內容/工程師篩選對它們沒有意義。
     廠商排名同時涵蓋點工與機具，連「廠商」篩選都不該有（篩了就只剩一列，榜就沒意義） */
  const isRank = key === "ranking";
  const isVendorRank = key === "vendorRank";
  const anyRank = isRank || isVendorRank;
  document.getElementById("reportCat").style.display = anyRank ? "none" : "";
  document.getElementById("reportEngineer").style.display = anyRank ? "none" : "";
  document.getElementById("reportVendor").style.display = isVendorRank ? "none" : "";
  document.getElementById("exportSummaryBtn").style.display = anyRank ? "none" : "";
  document.getElementById("exportBtn").textContent = isVendorRank ? "匯出廠商排名 Excel"
    : (isRank ? "匯出排名 Excel" : (key === "labor" ? "匯出明細 Excel" : "匯出明細 CSV"));
  document.getElementById("exportSummaryBtn").textContent = key === "labor" ? "匯出計價彙總 Excel" : "匯出計價彙總 CSV";
  if(isVendorRank){ renderVendorRankReport(); return; }
  if(isRank){ renderRankingReport(); return; }
  populateReportFilters(key);
  const def = REPORT_DEFS[key];
  const rows = def.rows();
  const cnt = document.getElementById("reportCount");
  const filterTags = [
    (reportFrom||reportTo) ? `${reportFrom||"起"} ~ ${reportTo||"今"}` : "",
    reportVendor, reportCat, reportEngineer
  ].filter(Boolean).join("・");
  if(cnt) cnt.textContent = `共 ${rows.length} 筆` + (filterTags ? `（${filterTags}）` : "");
  const el = document.getElementById("reportTable");
  if(!rows.length){ el.innerHTML = '<div class="empty-row">此條件內尚無「'+esc(def.title)+'」資料</div>'; }
  else{
    // v16.3：明細分頁（每頁 10 筆）——CSV 匯出仍取 def.rows() 全量，不受分頁影響
    const { shown, pagerHTML } = paginate("report", rows);
    el.innerHTML = reportTableHTML(def.headers, shown) + pagerHTML;
    bindPager(el, "report", ()=>renderReport(key));
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
    <div class="table-wrap">${reportTableHTML(sum.headers, sum.rows)}</div>`;
}

/* 下載共用收尾（v21.3 收斂三份複本：CSV／xlsx／備份 JSON）
   - 檔名消毒：工地名與篩選標籤屬自由文字，含 / \ : 等非法字元時各瀏覽器行為不一
   - anchor 先掛進 DOM、revoke 延後：iOS Safari 的下載是非同步取用 blob URL，
     同步 revoke 會間歇拿到空檔（桌機 Chrome 不會重現） */
function downloadBlob(blob, filename, msg){
  const safe = String(filename).replace(/[\\/:*?"<>|\x00-\x1F]/g, "-");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safe;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
  toast(msg);
}

/* CSV 單格跳脫。**表頭與資料列共用**——動態表頭（如工種欄名）含逗號時才不會使欄位錯位。
   防 CSV 公式注入：非純數字卻以 = + - @ 開頭的儲存格，前置 ' 讓 Excel 視為文字（節點 14） */
const csvCell = c=>{
  let v = (c===undefined||c===null?"":String(c));
  if(/^[=+\-@]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
  v = v.replace(/"/g,'""');
  return /[,\n"]/.test(v) ? `"${v}"` : v;
};

function downloadCSV(headers, rows, filename){
  const csvLines = [headers.map(csvCell).join(",")].concat(
    rows.map(r=>r.map(csvCell).join(","))
  );
  downloadBlob(new Blob(["﻿" + csvLines.join("\n")], {type:"text/csv;charset=utf-8;"}),
    filename, "CSV 已匯出");
}

/* 多區塊 CSV（v23 廠商排名用）：一個檔案裡放數張表，各自帶標題與表頭、空行分隔。
   點工榜與機具榜的欄位本來就不同（工數 vs 出工天數），硬併成一張表會逼出
   一堆空欄；分區塊反而是 Excel 開起來最好讀的形式。 */
function downloadCSVBlocks(blocks, filename){
  const lines = [];
  blocks.forEach((b, i)=>{
    if(i) lines.push("");
    if(b.title) lines.push(csvCell(b.title));
    lines.push(b.headers.map(csvCell).join(","));
    if(!b.rows.length) lines.push(csvCell("（此期間無資料）"));
    else b.rows.forEach(r=>lines.push(r.map(csvCell).join(",")));
  });
  downloadBlob(new Blob(["﻿" + lines.join("\n")], {type:"text/csv;charset=utf-8;"}),
    filename, "CSV 已匯出");
}

function exportFilterTag(){
  const parts = [];
  if(reportFrom || reportTo) parts.push(`${reportFrom||"起"}至${reportTo||"今"}`);
  if(reportVendor) parts.push(reportVendor);
  if(reportCat) parts.push(reportCat);
  if(reportEngineer) parts.push(reportEngineer);
  return parts.length ? "_" + parts.join("_") : "";
}

/* v21：點工匯出依「工種」展開分欄——不同工種計價費率不同，
   匯出檔每個工種三欄（出工數／加班前2h／加班2h後），供成本部直接計價。
   - 欄序依該期間各工種總量降冪（量大的工種排前面）
   - 無工種列的單（舊制或直填總數）：以其「工作內容類別」為欄名；
     加班歸段口徑與計價彙總一致——僅有 totalOT 的舊單才整包歸前 2 小時
   - 該單有此工種→數字照列（含 0）；沒有此工種→留空白，兩者在計價上意義不同
   - 僅影響匯出檔；畫面上的明細與彙總表維持原樣（匯出永遠全量，計價紅線 3） */
/* ── 計價口徑的唯一權威（v21.3 收斂）──
   加班分段：有 ot2Total 用分段值；「僅有 totalOT」的舊制單整包歸前 2 小時
   （計價紅線 1）。此規則曾以三份副本存在（彙總/排名/分欄），v19.4 即因
   副本分歧出過錯——今後只准改這裡。 */
function otSegments(rep){
  return { ot2: rep.ot2Total != null ? rep.ot2Total : (rep.totalOT || 0),
           otOver: rep.otOverTotal || 0 };
}
/* 單筆已回報單 → 逐工種列 [{type, work, ot2, otOver}]。
   無工種列的單（v11 前舊制或直填總數）以「工作內容類別」為列名。

   0 工單：一般回空陣列（無計價內容）。**但若仍帶加班時數則不可略過**——
   送出驗證只要求 actual=0，加班兩欄是獨立輸入不會被歸零，因此
   {zeroWork:true, ot2Total:3} 是可經 UI 產生的合法資料。略過會讓
   計價彙總算得到 3 小時、而分欄與工種計價表全空，成本部拿到「有時數
   卻無組成」的檔案（計價紅線 4：報表要讓人看見組成）。 */
function reportTypeRows(r){
  const rep = r.report;
  if(!(r.status === "已回報" && rep)) return [];
  if(Array.isArray(rep.workTypes) && rep.workTypes.length){
    return rep.workTypes.map(t=>({ type: t.type || "（未填工種）",
      work: t.work || 0, ot2: t.ot2 || 0, otOver: t.otOver || 0 }));
  }
  const seg = otSegments(rep);
  if(rep.zeroWork && !(seg.ot2 || seg.otOver)) return [];
  return [{ type: (r.categories || []).filter(Boolean).join("、") || "（未填工種）",
            work: rep.zeroWork ? 0 : (rep.actual || 0), ot2: seg.ot2, otOver: seg.otOver }];
}

function laborTypeSplit(records){
  const vol = Object.create(null);   // 欄名 -> 總量（決定欄序）；null 原型避免 __proto__ 類名稱失效
  const per = new Map();             // record.id -> { 欄名: {work, ot2, otOver} }
  records.forEach(r=>{
    const rows = reportTypeRows(r);
    if(!rows.length) return;
    const m = Object.create(null);
    rows.forEach(t=>{
      const e = m[t.type] || (m[t.type] = { work:0, ot2:0, otOver:0 });
      e.work += t.work; e.ot2 += t.ot2; e.otOver += t.otOver;
    });
    per.set(r.id, m);
    Object.entries(m).forEach(([lb, e])=>{
      vol[lb] = (vol[lb] || 0) + e.work + (e.ot2 + e.otOver) / OT_PER_UNIT;
    });
  });
  const labels = Object.keys(vol).sort((a, b)=>vol[b] - vol[a]);
  return { labels, per };
}
/* 分欄格式化一律 fmtRank（最多 4 位小數去尾零）：兩個工作表與彙總必須
   同一小數位，否則同一筆值跨表對帳會出現假差異（v21.3 統一，原 fmt 會 round 2 位） */
const typeSplitHeaders = labels =>
  labels.flatMap(lb=>[`${lb}出工數`, `${lb}加班前2HR(時數)`, `${lb}加班2HR後(時數)`]);
const typeSplitCells = (m, labels) =>
  labels.flatMap(lb=>{
    const e = Object.prototype.hasOwnProperty.call(m, lb) ? m[lb] : null;
    return e ? [fmtRank(e.work), fmtRank(e.ot2), fmtRank(e.otOver)] : ["", "", ""];
  });
/* 廠商 -> 欄名 -> 合計（計價彙總分欄用；null 原型同 laborTypeSplit） */
function typeSplitByVendor(recs, per){
  const byVendor = Object.create(null);
  recs.forEach(r=>{
    const key = r.vendor || "（未填廠商）";
    const t = byVendor[key] || (byVendor[key] = Object.create(null));
    Object.entries(per.get(r.id) || EMPTY_BAG).forEach(([lb, e])=>{
      const g = t[lb] || (t[lb] = { work:0, ot2:0, otOver:0 });
      g.work += e.work; g.ot2 += e.ot2; g.otOver += e.otOver;
    });
  });
  return byVendor;
}

/* CSV 匯出僅機具使用（點工自 v21.1 起走帶格式 xlsx）——勿再加 labor 分支，
   點工分欄口徑只活在 xlsx 路徑，兩處並存曾在審查中被列為口徑分歧風險 */
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
   行情通報（v22.8）：讀 xlsx → 解析費率 → 計價帶入金額
   ==========================================================
   來源是公司按季發布的兩份 xlsx（租工／機具），管理員自行匯入、不經 IT。
   合約 §2.4／§3.9／§4.8／§4.9。 */

/* ---- xlsx 讀取（零依賴） ----------------------------------
   xlsx 就是 ZIP；Excel 存出來的一律 DEFLATE，用瀏覽器內建的
   DecompressionStream('deflate-raw') 解。我們的匯出只寫 STORED（不壓縮），
   讀是另一回事，兩者不共用程式。 */
async function xlsxRows(arrayBuffer){
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder("utf-8");

  let eocd = -1;
  for(let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--){
    if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd < 0) throw new Error("這不是有效的 Excel 檔（找不到 ZIP 目錄）");
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const files = {}, methods = {};
  for(let n = 0; n < count; n++){
    if(dv.getUint32(ptr, true) !== 0x02014b50) throw new Error("Excel 檔結構損毀");
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const cmtLen = dv.getUint16(ptr + 32, true);
    const lho = dv.getUint32(ptr + 42, true);
    const name = td.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    /* 本地檔頭的 extra 長度常與中央目錄不同，位移一定要讀本地那份 */
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    files[name] = buf.subarray(start, start + compSize);
    methods[name] = method;
    ptr += 46 + nameLen + extraLen + cmtLen;
  }
  const inflate = async name => {
    const raw = files[name];
    if(!raw) throw new Error("Excel 檔缺少 " + name);
    if(methods[name] === 0) return td.decode(raw);
    if(typeof DecompressionStream === "undefined")
      throw new Error("此瀏覽器版本不支援解壓縮，請改用 Chrome／Edge 最新版");
    const ds = new DecompressionStream("deflate-raw");
    return td.decode(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
  };

  let shared = [];
  if(files["xl/sharedStrings.xml"]){
    const ss = await inflate("xl/sharedStrings.xml");
    // 一個 <si> 內可能有多個 <t>（rich text），要全部串起來才是完整字串
    shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""));
  }
  const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

  const sheetXml = await inflate("xl/worksheets/sheet1.xml");
  /* ⚠ 不可先用 <row> 切塊：Excel 存出來的檔會帶上百萬個自閉合空列
     （實測 104 萬個、解壓後 40MB），逐列建物件會讓瀏覽器直接卡死。
     只掃「有值的儲存格」，列號從 r="C5" 推出來，空列完全不碰。 */
  const rowMap = new Map();
  for(const cm of sheetXml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
    const body = cm[4] || "";
    if(!body) continue;
    const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
    const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body);
    let val = null;
    if(/t="s"/.test(cm[3]) && vm) val = shared[+vm[1]];
    else if(/t="inlineStr"/.test(cm[3]) && im) val = unesc(im[1]);
    else if(vm) val = unesc(vm[1]);
    if(val == null || val === "") continue;
    const rn = +cm[2];
    if(!rowMap.has(rn)) rowMap.set(rn, {});
    rowMap.get(rn)[cm[1]] = val;
  }
  const rows = [...rowMap.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  if(!rows.length) throw new Error("這份 Excel 沒有資料");
  const head = rows[0], colOf = {};
  for(const c in head) colOf[c] = String(head[c]).trim();
  /* ⚠ 必須連表頭一起回傳：空儲存格不會出現在資料列裡，若拿第一筆「資料列」
     去檢查必要欄位，只要那筆的某欄剛好空白就會誤判成「檔案格式不符」 */
  return {
    headers: Object.values(colOf),
    rows: rows.slice(1).map(cells => {
      const o = {};
      for(const c in cells) if(colOf[c]) o[colOf[c]] = cells[c];
      return o;
    })
  };
}

/* Excel 序列日期 → YYYY-MM-DD。
   ⚠ 起點是 1899-12-30 不是 1900-01-01——Excel 沿用 Lotus 的 1900 閏年錯誤，
   用錯會整整差兩天，跨季時就抓到上一季的費率。 */
function excelSerialToDate(v){
  const n = Number(v);
  if(!isFinite(n) || n <= 0) return typeof v === "string" ? String(v).slice(0, 10) : "";
  const d = new Date(Math.round((n - 25569) * 86400000));   // 25569 = 1970-01-01 的序列值
  const p = x => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const rateNum = s => Number(String(s).replace(/[,\s]/g, "")) || 0;

/* 租工品項 → { work, ot2, otOver, otParsed }（元）。回傳 null 代表這列不是費率列。
   來源檔把費率寫在品項文字裡，有三種寫法：
     打石工3,000元/工、加班前2hr=499元、第3hr起=623元   ← 分兩段
     打石工2,800元/工、加班466元/HR                      ← 單一費率
     打石工2,800元/工、打石工加班466元/HR                ← 前綴帶工種名
   沒寫「第3hr起」者視為不分段（otOver = ot2）。
   ⚠ otParsed 一定要留著：品項完全沒寫加班費率時 ot2/otOver 會是 0，
   若不區分「沒寫」與「真的是 0」，有加班時數的單會用 0 元計價卻還算成功。 */
function parseLaborRateItem(itemText){
  const t = String(itemText || "").replace(/\s+/g, "");
  const mWork = /([\d,]+)元\/工/.exec(t);
  if(!mWork) return null;
  const m2 = /(?:加班)?前2hr[=＝]([\d,]+)/i.exec(t);
  const m3 = /第3hr起[=＝]([\d,]+)/i.exec(t);
  const mFlat = /加班([\d,]+)元\/HR/i.exec(t);
  const ot2 = m2 ? rateNum(m2[1]) : (mFlat ? rateNum(mFlat[1]) : 0);
  return { work: rateNum(mWork[1]), ot2, otOver: m3 ? rateNum(m3[1]) : ot2,
           otParsed: !!(m2 || m3 || mFlat) };
}

/* 機具品項 → 計價單位。單位欄雖有 天/HR/月/趟，但同樣是 HR，
   可能是加班費也可能是逐時計費的正常工時，得再看品項文字。 */
function classifyEquipItem(itemText, unit){
  const t = String(itemText || ""), u = String(unit || "").trim();
  if(u === "HR") return /加班費?|夜間|小夜|以後|以前/.test(t) ? "加班" : "時租";
  if(u === "月" || /包月|月租/.test(t)) return "月租";
  if(u === "趟") return "趟次";
  if(/半天|4HR/.test(t)) return "半天";
  return "全天";
}

/* 原始列 → 正規化費率列（合約 §4.8）。非費率列回 null（匯入時濾掉） */
function normalizeRateRow(kind, row){
  const base = {
    vendorCode: String(row["供應商"] || "").trim(),
    vendorName: String(row["供應商名稱"] || "").trim(),
    region: String(row["區域別"] || "").trim(),
    note: String(row["說明"] || "").trim(),
    item: String(row["品項"] || "").trim(),
    unit: String(row["單位"] || "").trim(),
    price: rateNum(row["單位價格"])
  };
  if(!base.vendorCode || !base.item) return null;
  /* ⚠ 單價 0 或空白一律當成「這列不可用」而非「免費」——rateNum 會把空白、
     文字都收斂成 0，放行的話報表會印出金額 0，那是計價表上最危險的數字 */
  if(!(base.price > 0)) return null;
  base.effectiveFrom = excelSerialToDate(row["生效日期"]);
  if(kind === "labor"){
    const r = parseLaborRateItem(base.item);
    if(!r) return null;                       // 加保加價說明等非費率列
    if(!(r.work > 0)) return null;
    return Object.assign(base, r);
  }
  return Object.assign(base, { chargeType: classifyEquipItem(base.item, base.unit) });
}

/* 整份 xlsx → { effectiveFrom, rows, total, skipped } */
function buildRateBook(kind, parsed){
  const need = ["供應商", "供應商名稱", "單位價格", "品項", "單位", "生效日期"];
  // 用**表頭**檢查，不可用第一筆資料列——空儲存格不會出現在資料列裡（見 xlsxRows）
  const miss = need.filter(h => !parsed.headers.includes(h));
  if(miss.length) throw new Error("欄位不符，缺少：" + miss.join("、") + "（請確認是行情通報匯入檔）");
  const rows = [];
  let skipped = 0;
  for(const r of parsed.rows){
    const n = normalizeRateRow(kind, r);
    if(n) rows.push(n); else skipped++;
  }
  if(!rows.length) throw new Error("這份檔案解析不出任何費率列");
  /* 生效日取**留用列**裡最常見的那個，不可取全部原始列的最小值：
     被濾掉的非費率列若帶著一個更舊的日期，整季就會被往前挪，
     而 effectiveFrom 又是伺服器端的季別唯一鍵——會靜默蓋掉上一季 */
  const tally = new Map();
  for(const r of rows) if(r.effectiveFrom) tally.set(r.effectiveFrom, (tally.get(r.effectiveFrom) || 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const effectiveFrom = ranked.length ? ranked[0][0] : localDate();
  const mixedDates = ranked.length > 1 ? ranked.length : 0;
  return { effectiveFrom, rows, total: parsed.rows.length, skipped, mixedDates };
}

/* ---- 費率書快取與查詢 ---- */
let RATES = null;          // { labor:[book], equipment:[book] }；null＝尚未抓取（失敗也回到 null 以便重試）
let ratesLoading = false;  // 防重入；不可用「空的 RATES」當佔位（見 renderReport 註解）
async function loadRates(force){
  if(RATES && !force) return RATES;
  const got = await api("GET", null, { rates: "1" });   // 失敗就讓錯誤往上拋，RATES 維持 null
  RATES = (got && Array.isArray(got.labor) && Array.isArray(got.equipment))
    ? got : { labor: [], equipment: [] };
  return RATES;
}
/* 取「生效日 ≤ 出工日」之中最新的一季（合約 §4.9）。查無回 null——
   絕不可退化成 0，0 會被讀成「免費」 */
function bookFor(kind, workDate){
  if(!RATES || !Array.isArray(RATES[kind])) return null;
  const usable = RATES[kind].filter(b => b.effectiveFrom <= workDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return usable[0] || null;
}

/* 依「目前選的廠商＋出工日」填充機具回報的兩個品項下拉。
   主品項排除加班列、加班下拉只列加班列——兩者本來就是不同用途的列。 */
function fillEquipRateSelects(workDate, selMain, selOt){
  const main = document.getElementById("e_rateItem");
  const ot = document.getElementById("e_rateOtItem");
  const hint = document.getElementById("e_rateHint");
  if(!main || !ot) return;
  const vendor = getCombo("cb_e_vendor").trim();
  const book = bookFor("equipment", workDate || localDate());
  const code = rateBindings().equipment[vendor];
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  /* 費率書抓不到／未綁定時同樣不能把已存的品項洗掉——保留成唯一選項 */
  const reset = msg => {
    const hold = (sel) => opt("", "（不計價）", sel ? "x" : "")
      + (sel ? opt(sel, `${sel}（目前無費率可對照）`, sel) : "");
    main.innerHTML = hold(selMain);
    ot.innerHTML = hold(selOt);
    if(hint) hint.textContent = msg;
  };
  if(!vendor) return reset("請先選機具廠商");
  if(!book) return reset("此出工日尚無適用的行情通報季別");
  if(!code) return reset(`「${vendor}」尚未綁定行情通報供應商（請管理員於設定頁綁定）`);
  const rows = book.rows.filter(r => r.vendorCode === code);
  if(!rows.length) return reset("本季查無該供應商的品項");
  const otRows = rows.filter(r => r.chargeType === "加班");
  const mainRows = rows.filter(r => r.chargeType !== "加班");
  /* 已存的品項若在本季找不到（換季後品項改名），**不可讓它掉回「（不計價）」**
     ——使用者只要再開一次回報單按儲存，原本選的品項就永久消失了。
     改成保留成一個標示「本季查無」的選項，由人決定要不要改。 */
  const keep = (list, sel) => (sel && !list.some(r => r.item === sel))
    ? opt(sel, `${sel}　⚠ 本季查無此品項`, sel) : "";
  main.innerHTML = opt("", "（不計價）", selMain || "") + keep(mainRows, selMain)
    + mainRows.map(r => opt(r.item, `${r.item}　${r.price}元/${r.unit}`, selMain || "")).join("");
  ot.innerHTML = opt("", "（不計價）", selOt || "") + keep(otRows, selOt)
    + otRows.map(r => opt(r.item, `${r.item}　${r.price}元/${r.unit}`, selOt || "")).join("");
  if(hint) hint.textContent = `${book.label}（${book.effectiveFrom} 起）：主品項 ${mainRows.length} 項、加班費率 ${otRows.length} 項`;
}

/* ---- 綁定（各站 config.rateBindings，合約 §4.8） ----
   租工綁「供應商編號＋說明」：說明欄（例「打石工-一般工地」）跨季穩定，
   **不可綁品項文字**——租工的品項把價格寫在裡面，每季都會變。
   機具只綁到廠商層級，實際品項由工程師回報時挑（2026-08-10 裁示）。 */
function rateBindings(){
  const b = (cur() && cur().config && cur().config.rateBindings) || {};
  return { labor: b.labor || {}, equipment: b.equipment || {} };
}
const laborBindKey = (vendor, type) => `${vendor}|${type}`;

/* 金額計算一律回 { amount, why }：
   amount 為 null 時 why 說明原因，報表要顯示原因而不是印 0。
   **絕不可把查不到的費率當成 0** —— 0 在計價表上會被讀成「免費」。 */
const NO_RATE = why => ({ amount: null, why });

/* 點工費率查找：本單廠商＋工種 → 費率列。回 {rate} 或 {why}。
   ⚠ laborAmount 與代辦扣抵（laborAgentDeductions）**共用這一份**——
     同一套查找只准有一處，v19.4 就是因為副本分歧算錯過。 */
function laborRateRow(book, binds, vendor, type){
  const bind = binds[laborBindKey(vendor, type)];
  if(!bind) return { why: `未綁定費率：${type}` };
  const rate = book.rows.find(x => x.vendorCode === bind.vendorCode && x.note === bind.note);
  if(!rate) return { why: `本季查無綁定的費率列：${type}` };
  return { rate };
}

function laborAmount(r){
  const rep = r.report;
  if(!(r.status === "已回報" && rep)) return NO_RATE("未回報");
  const book = bookFor("labor", r.date);
  if(!book) return NO_RATE("該出工日無適用季別");
  const binds = rateBindings().labor;
  const vendor = recVendor(r);
  let total = 0;
  const parts = [];
  const rows = reportTypeRows(r);            // 逐工種展開的唯一權威（計價紅線 1）
  if(!rows.length) return NO_RATE("無工種明細");
  for(const row of rows){
    const got = laborRateRow(book, binds, vendor, row.type);
    if(got.why) return NO_RATE(got.why);
    const rate = got.rate;
    /* 品項沒寫加班費率、這張單卻有加班時數 → 不可用 0 元帶過去而還算成功 */
    if((row.ot2 || row.otOver) && !rate.otParsed)
      return NO_RATE(`有加班時數但行情通報未載明加班費率：${row.type}`);
    const amt = row.work * rate.work + row.ot2 * rate.ot2 + row.otOver * rate.otOver;
    total += amt;
    parts.push(`${row.type} ${fmt(row.work)}工×${rate.work}`
      + (row.ot2 ? `＋前2h ${fmt(row.ot2)}×${rate.ot2}` : "")
      + (row.otOver ? `＋3h起 ${fmt(row.otOver)}×${rate.otOver}` : ""));
  }
  return { amount: Math.round(total), why: "", detail: parts.join("；") };
}

/* 機具計價的「數量與單位」——依主品項的 chargeType 決定用天數還是時數（合約 §4.9）。
   ⚠ equipAmount、代辦扣抵、以及表單上代辦欄位的單位標籤**共用這一份**，
     三處各自詮釋就會出現「畫面標小時、計價算天數」這種對不起來的狀況。 */
function equipQtyFor(main, rep){
  if(main.chargeType === "全天") return { qty: rep.days || 0, unit: "天" };
  if(main.chargeType === "時租") return { qty: rep.actualHours || 0, unit: "小時" };
  return { qty: null, unit: "",
           why: `所選品項為「${main.chargeType}」計價，系統無對應數量欄位——請改選全天或時租品項` };
}

function equipAmount(x){
  const rep = x.report;
  if(!(x.status === "已回報" && rep)) return NO_RATE("未回報");
  const book = bookFor("equipment", x.date);
  if(!book) return NO_RATE("該出工日無適用季別");
  const code = rateBindings().equipment[recVendor(x)];
  if(!code) return NO_RATE("廠商未綁定行情通報");
  const pick = item => item ? book.rows.find(r => r.vendorCode === code && r.item === item) : null;
  const main = pick(rep.rateItem);
  if(rep.rateItem && !main) return NO_RATE("本季查無所選品項");
  if(!main) return NO_RATE("未選計價品項");
  const ot = rep.otHours || 0;
  /* ⚠ 主品項的計價單位決定要乘哪個數量，不是一律乘天數。
     行情通報同一台機具會拆成 全天／半天／時租／月租／趟次 多列，
     全部當成「天數×單價」會把時租單算成 1/8、把月租單算成 22 倍。
     只有數量依據明確的兩種能自動計價，其餘擋下並說明——
     半天/月租/趟次 的數量（幾個半天、幾個月、幾趟）系統目前沒有欄位可填。 */
  const q = equipQtyFor(main, rep);
  if(q.qty == null) return NO_RATE(q.why);
  const qty = q.qty, unitLabel = q.unit;
  if(!(qty > 0)) return NO_RATE(`所選品項為「${main.chargeType}」計價，但${unitLabel}數為 0`);

  let total = qty * main.price;
  const parts = [`${fmt(qty)}${unitLabel}×${main.price}`];
  if(ot){
    const otRow = pick(rep.rateOtItem);
    if(!otRow) return NO_RATE("有加班時數但未選（或查無）加班費率品項");
    total += ot * otRow.price;
    parts.push(`加班 ${fmt(ot)}h×${otRow.price}`);
  }
  return { amount: Math.round(total), why: "", detail: parts.join("＋") };
}

/* ==========================================================
   代辦扣抵（v23，合約 §4.10）
   回傳 [{ vendor, amount, why, detail }]——一列一個責任歸屬廠商。
   ⚠ 費率一律取「**本單廠商**」的，不是責任歸屬廠商的：
     扣的是我們實際付出去的錢；拿對方的費率算會得出一個從未發生過的金額。
   查無費率時該列 amount=null 並記原因，與 §4.9 一致——**絕不可退化成 0**。
   ========================================================== */
function laborAgentDeductions(r){
  const rep = r.report;
  const items = (rep && rep.agentItems) || [];
  if(!items.length) return [];
  const book = bookFor("labor", r.date);
  const binds = rateBindings().labor;
  const vendor = recVendor(r);            // 本單廠商＝費率來源
  return items.map(a=>{
    if(!book) return { vendor: a.vendor, amount: null, why: "該出工日無適用季別" };
    const got = laborRateRow(book, binds, vendor, a.type);
    if(got.why) return { vendor: a.vendor, amount: null, why: got.why };
    const rate = got.rate;
    const ot2 = a.ot2 || 0, otOver = a.otOver || 0;
    if((ot2 || otOver) && !rate.otParsed)
      return { vendor: a.vendor, amount: null, why: `有加班時數但行情通報未載明加班費率：${a.type}` };
    const amt = (a.work||0) * rate.work + ot2 * rate.ot2 + otOver * rate.otOver;
    return { vendor: a.vendor, amount: Math.round(amt), why: "",
             detail: `${a.type} ${fmt(a.work||0)}工×${rate.work}`
                   + (ot2 ? `＋前2h ${fmt(ot2)}×${rate.ot2}` : "")
                   + (otOver ? `＋3h起 ${fmt(otOver)}×${rate.otOver}` : "") };
  });
}

function equipAgentDeductions(x){
  const rep = x.report;
  const items = (rep && rep.agentItems) || [];
  if(!items.length) return [];
  const book = bookFor("equipment", x.date);
  const code = rateBindings().equipment[recVendor(x)];
  const main = (book && code && rep.rateItem)
    ? book.rows.find(r => r.vendorCode === code && r.item === rep.rateItem) : null;
  return items.map(a=>{
    if(!book) return { vendor: a.vendor, amount: null, why: "該出工日無適用季別" };
    if(!code) return { vendor: a.vendor, amount: null, why: "廠商未綁定行情通報" };
    if(!main) return { vendor: a.vendor, amount: null, why: "未選（或本季查無）計價品項" };
    const q = equipQtyFor(main, rep);
    if(q.qty == null) return { vendor: a.vendor, amount: null, why: q.why };
    return { vendor: a.vendor, amount: Math.round((a.qty||0) * main.price), why: "",
             detail: `${fmt(a.qty||0)}${q.unit}×${main.price}` };
  });
}

const agentDeductions = (rec, kind) => kind === "labor" ? laborAgentDeductions(rec) : equipAgentDeductions(rec);

/* 報表用：有金額印金額，沒有就印原因（外面加括號以示區別） */
const amountCell = a => a.amount == null ? `（${a.why}）` : String(a.amount);
/* 金額 ＋ 計價組成兩格。**組成一定要印出來**——計價紅線 4：報表不能只給一個
   算完的數字，成本部要能逐項核對「3工×3000＋前2h 2×499」才驗得動。 */
const amountCells = a => [amountCell(a), a.amount == null ? "" : (a.detail || "")];

/* ---- 設定頁：匯入與綁定 UI ---- */
let rateImportKind = "labor";

async function importRateFile(file){
  const msg = document.getElementById("rateImportMsg");
  const kindLabel = rateImportKind === "labor" ? "租工" : "機具";
  msg.textContent = `讀取中…（${file.name}）`;
  let book;
  try{
    const raw = await xlsxRows(await file.arrayBuffer());
    book = buildRateBook(rateImportKind, raw);
  }catch(e){
    msg.textContent = "⚠ " + (e.message || e);
    return;
  }
  const label = /(\d+)年.*?第?(\d)季/.exec(file.name);
  const ok = confirm(`確認匯入${kindLabel}行情通報？\n\n`
    + `生效日期：${book.effectiveFrom}\n`
    + `可用費率列：${book.rows.length} 筆（來源 ${book.total} 筆，略過 ${book.skipped} 筆非費率列）\n\n`
    + `同一生效日的既有資料會被取代，且影響所有使用者。`);
  if(!ok){ msg.textContent = "已取消"; return; }
  try{
    const resp = await api("POST", {
      op: "rateBook", kind: rateImportKind,
      label: label ? `${label[1]}Q${label[2]}` : book.effectiveFrom,
      effectiveFrom: book.effectiveFrom, rows: book.rows
    });
    await loadRates(true);
    msg.textContent = `✔ 已匯入 ${book.rows.length} 筆（略過 ${book.skipped} 筆非費率列）`
      + (resp.dropped ? `；已丟棄最舊的 ${resp.dropped} 季` : "");
    renderRateBooks();
    renderRateBindings();
    toast(`${kindLabel}行情通報已匯入（所有人皆可看到）`);
  }catch(e){
    msg.textContent = "⚠ 上傳失敗，資料未寫入，請檢查網路後再試";
  }
}

function renderRateBooks(){
  const box = document.getElementById("rateBooksBox");
  if(!box) return;
  const all = [];
  for(const kind of ["labor", "equipment"]){
    for(const b of (RATES && RATES[kind]) || [])
      all.push({ kind, label: b.label, effectiveFrom: b.effectiveFrom, importedAt: b.importedAt, n: b.rows.length });
  }
  if(!all.length){ box.innerHTML = '<div class="empty-row">尚未匯入</div>'; return; }
  all.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || a.kind.localeCompare(b.kind));
  box.innerHTML = fixedTableOpen(["類別", "季別", "生效日", "匯入日", "費率列數", "操作"], { actionW: 90 })
    + "<tbody>" + all.map(b => `<tr>
        <td>${b.kind === "labor" ? "租工" : "機具"}</td><td>${esc(b.label)}</td>
        <td>${esc(b.effectiveFrom)}</td><td>${esc(b.importedAt || "")}</td><td>${b.n}</td>
        <td class="row-actions"><button type="button" class="btn-mini btn-del rate-del"
          data-kind="${b.kind}" data-eff="${esc(b.effectiveFrom)}">刪除</button></td>
      </tr>`).join("") + "</tbody></table>";
  box.querySelectorAll(".rate-del").forEach(btn => btn.addEventListener("click", async ()=>{
    if(!confirm(`確定刪除 ${btn.dataset.eff} 這一季嗎？\n此操作影響所有使用者。`)) return;
    try{
      await api("POST", { op: "deleteRateBook", kind: btn.dataset.kind, effectiveFrom: btn.dataset.eff });
      await loadRates(true); renderRateBooks(); renderRateBindings();
      toast("已刪除該季費率");
    }catch(e){ toast("⚠ 刪除失敗，請檢查網路"); }
  }));
}

/* 前綴比對建議：系統用簡稱（工地自己打的）、行情通報用公司全名，
   實測 97% 的單據能唯一命中且零歧義（v22.8 節點文件）。
   只有唯一命中才自動建議——命中多家時留空，讓管理員自己選。 */
function suggestVendorCode(vendor, rows){
  const hit = [...new Set(rows.filter(r => r.vendorName.startsWith(vendor)).map(r => r.vendorCode))];
  return hit.length === 1 ? hit[0] : "";
}

function renderRateBindings(){
  const box = document.getElementById("rateBindBox");
  if(!box || !cur()) return;
  const lb = bookFor("labor", localDate()), eb = bookFor("equipment", localDate());
  if(!lb && !eb){ box.innerHTML = '<div class="empty-row">請先匯入行情通報</div>'; return; }
  const binds = rateBindings();
  const site = cur();
  const html = [];

  /* 租工：逐「實際用過的廠商 × 工種」列出 */
  if(lb){
    const pairs = new Map();
    for(const r of site.labor){
      const v = recVendor(r);
      if(!v) continue;
      for(const row of reportTypeRows(r)) pairs.set(`${v}|${row.type}`, { vendor: v, type: row.type });
    }
    html.push(`<div class="summary-title">租工（${lb.label}）</div>`);
    if(!pairs.size) html.push('<div class="empty-row">本工地尚無點工回報資料，無需綁定</div>');
    else html.push(fixedTableOpen(["廠商", "工種", "對應行情通報（供應商－說明）"]) + "<tbody>"
      + [...pairs.values()].sort((a, b) => a.vendor.localeCompare(b.vendor, "zh-Hant")).map(p => {
        const key = laborBindKey(p.vendor, p.type);
        const cur0 = binds.labor[key];
        const sug = suggestVendorCode(p.vendor, lb.rows);
        const opts = lb.rows
          /* 有唯一建議就只列那家，避免上百筆難選；
             但**已綁定的那家一定要列出來**，否則手動綁到別家的會顯示成「未綁定」，
             下次儲存就被當成使用者取消而清掉 */
          .filter(r => !sug || r.vendorCode === sug || (cur0 && r.vendorCode === cur0.vendorCode))
          .map(r => {
            const val = `${r.vendorCode}|${r.note}`;
            const sel = cur0 && cur0.vendorCode === r.vendorCode && cur0.note === r.note;
            return `<option value="${esc(val)}"${sel ? " selected" : ""}>${esc(r.vendorName)}－${esc(r.note)}　(${r.work}/${r.ot2}/${r.otOver})</option>`;
          });
        return `<tr><td>${esc(p.vendor)}</td><td>${esc(p.type)}</td><td>
          <select class="report-select rate-bind-labor" data-key="${esc(key)}">
            <option value="">（未綁定）</option>${opts.join("")}
          </select>${sug ? "" : '<span class="tag warn">前綴比對不到，請自行選擇</span>'}</td></tr>`;
      }).join("") + "</tbody></table>");
  }

  /* 機具：只綁廠商 */
  if(eb){
    const vendors = [...new Set(site.equipment.map(recVendor).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const supp = [...new Map(eb.rows.map(r => [r.vendorCode, r.vendorName])).entries()];
    html.push(`<div class="summary-title" style="margin-top:14px;">機具（${eb.label}）</div>`);
    if(!vendors.length) html.push('<div class="empty-row">本工地尚無機具資料，無需綁定</div>');
    else html.push(fixedTableOpen(["廠商", "對應行情通報供應商"]) + "<tbody>"
      + vendors.map(v => {
        const cur0 = binds.equipment[v] || suggestVendorCode(v, eb.rows);
        return `<tr><td>${esc(v)}</td><td>
          <select class="report-select rate-bind-equip" data-vendor="${esc(v)}">
            <option value="">（未綁定）</option>
            ${supp.map(([code, name]) => `<option value="${esc(code)}"${code === cur0 ? " selected" : ""}>${esc(name)}</option>`).join("")}
          </select></td></tr>`;
      }).join("") + "</tbody></table>");
  }
  html.push('<div class="actions" style="margin-top:10px;"><button type="button" id="saveRateBinds" class="btn-primary btn-sm">儲存綁定</button></div>');
  box.innerHTML = html.join("");
  const btn = document.getElementById("saveRateBinds");
  if(btn) btn.addEventListener("click", saveRateBindings);
}

async function saveRateBindings(){
  /* ⚠ 必須以既有綁定為底再套用畫面上的異動，不可整包重建：
     沒渲染出來的區塊（例如本季沒有租工費率書時整個租工區塊不存在）
     若被當成「使用者清空」，一次儲存就會把另一類的綁定全部抹掉。
     只有畫面上真的出現的那些鍵才會被更新／刪除。 */
  const cfgSite = MASTER.currentSite;              // 快照：await 期間若切站不可寫錯站
  const prev = rateBindings();
  const labor = Object.assign({}, prev.labor);
  const equipment = Object.assign({}, prev.equipment);
  let nL = 0, nE = 0;
  document.querySelectorAll(".rate-bind-labor").forEach(sel => {
    nL++;
    if(!sel.value){ delete labor[sel.dataset.key]; return; }
    const [vendorCode, ...rest] = sel.value.split("|");
    labor[sel.dataset.key] = { vendorCode, note: rest.join("|") };
  });
  document.querySelectorAll(".rate-bind-equip").forEach(sel => {
    nE++;
    if(sel.value) equipment[sel.dataset.vendor] = sel.value;
    else delete equipment[sel.dataset.vendor];
  });
  if(!nL && !nE){ toast("畫面上沒有可儲存的綁定"); return; }
  const cfg = Object.assign({}, SITE_CACHE[cfgSite].config, { rateBindings: { labor, equipment } });
  try{
    await api("POST", { op: "config", site: cfgSite, config: cfg });
    SITE_CACHE[cfgSite].config = cfg;
    toast(`「${cfgSite}」綁定已儲存（租工 ${Object.keys(labor).length} 筆、機具 ${Object.keys(equipment).length} 筆）`);
  }catch(e){ toast("⚠ 儲存失敗，請檢查網路後再試"); }
}

function initRatesPanel(){
  const fileInput = document.getElementById("rateFileInput");
  if(!fileInput) return;
  const pick = kind => { rateImportKind = kind; fileInput.value = ""; fileInput.click(); };
  document.getElementById("importLaborRates").addEventListener("click", ()=>pick("labor"));
  document.getElementById("importEquipRates").addEventListener("click", ()=>pick("equipment"));
  fileInput.addEventListener("change", ()=>{ if(fileInput.files[0]) importRateFile(fileInput.files[0]); });
  /* ⚠ 這裡只掛監聽，不在此渲染：initRatesPanel 在 boot() 之前跑，
     那時 cur() 還是 undefined，畫出來的會是空的且再也不會更新。
     實際渲染交給 renderRatesPanel()，由 renderAll() 每次（含切換工地）呼叫。 */
}

/* 由 renderAll() 呼叫：資料就緒後、以及每次切換工地都要重畫，
   否則畫面會留著上一個工地的選單，按儲存就把 A 站的綁定寫進 B 站 */
function renderRatesPanel(){
  if(!READY || !cur()) return;
  loadRates().then(()=>{ renderRateBooks(); renderRateBindings(); }).catch(()=>{});
}

/* ==========================================================
   廠商排名（v23）：2026-08-05 會議「建立廠商使用數量與費用排行榜」。

   **點工與機具分成兩張榜**（會議裁示）——單位不同（工數 vs 出工天數），
   混在一張榜排名等於把不可比的東西相加。排名依「使用數量」降冪，
   費用同列呈現；未能計價的單獨立成一欄，不併進金額裡靜靜地少算
   （計價紅線 4：報表要讓人看見組成）。

   第三張表＝**代辦扣抵彙總**，依責任歸屬廠商歸戶——這就是會議要的
   「代付代扣由系統自動統計，排除人工作業」。
   ========================================================== */
function buildVendorRanking(kind){
  const recs = cur()[kind].filter(r => inReportRange(r.date) && r.status === "已回報" && r.report);
  const g = new Map();
  recs.forEach(r=>{
    const v = recVendor(r) || "（未填廠商）";
    const e = g.get(v) || { vendor: v, count: 0, work: 0, ot2: 0, otOver: 0, days: 0, ot: 0,
                            agWork: 0, agOt: 0, amount: 0, noRate: 0 };
    e.count++;
    if(kind === "labor"){
      // 逐工種展開與加班歸段一律走 reportTypeRows（口徑唯一權威，v21.3）
      reportTypeRows(r).forEach(t=>{ e.work += t.work; e.ot2 += t.ot2; e.otOver += t.otOver; });
    }else{
      e.days += r.report.days || 0;
      e.ot += r.report.otHours || 0;
    }
    /* v24 代辦扣工：這些工是向本單廠商叫的，但成本歸屬另一家，
       因此要從本單廠商的排名扣回。**扣的量與原始量分欄並存**——
       只給一個扣完的淨值會看不出組成（計價紅線 4）。 */
    const ag = agentSummary(r.report, kind);
    if(ag){ e.agWork += ag.work; e.agOt += ag.hours; }
    const amt = kind === "labor" ? laborAmount(r) : equipAmount(r);
    if(amt.amount == null) e.noRate++; else e.amount += amt.amount;
    g.set(v, e);
  });
  const rows = [...g.values()];
  // 點工的「使用數量」沿用叫工排名的總工數口徑（本工＋加班÷8）；機具用出工天數
  rows.forEach(e=>{
    e.units = kind === "labor" ? totalUnits(e) : e.days;
    // 代辦扣抵量換算成同一單位：點工＝工數（加班÷8）、機具＝數量
    e.agUnits = kind === "labor" ? (e.agWork + e.agOt / OT_PER_UNIT) : e.agWork;
    e.netUnits = e.units - e.agUnits;
  });
  rows.sort((a,b)=> b.netUnits - a.netUnits || b.amount - a.amount);
  return rows;
}

function buildAgentDeductionSummary(){
  const g = new Map();
  ["labor","equipment"].forEach(kind=>{
    cur()[kind].filter(r => inReportRange(r.date) && r.status === "已回報" && r.report)
      .forEach(r=>{
        agentDeductions(r, kind).forEach(d=>{
          const e = g.get(d.vendor) || { vendor: d.vendor, rows: 0, amount: 0, noRate: 0, whys: new Set() };
          e.rows++;
          if(d.amount == null){ e.noRate++; e.whys.add(d.why); } else e.amount += d.amount;
          g.set(d.vendor, e);
        });
      });
  });
  return [...g.values()].sort((a,b)=> b.amount - a.amount);
}

/* 兩張排行榜的金額欄跟著 PRICING_UI 走；代辦扣抵那張**刻意保留金額**（見 PRICING_UI 說明） */
const VRANK_LABOR_COLS = ["排名","廠商","已回報單數","本工","加班前2h","加班2h後","總工數","代辦扣工","淨工數",
  ...(PRICING_UI ? ["計價金額","未能計價單數"] : [])];
const VRANK_EQUIP_COLS = ["排名","廠商","已回報單數","出工天數","加班時數","代辦扣抵","淨出工天數",
  ...(PRICING_UI ? ["計價金額","未能計價單數"] : [])];
const VRANK_DED_COLS   = ["責任歸屬廠商","代辦列數","代扣金額","未能計價列數","未能計價原因"];

const vrankLaborRow = (e,i) => [i+1, e.vendor, e.count, fmtRank(e.work),
  e.ot2 ? fmtRank(e.ot2) : "", e.otOver ? fmtRank(e.otOver) : "", fmtRank(e.units),
  e.agUnits ? "-" + fmtRank(e.agUnits) : "", fmtRank(e.netUnits),
  ...(PRICING_UI ? [e.amount, e.noRate || ""] : [])];
const vrankEquipRow = (e,i) => [i+1, e.vendor, e.count, fmtRank(e.days),
  e.ot ? fmtRank(e.ot) : "", e.agUnits ? "-" + fmtRank(e.agUnits) : "", fmtRank(e.netUnits),
  ...(PRICING_UI ? [e.amount, e.noRate || ""] : [])];
const vrankDedRow = e => [e.vendor, e.rows, e.amount, e.noRate || "", [...e.whys].join("；")];

/* ==========================================================
   橫向長條圖（v23.1；零依賴 inline SVG）

   為什麼是橫條而不是直條：類別是廠商／工程師名稱（中文長字串），
   直條圖的 X 軸標籤會被迫旋轉或截斷；橫條讓名稱正常水平排列。

   無障礙與可讀性（依 UI 準則 §10）：
   - **圖表不取代表格**：下方一律保留原本的數值表，圖只是先給一眼的比例感
   - 每條直接標數值（direct labeling），不必對照座標軸
   - 顏色不是唯一資訊來源——長度＋數值文字本身就足以判讀
   - role="img" ＋ aria-label 給讀屏軟體一句話摘要
   - 只畫前 N 名，其餘在圖下明講「另有 N 家未列出」（不做無聲截斷）
   ========================================================== */
function hBarChart(rows, opts){
  /* tableBelow：呼叫端下方是否真的有數值表。報表頁有（預設 true），
     戰情室的排名只有圖、沒有表——那裡若照樣寫「完整資料見下方表格」就是假訊息，
     使用者會往下找一張不存在的表。 */
  const o = Object.assign({ max: 10, unit: "", title: "", tableBelow: true }, opts || {});
  if(!rows.length) return '<div class="empty-row">此期間無資料可繪製</div>';
  const shown = rows.slice(0, o.max);
  const rest = rows.length - shown.length;
  const peak = Math.max(...shown.map(r => r.value), 0) || 1;
  /* 用 HTML/CSS 長條而不是 SVG：長度只要一個百分比寬度就成立，
     天生隨容器縮放；SVG 要靠 viewBox 換算，中文標籤與數值還得自己排版。 */
  const bars = shown.map((r, i) => {
    const pct = r.value > 0 ? Math.max((r.value / peak) * 100, 1.5) : 0;   // 極小值仍留一絲寬度，才看得出「有但很少」
    return `<div class="hbar-row">
      <span class="hbar-rank">${i + 1}</span>
      <span class="hbar-name" title="${esc(String(r.label))}">${esc(String(r.label))}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${pct}%"></span></span>
      <span class="hbar-val">${esc(fmtRank(r.value))}${esc(o.unit)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</span>
    </div>`;
  }).join("");
  const first = shown[0];
  const summary = `${o.title}：共 ${rows.length} 項，第一名 ${first.label} ${fmtRank(first.value)}${o.unit}`;
  return `<div class="hbar" role="img" aria-label="${esc(summary)}">${bars}</div>`
    + (rest > 0 ? `<p class="hint">圖只列前 ${o.max} 名，另有 ${rest} 項未列出${o.tableBelow ? "——完整資料見下方表格" : ""}。</p>` : "");
}

function vrankTableHTML(title, cols, rows, note){
  const body = rows.length
    ? rows.map(r=>"<tr>" + r.map((c,i)=>`<td${i===0||i>=2 ? ' class="num"' : ""}>${esc(String(c))}</td>`).join("") + "</tr>").join("")
    : `<tr><td colspan="${cols.length}" class="empty-row">此期間無資料</td></tr>`;
  return `<div class="summary-title">${esc(title)}</div>
    <div class="table-wrap"><table class="rank-table">
    <thead><tr>${cols.map(c=>`<th class="num">${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody></table></div>`
    + (note ? `<p class="hint">${note}</p>` : "");
}

function renderVendorRankReport(){
  const el = document.getElementById("reportTable");
  const sumEl = document.getElementById("reportSummary");
  const cnt = document.getElementById("reportCount");
  if(!el) return;
  if(sumEl) sumEl.innerHTML = "";
  const lab = buildVendorRanking("labor");
  const eq = buildVendorRanking("equipment");
  const ded = buildAgentDeductionSummary();
  const period = reportPeriodLabel();
  if(cnt) cnt.textContent = `${period}・點工 ${lab.length} 家・機具 ${eq.length} 家`
    + (ded.length ? `・代辦扣抵 ${ded.length} 家` : "");

  /* v23.1：先給圖再給表。排名的重點是「誰多誰少、差多少」，
     長條的長度一眼就答得出來；精確數字仍由下方表格負責（§10 圖不取代表） */
  const chartOf = (rows, unit, title) => hBarChart(
    rows.map(e=>({ label: e.vendor, value: e.netUnits, sub: `${e.count} 單` })), { unit, title });

  el.innerHTML =
    chartOf(lab, " 工", "點工廠商排名")
    + vrankTableHTML(`點工廠商排名（${period}・依淨工數）`, VRANK_LABOR_COLS, lab.map(vrankLaborRow),
      "<strong>總工數＝本工＋(加班前2h＋加班2h後)÷8</strong>（工數以 8 小時換算），與叫工排名同一口徑。"
      + "<strong>淨工數＝總工數－代辦扣工</strong>——代辦的部分成本歸屬另一家，排名依淨工數；扣抵量另列一欄，看得出組成。"
      + (PRICING_UI ? "「未能計價單數」為查無費率的單——那些單的金額<strong>不含</strong>在計價金額裡，不是 0 元。" : ""))
    + chartOf(eq, " 天", "機具廠商排名")
    + vrankTableHTML(`機具廠商排名（${period}・依淨出工天數）`, VRANK_EQUIP_COLS, eq.map(vrankEquipRow),
      "機具不與點工併榜——出工天數與工數是不同單位，相加沒有意義。淨出工天數＝出工天數－代辦扣抵。")
    + vrankTableHTML(`代辦扣抵彙總（${period}・依責任歸屬廠商）`, VRANK_DED_COLS, ded.map(vrankDedRow),
      "代辦＝向本單廠商叫的工／機具但成本歸屬另一家，計價時從該廠商扣回。"
      + "金額依<strong>本單廠商</strong>的當季費率自動計算（合約 §4.10）。");
}

function exportVendorRankXls(){
  const lab = buildVendorRanking("labor");
  const eq = buildVendorRanking("equipment");
  const ded = buildAgentDeductionSummary();
  if(!lab.length && !eq.length && !ded.length){ toast("此期間內尚無已回報資料可排名"); return; }
  const period = reportPeriodLabel();
  downloadCSVBlocks([
    { title: `點工廠商排名（${period}・依淨工數＝總工數－代辦扣工）`, headers: VRANK_LABOR_COLS, rows: lab.map(vrankLaborRow) },
    { title: `機具廠商排名（${period}・依出工天數）`, headers: VRANK_EQUIP_COLS, rows: eq.map(vrankEquipRow) },
    { title: `代辦扣抵彙總（${period}・依責任歸屬廠商）`, headers: VRANK_DED_COLS, rows: ded.map(vrankDedRow) }
  ], `廠商排名_${MASTER.currentSite}${exportFilterTag()}.csv`);
}

/* ==========================================================
   叫工排名（v19；v19.2 分段呈現）：統計各簽單責任工程師「叫了什麼
   工種、多少本工與加班」並依工種排名。
   欄位（2026-07-31 三次裁示，主管需看加班時數）：
     本工＝Σ工種出工數 work（可含 0.5）
     加班前2h＝Σ ot2（小時）、加班2h後＝Σ otOver（小時）
     總工數＝本工 ＋ (加班前2h ＋ 加班2h後) ÷ 8（工數以 8 小時換算）
   排名依總工數降冪。僅計已回報單；期間/廠商篩選連動。
   無逐工種明細的單（v11 前舊制）：以該單申請的「工作內容類別」
   為列名，本工取 actual、加班取 totalOT 歸入「前2h」段（合約歸段規則）。
   ========================================================== */
const fmtRank = n => String(+n.toFixed(4));   // 最多 4 位小數、去尾零
const OT_PER_UNIT = 8;                        // 加班換算工數：8 小時＝1 工
const totalUnits = e => e.work + (e.ot2 + e.otOver) / OT_PER_UNIT;

/* 排名報表欄位定義：畫面與 .xls 匯出共用同一份，改欄位只需改這裡。
   num=數值欄（右對齊、等寬字）；xls=1 者只出現在匯出檔（畫面用總工數即可，不佔寬）。
   欄寬屬版面，統一寫在 style.css 的 .rank-table col:nth-child()。 */
const RANK_COLS = [
  { t: "工種" }, { t: "排名", num: 1 }, { t: "簽單責任工程師" },
  { t: "本工", num: 1 }, { t: "加班前2h", num: 1 }, { t: "加班2h後", num: 1 },
  { t: "加班合計(時)", num: 1, xls: 1 }, { t: "總工數", num: 1 },
  { t: "代辦扣工", num: 1 }, { t: "淨工數", num: 1 }
];
const RANK_COLS_VIEW = RANK_COLS.filter(c => !c.xls);

function buildRankingData(){
  const recs = cur().labor.filter(r =>
    inReportRange(r.date) && matchReportVendor(r) && r.status === "已回報" && r.report);
  const agg = Object.create(null);   // 工種 -> { 工程師 -> {work, ot2, otOver} }
  let recCount = 0;
  recs.forEach(r => {
    const eng = (r.report && r.report.engineer) || "（未填工程師）";
    let counted = false;
    // 逐工種列與加班歸段一律走 reportTypeRows（口徑唯一權威，v21.3）
    reportTypeRows(r).forEach(t => {
      if(!(t.work > 0 || t.ot2 > 0 || t.otOver > 0)) return;
      counted = true;
      const g = agg[t.type] || (agg[t.type] = Object.create(null));
      const e = g[eng] || (g[eng] = { work: 0, ot2: 0, otOver: 0, agWork: 0, agOt: 0 });
      e.work += t.work; e.ot2 += t.ot2; e.otOver += t.otOver;
    });
    /* v24：代辦扣工歸到「簽單責任工程師 × 該代辦列的工種」。
       這樣自辦比例偏高時，看得出是哪幾位工程師沒把代辦扣出去——
       只給一個總扣工數，查不到責任落點。
       代辦的工種一定在本單 workTypes 內（送出前由 collectAgentErrors 擋），
       故不會憑空生出新工種。 */
    ((r.report && r.report.agentItems) || []).forEach(a=>{
      if(!a || !a.type) return;
      const g = agg[a.type] || (agg[a.type] = Object.create(null));
      const e = g[eng] || (g[eng] = { work: 0, ot2: 0, otOver: 0, agWork: 0, agOt: 0 });
      e.agWork += Number(a.work) || 0;
      e.agOt   += (Number(a.ot2) || 0) + (Number(a.otOver) || 0);
      counted = true;
    });
    if(counted) recCount++;
  });
  const rows = Object.keys(agg).map(type => {
    const ranked = Object.entries(agg[type])
      .map(([name, e]) => {
        const units = totalUnits(e);
        const agUnits = (e.agWork || 0) + (e.agOt || 0) / OT_PER_UNIT;
        return { name, work: e.work, ot2: e.ot2, otOver: e.otOver,
                 agWork: e.agWork || 0, agOt: e.agOt || 0,
                 units, agUnits, netUnits: units - agUnits };
      })
      .sort((a, b) => b.netUnits - a.netUnits);
    const sum = ranked.reduce((a, e) => ({
      work: a.work + e.work, ot2: a.ot2 + e.ot2, otOver: a.otOver + e.otOver,
      agWork: a.agWork + e.agWork, agOt: a.agOt + e.agOt
    }), { work: 0, ot2: 0, otOver: 0, agWork: 0, agOt: 0 });
    const units = totalUnits(sum);
    const agUnits = sum.agWork + sum.agOt / OT_PER_UNIT;
    return { type, ranked, sum, units, agUnits, netUnits: units - agUnits };
  });
  rows.sort((a, b) => b.netUnits - a.netUnits);   // 量大的工種列在前
  return { rows, recCount };
}

/* 期別標示：期間落在同一個月 → 民國「YYY.M」；否則顯示起訖 */
function rankingPeriodLabel(){
  if(reportFrom && reportTo){
    const f = new Date(reportFrom + "T00:00:00"), t = new Date(reportTo + "T00:00:00");
    if(f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth()){
      return `${f.getFullYear() - 1911}.${f.getMonth() + 1}`;
    }
  }
  return (reportFrom || reportTo) ? `${reportFrom || "起"}~${reportTo || "今"}` : "全部期間";
}

function renderRankingReport(){
  populateReportFilters("labor");   // 廠商下拉沿用點工池
  const { rows, recCount } = buildRankingData();
  const cnt = document.getElementById("reportCount");
  const filterTags = [
    (reportFrom || reportTo) ? (reportFrom || "起") + " ~ " + (reportTo || "今") : "",
    reportVendor
  ].filter(Boolean).join("・");
  const engSet = new Set();
  rows.forEach(r => r.ranked.forEach(e => engSet.add(e.name)));
  if(cnt) cnt.textContent = "已回報 " + recCount + " 筆・" + rows.length + " 個工種・" + engSet.size + " 位工程師"
    + (filterTags ? "（" + filterTags + "）" : "");

  const el = document.getElementById("reportTable");
  const sumEl = document.getElementById("reportSummary");
  if(!el) return;
  if(sumEl) sumEl.innerHTML = "";
  if(!rows.length){
    el.innerHTML = '<div class="empty-row">此條件內尚無已回報的點工資料可排名</div>';
    return;
  }
  /* v23.1：先給一張「各工程師總工數」的長條圖。
     原本的表是逐工種分組（每個工種一區、各自排名），要回答「整體誰叫工最多」
     得自己心算跨工種加總——那正是總經理要看的數字，所以先畫出來。
     逐工種的細節仍由下方原表負責。 */
  const engTotals = new Map();
  rows.forEach(r => r.ranked.forEach(e => {
    const t = engTotals.get(e.name) || { work:0, ot2:0, otOver:0, agWork:0, agOt:0 };
    t.work += e.work; t.ot2 += e.ot2; t.otOver += e.otOver;
    t.agWork += e.agWork || 0; t.agOt += e.agOt || 0;
    engTotals.set(e.name, t);
  }));
  const engRows = [...engTotals.entries()]
    .map(([name, t]) => ({ label: name,
      value: totalUnits(t) - (t.agWork + t.agOt / OT_PER_UNIT) }))
    .sort((a, b) => b.value - a.value);
  const chartHTML = hBarChart(engRows, { unit: " 工", title: "各工程師叫工總量" });

  // 分頁以「工種」為單位（非以列），小計列才不會與所屬資料列被拆到不同頁；
  // 匯出仍取 buildRankingData() 全量，不受分頁影響（計價紅線 3）
  const { shown, pagerHTML } = paginate("ranking", rows, "個工種");
  const body = shown.map(r => {
    const span = r.ranked.length + 1;   // 資料列＋小計列共用同一個工種格
    const lines = r.ranked.map((e, i) => "<tr>"
      + (i === 0 ? '<td class="rank-type" rowspan="' + span + '"><strong>' + esc(r.type) + "</strong></td>" : "")
      + '<td class="num">' + (i + 1) + "</td>"
      + "<td>" + esc(e.name) + "</td>"
      + '<td class="num">' + fmtRank(e.work) + "</td>"
      + '<td class="num">' + (e.ot2 ? fmtRank(e.ot2) : "") + "</td>"
      + '<td class="num">' + (e.otOver ? fmtRank(e.otOver) : "") + "</td>"
      + '<td class="num">' + fmtRank(e.units) + "</td>"
      + '<td class="num">' + (e.agUnits ? "-" + fmtRank(e.agUnits) : "") + "</td>"
      + '<td class="num"><strong>' + fmtRank(e.netUnits) + "</strong></td></tr>").join("");
    return lines + '<tr class="rank-subtotal">'
      + '<td colspan="2" class="subtotal-label"><strong>小計（' + r.ranked.length + " 人）</strong></td>"
      + '<td class="num"><strong>' + fmtRank(r.sum.work) + "</strong></td>"
      + '<td class="num"><strong>' + (r.sum.ot2 ? fmtRank(r.sum.ot2) : "") + "</strong></td>"
      + '<td class="num"><strong>' + (r.sum.otOver ? fmtRank(r.sum.otOver) : "") + "</strong></td>"
      + '<td class="num"><strong>' + fmtRank(r.units) + "</strong></td>"
      + '<td class="num"><strong>' + (r.agUnits ? "-" + fmtRank(r.agUnits) : "") + "</strong></td>"
      + '<td class="num"><strong>' + fmtRank(r.netUnits) + "</strong></td></tr>";
  }).join("");
  el.innerHTML = chartHTML
    + '<div class="summary-title">逐工種明細</div>'
    + '<table class="rank-table">'
    + "<colgroup>" + RANK_COLS_VIEW.map(() => "<col>").join("") + "</colgroup>"
    + "<thead><tr>" + RANK_COLS_VIEW.map(c => "<th" + (c.num ? ' class="num"' : "") + ">" + esc(c.t) + "</th>").join("") + "</tr></thead>"
    + "<tbody>" + body + "</tbody></table>" + pagerHTML
    + '<p class="hint rank-hint">本工＝回報的工種出工數（可含 0.5 工）；加班為時數。'
    + "<strong>總工數＝本工＋(加班前2h＋加班2h後)÷8</strong>（工數以 8 小時換算）。"
    + "<strong>淨工數＝總工數－代辦扣工</strong>，排名依淨工數；代辦扣工按該列工種歸到簽單責任工程師，"
    + "自辦比例偏高時可據此查出未做代扣的落點。僅計已回報單。</p>";
  bindPager(el, "ranking", renderRankingReport);
}

/* ==========================================================
   最小 xlsx 產生器（v19.5）：零依賴，直接組 OOXML 檔案包

   為什麼不繼續用「HTML 表格存成 .xls」：Excel 2007 起會比對副檔名與實際
   格式，開檔前跳出「檔案格式與副檔名不相符…可能已損毀或不安全」的警告，
   工地同仁每次匯出都要按一次「是」。改產生真正的 xlsx（ZIP 內含 XML）
   即無此警告，且數值是真數值（不必再靠 mso-number-format 硬套格式）。

   ZIP 一律用 STORED（不壓縮）：報表檔僅數十 KB，省下實作 deflate 的風險。
   ========================================================== */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < u8.length; i++) c = CRC32_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/* entries: [{name, data:字串}] → Blob（ZIP，STORED 不壓縮） */
function zipStore(entries, mime){
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  const local = [], central = [];
  let offset = 0;
  entries.forEach(e => {
    const name = enc.encode(e.name), data = enc.encode(e.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);          // 檔名為 UTF-8
    lh.setUint16(8, 0, true);               // 0 = stored
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    local.push(new Uint8Array(lh.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  });
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, entries.length, true); eo.setUint16(10, entries.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  return new Blob(local.concat(central, [new Uint8Array(eo.buffer)]), { type: mime });
}

/* 樣式索引：對應 styles.xml 的 cellXfs 順序，儲存格以 s="N" 引用
   OHEAD/PTEXT/PNUM（v21.1）＝工種計價表版式：橘底表頭、粉底資料列（對照成本部既有計價表） */
/* TEXTW／PTEXTW：TEXT／PTEXT 的換行版。v22.5 起說明欄位可含多行（自動列點），
   Excel 若無 wrapText 會把整段擠成一行、換行只顯示成一個小方塊。 */
const XS = { PLAIN: 0, TITLE: 1, HEAD: 2, GROUP: 3, TEXT: 4, NUM: 5, NUMB: 6, SUBT: 7, SUBN: 8,
             OHEAD: 9, PTEXT: 10, PNUM: 11, TEXTW: 12, PTEXTW: 13 };
const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.####"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Microsoft JhengHei"/></font>'
  + '<font><b/><sz val="11"/><name val="Microsoft JhengHei"/></font></fonts>'
  + '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFCCC0DA"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF2ABC9"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE9D9"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF79646"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF6CEF5"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right>'
  + '<top style="thin"><color rgb="FF808080"/></top><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="14">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>'
  + '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>'
  + '<xf numFmtId="164" fontId="1" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>'
  + '<xf numFmtId="164" fontId="0" fillId="6" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>'
  /* 12 TEXTW／13 PTEXTW：含換行的說明欄位專用（＝ 4 TEXT／10 PTEXT 加 wrapText） */
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/* 0→A、25→Z、26→AA（完整明細工作表可超過 26 欄） */
const colRef = i => { let s = ""; i++; while(i){ i--; s = String.fromCharCode(65 + i % 26) + s; i = Math.floor(i / 26); } return s; };
/* XML 1.0 非法控制字元（含 Word 貼上常見的 U+000B）——不濾掉整份檔會打不開 */
const xmlSafe = v => String(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
/* 純數字判定：排除前導零（0800、統編等視為文字，轉數值會失去前導零） */
const isNumCell = s => /^-?(0|[1-9]\d*)(\.\d+)?$/.test(s);
/* 合併範圍內的「被蓋住」格仍要輸出空白格，否則該範圍沒有框線 */
const xlText = (c, r, s, v) => v === "" || v == null
  ? '<c r="' + colRef(c) + r + '" s="' + s + '"/>'
  : '<c r="' + colRef(c) + r + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(xmlSafe(v)) + "</t></is></c>";
/* 數值格；非數值（字串、NaN、Infinity）一律退回文字格——寫進 <v> 會讓
   Excel 判整份檔案損毀，且錯誤訊息不指出是哪一格 */
const xlNum = (c, r, s, v) => {
  if(v === "" || v == null) return '<c r="' + colRef(c) + r + '" s="' + s + '"/>';
  return isNumCell(String(v))
    ? '<c r="' + colRef(c) + r + '" s="' + s + '"><v>' + v + "</v></c>"
    : xlText(c, r, s, v);
};

/* 組出 xlsx Blob；sheets = [{name, widths, rows(每列 <row> 字串), merges}]，可多工作表 */
function buildXlsx(sheets){
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  const sheetXml = sh => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + "<cols>" + sh.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols>"
    + "<sheetData>" + sh.rows.join("") + "</sheetData>"
    + ((sh.merges || []).length ? '<mergeCells count="' + sh.merges.length + '">' + sh.merges.map(m => '<mergeCell ref="' + m + '"/>').join("") + "</mergeCells>" : "")
    + "</worksheet>";
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("")
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="' + REL + 'officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + "<sheets>" + sheets.map((sh, i) => '<sheet name="' + esc(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>" },
    { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + REL + 'worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("")
      + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="' + REL + 'styles" Target="styles.xml"/></Relationships>' },
    { name: "xl/styles.xml", data: XLSX_STYLES }
  ].concat(sheets.map((sh, i) => ({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(sh) })));
  return zipStore(entries, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

/* 下載 xlsx 共用收尾（檔名消毒與 revoke 時序見 downloadBlob） */
function downloadXlsx(sheets, filename, msg){
  downloadBlob(buildXlsx(sheets), filename, msg || "Excel 已匯出");
}

function exportRankingXls(){
  const { rows } = buildRankingData();
  if(!rows.length){ toast("此條件內尚無已回報的點工資料可排名"); return; }
  const N = RANK_COLS.length;          // 8 欄：工種/排名/工程師/本工/前2h/2h後/加班合計/總工數
  const xml = [], merges = [];

  // 第 1 列：期別標題（整列合併）
  xml.push('<row r="1">' + xlText(0, 1, XS.TITLE, "期別/月份：" + rankingPeriodLabel() + "　（總工數＝本工＋加班時數÷8；淨工數＝總工數－代辦扣工；排名依淨工數）")
    + Array.from({ length: N - 1 }, (_, i) => xlText(i + 1, 1, XS.TITLE, "")).join("") + "</row>");
  merges.push("A1:" + colRef(N - 1) + "1");
  // 第 2 列：表頭（沿用 RANK_COLS 單一來源）
  xml.push('<row r="2">' + RANK_COLS.map((c, i) => xlText(i, 2, XS.HEAD, c.t)).join("") + "</row>");

  let rn = 3;
  rows.forEach(r => {
    const start = rn;
    r.ranked.forEach((e, i) => {
      const ot = e.ot2 + e.otOver;
      xml.push('<row r="' + rn + '">'
        + xlText(0, rn, XS.GROUP, i === 0 ? r.type : "")
        + xlNum(1, rn, XS.NUM, i + 1)
        + xlText(2, rn, XS.TEXT, e.name)
        + xlNum(3, rn, XS.NUM, fmtRank(e.work))
        + xlNum(4, rn, XS.NUM, e.ot2 ? fmtRank(e.ot2) : "")
        + xlNum(5, rn, XS.NUM, e.otOver ? fmtRank(e.otOver) : "")
        + xlNum(6, rn, XS.NUM, ot ? fmtRank(ot) : "")
        + xlNum(7, rn, XS.NUM, fmtRank(e.units))
        + xlNum(8, rn, XS.NUM, e.agUnits ? fmtRank(-e.agUnits) : "")
        + xlNum(9, rn, XS.NUMB, fmtRank(e.netUnits)) + "</row>");
      rn++;
    });
    const sot = r.sum.ot2 + r.sum.otOver;
    xml.push('<row r="' + rn + '">'
      + xlText(0, rn, XS.GROUP, "")
      + xlText(1, rn, XS.SUBT, "小計（" + r.ranked.length + " 人）")
      + xlText(2, rn, XS.SUBT, "")
      + xlNum(3, rn, XS.SUBN, fmtRank(r.sum.work))
      + xlNum(4, rn, XS.SUBN, r.sum.ot2 ? fmtRank(r.sum.ot2) : "")
      + xlNum(5, rn, XS.SUBN, r.sum.otOver ? fmtRank(r.sum.otOver) : "")
      + xlNum(6, rn, XS.SUBN, sot ? fmtRank(sot) : "")
      + xlNum(7, rn, XS.SUBN, fmtRank(r.units))
      + xlNum(8, rn, XS.SUBN, r.agUnits ? fmtRank(-r.agUnits) : "")
      + xlNum(9, rn, XS.SUBN, fmtRank(r.netUnits)) + "</row>");
    merges.push("A" + start + ":A" + rn);     // 工種格跨資料列＋小計列
    merges.push("B" + rn + ":C" + rn);        // 小計標籤跨排名＋工程師欄
    rn++;
  });

  downloadXlsx([{ name: "叫工排名", widths: [18, 7, 20, 10, 12, 12, 14, 12], rows: xml, merges }],
    MASTER.currentSite + "_工程師叫工排名" + exportFilterTag() + "_" + localDate() + ".xlsx", "排名 Excel 已匯出");
}

/* ==========================================================
   點工匯出改帶格式 xlsx（v21.1，使用者要求對照成本部既有計價表版式）
   工作表 1「工種計價表」：施工廠商｜日期（民國）｜逐工種三欄
     （出工數／加班前2HR／加班2HR後）——橘底表頭、粉底資料列
   工作表 2「完整明細」：原明細全部欄位＋工種分欄，查核備查用
   計價彙總同版式（逐廠商合計）。CSV 匯出僅機具沿用。
   ========================================================== */
const rocDate = d => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || "");
  return m ? (m[1] - 1911) + "/" + (+m[2]) + "/" + (+m[3]) : (d || "");
};
/* 工種計價表的表頭沿用成本部範本字樣（加班欄不帶工種前綴——欄位歸屬由
   左側「XX出工數」界定）；彙總表為避免 N 組同名表頭誤導樞紐/查表，一律
   走 typeSplitHeaders 的全前綴版 */
const pricingTypeHeaders = labels =>
  labels.flatMap(lb=>[lb + "出工數", "加班前2HR(時數)", "加班2HR後(時數)"]);

/* 儲存格自動判型：純數字輸出為真數值，但「0 開頭的多位數」（0800、統編、
   電話）視為文字保留——轉數值會失去前導零，備查欄位失真 */
function dataRowsXml(rows, numStyle, textStyle, startRow, wrapStyle){
  return rows.map((row, ri)=>{
    const rn = ri + startRow;
    return '<row r="' + rn + '">' + row.map((v, c)=>{
      const s = String(v == null ? "" : v);
      if(isNumCell(s)) return xlNum(c, rn, numStyle, s);
      // v22.5：含換行者改用 wrapText 樣式，否則 Excel 會把列點擠成一行
      return xlText(c, rn, (wrapStyle && s.includes("\n")) ? wrapStyle : textStyle, s);
    }).join("") + "</row>";
  });
}
/* 查無時的空袋子：必須是 null 原型——用 {} 會讓名為 constructor/toString 的
   工種或廠商命中 Object.prototype 上的函式，typeSplitCells 誤判為有資料 */
const EMPTY_BAG = Object.create(null);
const autoWidths = headers => headers.map(h=>Math.min(28, Math.max(9, h.length * 2 + 3)));

/* recs 與 split 由 exportLaborXlsx 一次計算傳入：兩個工作表的工種欄集與
   列對應必須出自同一份快照，不可各自重抓（審查曾指出隱性對齊假設） */
function laborPricingSheet(recs, split){
  const { labels, per } = split;
  // 只列有工種數據的已回報單（0 工單與待回報單無計價內容），依廠商、日期排序
  const rows = recs
    .filter(r=>{ const m = per.get(r.id); return m && Object.keys(m).length; })
    .sort((a, b)=>(a.vendor || "").localeCompare(b.vendor || "", "zh-Hant") || (a.date || "").localeCompare(b.date || ""));
  const xml = [];
  const TAIL = 2 + labels.length * 3;   // 工種欄之後的尾欄起點（v21.2：補實際工作內容與工程師）
  xml.push('<row r="1">' + xlText(0, 1, XS.OHEAD, "施工廠商") + xlText(1, 1, XS.OHEAD, "日期")
    + pricingTypeHeaders(labels).map((h, i)=>xlText(2 + i, 1, XS.OHEAD, h)).join("")
    + xlText(TAIL, 1, XS.OHEAD, "實際工作內容(現場查核回饋)")
    + xlText(TAIL + 1, 1, XS.OHEAD, "簽單責任工程師") + "</row>");
  let rn = 2;
  rows.forEach(r=>{
    const m = per.get(r.id);
    const rep = r.report || {};
    let cells = xlText(0, rn, XS.PTEXT, r.vendor || "") + xlText(1, rn, XS.PTEXT, rocDate(r.date));
    labels.forEach((lb, i)=>{
      const e = m[lb];
      // 有此工種列數字（含 0）；沒有留空白——0 與空白計價意義不同
      cells += xlNum(2 + i * 3, rn, XS.PNUM, e ? fmtRank(e.work) : "")
             + xlNum(3 + i * 3, rn, XS.PNUM, e ? fmtRank(e.ot2) : "")
             + xlNum(4 + i * 3, rn, XS.PNUM, e ? fmtRank(e.otOver) : "");
    });
    // 查核回饋是列點的主要落點——含換行時要用 wrapText 樣式（v22.5）
    cells += xlText(TAIL, rn, (rep.conclusion || "").includes("\n") ? XS.PTEXTW : XS.PTEXT, rep.conclusion || "")
           + xlText(TAIL + 1, rn, XS.PTEXT, rep.engineer || "");
    xml.push('<row r="' + rn + '">' + cells + "</row>");
    rn++;
  });
  return { name: "工種計價表",
           widths: [13, 11].concat(labels.flatMap(()=>[13, 15, 15]), [34, 15]),
           rows: xml };
}

function laborDetailSheet(recs, split){
  const def = REPORT_DEFS.labor;
  const { labels, per } = split;
  const headers = def.headers.concat(typeSplitHeaders(labels));
  const dataRows = def.rows(recs).map((row, i)=>row.concat(typeSplitCells(per.get(recs[i].id) || EMPTY_BAG, labels)));
  const xml = ['<row r="1">' + headers.map((h, c)=>xlText(c, 1, XS.HEAD, h)).join("") + "</row>"]
    .concat(dataRowsXml(dataRows, XS.NUM, XS.TEXT, 2, XS.TEXTW));
  return { name: "完整明細", widths: autoWidths(headers), rows: xml };
}

function exportLaborXlsx(){
  const recs = REPORT_DEFS.labor.records();
  if(!recs.length){ toast("目前沒有可匯出的資料"); return; }
  const split = laborTypeSplit(recs);
  downloadXlsx([laborPricingSheet(recs, split), laborDetailSheet(recs, split)],
    MASTER.currentSite + "_點工紀錄" + exportFilterTag() + "_" + localDate() + ".xlsx");
}

function exportLaborSummaryXlsx(){
  const sum = pricingSummaryTable("labor");
  if(!sum.rows.length){ toast("此條件內尚無已回報資料可彙總"); return; }
  const recs = REPORT_DEFS.labor.records();
  const { labels, per } = laborTypeSplit(recs);
  const byVendor = typeSplitByVendor(recs, per);
  // 彙總表用全前綴表頭：N 個工種產生 N 組同名「加班前2HR」會讓樞紐/查表抓錯費率
  const headers = sum.headers.concat(typeSplitHeaders(labels));
  const dataRows = sum.rows.map(row=>row.concat(typeSplitCells(byVendor[row[1]] || EMPTY_BAG, labels)));   // row[1]＝廠商欄
  const xml = ['<row r="1">' + headers.map((h, c)=>xlText(c, 1, XS.OHEAD, h)).join("") + "</row>"]
    .concat(dataRowsXml(dataRows, XS.PNUM, XS.PTEXT, 2, XS.PTEXTW));
  downloadXlsx([{ name: "計價彙總", widths: autoWidths(headers), rows: xml }],
    MASTER.currentSite + "_點工計價彙總" + exportFilterTag() + "_" + localDate() + ".xlsx");
}

/* ==========================================================
   附件（v14）：點工/機具申請單夾簽單掃描檔、稽核紀錄夾現場照片
   - 檔案本體獨立存放（op:uploadAttachment / GET ?attachment=）；
     單據 JSON 只存描述資料 attachments[]，開站全量載入不受影響
   - 圖片前端壓縮（長邊 1600px、JPEG 0.8）：手機照片 3-5MB → 數百 KB
   - 「送出時才上傳、成功後才刪除」：表單取消不會留下孤兒檔案，
     也不會誤刪仍被引用的檔案
   ========================================================== */
const ATT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const ATT_LIMIT = 5;                     // 每個掛載點最多件數
const ATT_PDF_MAX = 4 * 1024 * 1024;     // PDF 原檔上限（圖片壓縮後遠小於此）
const attLocalUrl = {};                  // id -> objectURL：剛上傳的本地預覽（免重新下載）

function attUrl(id){
  return API_BASE + "?" + new URLSearchParams({ site: MASTER.currentSite, attachment: id }).toString();
}
function attSrc(id){ return attLocalUrl[id] || attUrl(id); }

/* 圖片壓縮：canvas 縮至長邊 1600px、JPEG 品質 0.8（簽單/現場照清晰度足夠） */
function compressImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cv.toBlob(b => b ? resolve(b) : reject(new Error("compress failed")), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
    img.src = url;
  });
}

function blobToBase64(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/* 每個掛載點一份狀態：existing=已存在單據上的、pendingFiles=已選未上傳、
   pendingDelete=標記待刪（送出成功後才真正刪除） */
function newAttState(){ return { existing: [], pendingFiles: [], pendingDelete: [] }; }
let laborAtt = newAttState(), equipAtt = newAttState(), auditAtt = newAttState();
function attCount(st){ return st.existing.length + st.pendingFiles.length; }

async function attPick(st, fileList, boxId){
  for(const file of Array.from(fileList || [])){
    if(attCount(st) >= ATT_LIMIT){ toast(`附件最多 ${ATT_LIMIT} 件`); break; }
    let blob = file, type = file.type, name = String(file.name || "附件").slice(0, 200);
    if(type && type.startsWith("image/")){
      try{
        blob = await compressImage(file);
        type = "image/jpeg";
        name = name.replace(/\.[^.]+$/, "") + ".jpg";
      }catch(e){ toast(`「${name}」不是可讀取的圖片`); continue; }
    }else if(type === "application/pdf"){
      if(file.size > ATT_PDF_MAX){ toast(`「${name}」超過 PDF 4MB 上限`); continue; }
    }else{
      toast(`「${name}」格式不支援（僅圖片與 PDF）`); continue;
    }
    st.pendingFiles.push({ blob, type, name, url: URL.createObjectURL(blob) });
  }
  renderAttBox(st, boxId);
}

function attThumbHTML(src, type, name){
  return type === "application/pdf"
    ? `<span class="att-pdf" title="${esc(name)}">PDF</span>`
    : `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy">`;
}

function renderAttBox(st, boxId, readOnly){
  const box = document.getElementById(boxId);
  if(!box) return;
  const cells = [];
  st.existing.forEach((m, i) => {
    cells.push(`<div class="att-cell">
      <a href="${esc(attSrc(m.id))}" target="_blank" rel="noopener">${attThumbHTML(attSrc(m.id), m.type, m.name)}</a>
      ${readOnly ? "" : `<button type="button" class="att-del" data-att-act="del-existing" data-i="${i}" title="移除">×</button>`}
    </div>`);
  });
  st.pendingFiles.forEach((p, i) => {
    cells.push(`<div class="att-cell pending">
      ${attThumbHTML(p.url, p.type, p.name)}
      <button type="button" class="att-del" data-att-act="del-pending" data-i="${i}" title="移除">×</button>
      <span class="att-new">新</span>
    </div>`);
  });
  if(!readOnly && attCount(st) < ATT_LIMIT){
    cells.push(`<button type="button" class="att-add" data-att-act="add">＋ 拍照／選檔</button>`);
  }
  if(readOnly && !cells.length){
    box.innerHTML = "";
    return;
  }
  box.innerHTML = cells.join("");
}

/* 掛載點事件（box 內委派＋隱藏 file input） */
function initAttBox(st, boxId, inputId){
  const box = document.getElementById(boxId);
  const input = document.getElementById(inputId);
  box.addEventListener("click", e => {
    const btn = e.target.closest("[data-att-act]");
    if(!btn) return;
    const act = btn.dataset.attAct;
    if(act === "add"){ input.click(); return; }
    const i = parseInt(btn.dataset.i, 10);
    if(act === "del-existing" && st.existing[i]){
      st.pendingDelete.push(st.existing[i].id);
      st.existing.splice(i, 1);
      renderAttBox(st, boxId);
    }
    if(act === "del-pending" && st.pendingFiles[i]){
      URL.revokeObjectURL(st.pendingFiles[i].url);
      st.pendingFiles.splice(i, 1);
      renderAttBox(st, boxId);
    }
  });
  input.addEventListener("change", async () => {
    await attPick(st, input.files, boxId);
    input.value = "";
  });
}

/* 送出流程：先上傳 pending（失敗即中止、可重試），回傳合併後的 attachments[]。
   逐件「上傳成功即移入 existing」：部分成功後重試不會重複上傳同一檔案 */
async function attUploadPending(st){
  while(st.pendingFiles.length){
    const p = st.pendingFiles[0];
    const id = uid();
    const data = await blobToBase64(p.blob);
    await api("POST", { op: "uploadAttachment", site: MASTER.currentSite, id, name: p.name, type: p.type, data });
    attLocalUrl[id] = p.url;   // 本地預覽所有權轉移（reset 時不得 revoke）
    p.url = null;
    st.pendingFiles.shift();
    st.existing.push({ id, name: p.name, type: p.type, size: p.blob.size, uploadedAt: localDate() });
  }
  return st.existing.slice();
}

/* 單據儲存成功後：真正刪除被移除的附件（失敗不擋流程，孤兒檔無害） */
function attFinalize(st){
  st.pendingDelete.forEach(id => {
    api("POST", { op: "deleteAttachment", site: MASTER.currentSite, id }).catch(() => {});
  });
}

function resetAttState(st, boxId){
  st.pendingFiles.forEach(p => { if(p.url) URL.revokeObjectURL(p.url); });
  st.existing = []; st.pendingFiles = []; st.pendingDelete = [];
  if(boxId) renderAttBox(st, boxId);
}

/* 回報頁的唯讀附件列（工程師回報時查看申請單夾帶的簽單掃描檔） */
function attReadOnlyHTML(atts){
  if(!atts || !atts.length) return "";
  return `<div class="att-strip readonly">` + atts.map(m =>
    `<a class="att-cell" href="${esc(attSrc(m.id))}" target="_blank" rel="noopener">${attThumbHTML(attSrc(m.id), m.type, m.name)}</a>`
  ).join("") + `</div>`;
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
  // 覆蓋值須為非空陣列才生效（空陣列 [] 為 truthy，誤設會讓查核項目全空且驗證迴圈跟著空轉）
  labor: (LOCAL.auditItems && Array.isArray(LOCAL.auditItems.labor) && LOCAL.auditItems.labor.length) ? LOCAL.auditItems.labor : [
    "現場點名人數與申請工數相符",
    "人臉辨識紀錄相符",
    "白卡進出紀錄相符",
    "施作工項與申請內容相符",
    "施作地點與申請相符",
    "無同廠商重複計價疑慮",
    "簽單與出工紀錄核對相符"
  ],
  equipment: (LOCAL.auditItems && Array.isArray(LOCAL.auditItems.equipment) && LOCAL.auditItems.equipment.length) ? LOCAL.auditItems.equipment : [
    "現場機具數量與申請台數相符",
    "機具類型與申請相符",
    "實際使用狀態正常（非閒置）",
    "使用地點與申請相符",
    "簽單與使用紀錄核對相符"
  ]
};

let auditKind = "labor";
let auditDate = null;   // null=尚未初始化（首次進稽核頁帶入當天，避免跨午夜的分頁拿到昨天）；""=使用者清空（看全部日期）
let auditVendor = "";
let auditSelectedId = null;
let auditItemState = [];
let editingAuditId = null;   // 非 null＝編輯既有稽核紀錄（更新取代，不新增）
let auditLogFrom = "", auditLogTo = "";
/* 稽核請求序號：pickAuditRecord/editAudit 等待 refetchSite 期間，任何讓畫面
   失效的動作（重新選取、切類型/日期/廠商/工地、登出、儲存/刪除收尾）都會
   透過 resetAuditView() 遞增此序號，使較慢的舊回應被捨棄（v13 修復） */
let auditFetchSeq = 0;

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
  auditFetchSeq++;   // 讓所有飛行中的稽核選取/編輯請求失效（單一失效點，涵蓋切篩選/切站/登出等全部路徑）
  auditSelectedId = null;
  auditItemState = [];
  editingAuditId = null;
  resetAttState(auditAtt);
  const wrap = document.getElementById("auditFormWrap");
  if(wrap) wrap.innerHTML = '<div class="empty-row">請先從上方選擇要稽核的申請單</div>';
}

function renderAuditView(){
  if(!READY || !isAdmin()) return;
  const siteSel = document.getElementById("auditSite");
  siteSel.innerHTML = MASTER.sites.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join("");
  siteSel.value = MASTER.currentSite;
  document.querySelectorAll("#auditKindSwitch .akind").forEach(b=>b.classList.toggle("active", b.dataset.akind===auditKind));
  if(auditDate === null) auditDate = localDate();   // 首次進稽核頁才帶入當天（延後計算，跨午夜分頁不會拿到昨天）
  document.getElementById("auditDate").value = auditDate;

  const store = cur();
  const list = auditKind==="labor" ? store.labor : store.equipment;
  const vendors = [...new Set(list.filter(r=>!auditDate || r.date===auditDate).map(recVendor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"zh-Hant"));
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
  const recs = list.filter(r=>(!auditDate || r.date===auditDate) && (!auditVendor || recVendor(r)===auditVendor));
  if(!recs.length){
    el.innerHTML = '<div class="empty-row">此條件內沒有' + (auditKind==="labor"?"點工":"機具") + '申請單，請調整日期／廠商</div>';
    resetAuditView();
    return;
  }
  el.innerHTML = recs.map(r=>{
    const audited = (r.audits||[]).length;
    return `<button type="button" class="audit-pick ${r.id===auditSelectedId?"active":""}" data-id="${esc(r.id)}">
      <span class="ap-line1">${esc(r.date)}｜${esc(recVendor(r)||"（未填廠商）")}｜${auditAppliedLabel()} ${fmt(auditApplied(auditKind, r))}</span>
      <span class="ap-line2">${esc(auditRecCats(auditKind, r)||"—")}｜${esc((r.locations||[]).join("、")||"—")}｜${esc(r.status)}${audited?`｜已稽核 ${audited} 次`:""}</span>
    </button>`;
  }).join("");
}

async function pickAuditRecord(id){
  const seq = ++auditFetchSeq;
  // 其他頁籤有表單編輯中時「不」整批刷新快取：refetchSite 會讓那些表單送出時
  // 抓到漂移後的 v 當 baseV、繞過 409 保護。略過刷新只是少了先抓最新的優化，
  // 稽核儲存本身仍受 baseV/409 保護，資料不會出錯。
  if(!otherFormEditing()){
    let refetchFailed = false;
    try{ await refetchSite(MASTER.currentSite); }catch(e){ refetchFailed = true; }
    if(seq !== auditFetchSeq) return;   // 等待期間選取/篩選/工地已變，捨棄這次較慢的回應
    if(refetchFailed) toast("⚠ 無法載入最新資料，請檢查網路後再試");
  }
  const rec = auditFindRec(auditKind, id);
  if(!rec){ toast("找不到該單據，可能已被刪除"); renderAuditView(); return; }
  auditSelectedId = id;
  editingAuditId = null;
  auditItemState = AUDIT_ITEMS[auditKind].map(t=>({text:t, ok:null, reason:""}));
  resetAttState(auditAtt);   // 新稽核：附件從空白開始
  renderAuditRecList();
  if(auditSelectedId !== id) return;   // 重繪過程觸發 resetAuditView（清單變空）時，不渲染已失效的表單
  renderAuditForm(rec);
}

/* 編輯既有稽核紀錄：載入原內容進表單，儲存時原地更新（保留原稽核日期，另記編輯日） */
async function editAudit(kind, rid, aid){
  const seq = ++auditFetchSeq;
  if(!otherFormEditing()){   // 同 pickAuditRecord：保護其他表單的 baseV/409 語意
    let refetchFailed = false;
    try{ await refetchSite(MASTER.currentSite); }catch(e){ refetchFailed = true; }
    if(seq !== auditFetchSeq) return;
    if(refetchFailed) toast("⚠ 無法載入最新資料，請檢查網路後再試");
  }
  const rec = auditFindRec(kind, rid);
  const a = rec && (rec.audits||[]).find(x=>x.id===aid);
  if(!a){ toast("找不到該筆稽核紀錄，可能已被刪除"); renderAuditView(); return; }
  auditKind = kind;
  auditDate = rec.date;
  auditVendor = "";
  auditSelectedId = rid;
  editingAuditId = aid;
  auditItemState = (a.items||[]).map(it=>({text:it.text, ok: typeof it.ok === "boolean" ? it.ok : null, reason:it.reason||""}));
  resetAttState(auditAtt);
  auditAtt.existing = (a.attachments || []).slice();   // 載入既有稽核附件供編輯
  renderAuditView();
  if(auditSelectedId !== rid) return;   // 重繪過程觸發 resetAuditView 時，不渲染已失效的表單
  renderAuditForm(rec, a);
  document.getElementById("auditFormWrap").scrollIntoView({behavior:"smooth", block:"start"});
}

function renderAuditForm(rec, editA){
  const wrap = document.getElementById("auditFormWrap");
  // 編輯模式沿用原稽核當下的申請數快照（基準不因申請單事後修改而漂移）
  const applied = editA ? (editA.applied||0) : auditApplied(auditKind, rec);
  wrap.innerHTML = `
    <div class="audit-ctx${editA?" editing":""}">
      <div class="ac-line1">${editA?`✎ 編輯稽核紀錄（原稽核日期：${esc(editA.auditedAt)}）｜`:""}${esc(rec.date)}｜${esc(recVendor(rec)||"（未填廠商）")}｜${esc(rec.status)}</div>
      <div class="ac-line2">${esc(auditRecCats(auditKind, rec)||"—")}｜${esc((rec.locations||[]).join("、")||"—")}｜申請人：${esc(rec.applicant||"—")}</div>
    </div>
    <div class="form-grid">
      <div class="field field-num">
        <label title="依申請單帶入">${auditAppliedLabel()}</label>
        <input type="text" readonly class="readonly-field" value="${fmt(applied)}">
      </div>
      <div class="field field-num">
        <label title="現場清點數">${auditCountLabel()}</label>
        <input type="number" id="auditCount" min="0" step="0.5" value="${editA?fmt(editA.actualCount):""}">
      </div>
      <div class="field field-num">
        <label title="現場實點與申請數的差異">差異</label>
        <input type="text" id="auditCountDiff" readonly class="readonly-field" value="${editA?fmt((editA.actualCount||0)-applied):""}">
      </div>
      <div class="field field-num">
        <label>稽核人</label>
        <input type="text" id="auditAuditor" placeholder="例：成控－某某某" value="${esc(editA?(editA.auditor||""):(ssGet("dm_auditor")||""))}">
      </div>
      <div class="field field-wide">
        <label>快速查核（每項必選「相符／不相符」；不相符需填寫原因）</label>
        <div id="auditItems"></div>
      </div>
      <div class="field field-wide">
        <label>現場狀況說明（選填，不限字數）</label>
        <textarea id="auditNote" rows="3" placeholder="例：現場清點與申請相符；其中 2 工無白卡紀錄，已提醒工地落實刷卡">${esc(editA?(editA.note||""):"")}</textarea>
      </div>
      <div class="field field-wide">
        <label>現場照片／附件（選填，最多 ${ATT_LIMIT} 件；圖片自動壓縮，會一併列入 PDF 報告）</label>
        <div id="auditAttachBox" class="att-strip"></div>
        <input type="file" id="auditAttachInput" accept="image/*,application/pdf" multiple hidden>
      </div>
      <div class="field field-wide actions">
        <button type="button" class="btn-primary" id="auditSaveBtn">${editA?"更新稽核紀錄":"儲存稽核紀錄"}</button>
        <button type="button" class="btn-ghost" id="auditCancelBtn">取消</button>
      </div>
    </div>`;
  renderAuditItems();
  renderAttBox(auditAtt, "auditAttachBox");
  document.getElementById("auditCount").addEventListener("input", ()=>{
    const v = parseFloat(document.getElementById("auditCount").value);
    document.getElementById("auditCountDiff").value = isNaN(v) ? "" : fmt(v - applied);
  });
  document.getElementById("auditSaveBtn").addEventListener("click", ()=>saveAudit(rec.id));
  document.getElementById("auditCancelBtn").addEventListener("click", ()=>{ resetAuditView(); renderAuditRecList(); });
  initAutoNumber(document.getElementById("auditNote"));   // v22.5：稽核表單為動態產生，於此掛上自動列點
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
      ${it.ok===false?`<textarea class="ai-reason" rows="2" data-i="${i}" placeholder="請填寫不符原因（必填），例：2 工無白卡進出紀錄（可用 1. 起頭列點）">${esc(it.reason)}</textarea>`:""}
    </div>`).join("");
  // v22.5：不符原因逐次重繪，掛監聽要放在渲染之後（initAutoNumber 自帶重複掛載保護）
  box.querySelectorAll(".ai-reason").forEach(initAutoNumber);
}

async function saveAudit(id){
  // 快照 kind/store：await 期間切換稽核類型或工地，不影響本次 API 參數與快取寫回位置（v13 修復）
  const kind = auditKind;
  const store = cur();
  const rec = auditFindRec(kind, id);
  if(!rec){ toast("找不到該單據，請重新選擇"); return; }
  const auditor = document.getElementById("auditAuditor").value.trim();
  if(!auditor){ toast("請填寫稽核人"); return; }
  const cntRaw = document.getElementById("auditCount").value.trim();
  if(cntRaw === ""){ toast("請填寫" + auditCountLabel()); return; }
  const actualCount = parseFloat(cntRaw) || 0;
  if(!isFinite(actualCount) || actualCount < 0){ toast(auditCountLabel() + "必須是 0 以上的有效數字"); return; }
  for(const it of auditItemState){
    if(it.ok === null){ toast(`「${it.text}」尚未選擇相符／不相符`); return; }
    if(it.ok === false && !it.reason.trim()){ toast(`「${it.text}」為不相符，請填寫不符原因`); return; }
  }
  const orig = editingAuditId ? (rec.audits||[]).find(x=>x.id===editingAuditId) : null;
  if(editingAuditId && !orig){ toast("原稽核紀錄不存在，可能已被刪除"); resetAuditView(); renderAuditView(); return; }
  // v14：先上傳現場照片/附件（失敗即中止、輸入保留可重試）
  let attachments;
  try{
    attachments = await attUploadPending(auditAtt);
  }catch(err){
    toast("⚠ 附件上傳失敗，稽核未送出，請檢查網路後再試");
    return;
  }
  // 編輯：保留原 id/稽核日期/申請數快照，另記編輯日；新增：全新快照
  const applied = orig ? (orig.applied||0) : auditApplied(kind, rec);
  const audit = {
    id: orig ? orig.id : uid(),
    auditedAt: orig ? orig.auditedAt : localDate(),
    auditor,
    applied,
    actualCount,
    diff: actualCount - applied,
    items: auditItemState.map(it=>({ text: it.text, ok: !!it.ok, reason: it.ok===false ? it.reason.trim() : "" })),
    attachments,
    note: document.getElementById("auditNote").value.trim(),
    statusAtAudit: orig ? orig.statusAtAudit : rec.status
  };
  if(orig) audit.editedAt = localDate();
  const updated = Object.assign({}, rec, {
    audits: orig ? rec.audits.map(x=>x.id===audit.id ? audit : x)
                 : (rec.audits||[]).concat([audit])
  });
  const seqAtSave = auditFetchSeq;   // 收尾守衛：await 期間使用者若已改選/重置，不清掉他新開的表單
  try{
    const resp = await apiSaveRecord(kind, updated, rec.v || 0);
    updated.v = resp.v; updated.updatedAt = resp.updatedAt;
  }catch(err){
    if(err.status === 409){
      toast("⚠ 此單剛被其他人修改，稽核未儲存；已重新載入最新內容，請重新填寫");
      await refetchSite(MASTER.currentSite).catch(()=>{});
      if(seqAtSave === auditFetchSeq){ resetAuditView(); renderAuditView(); }
      return;
    }
    toast("⚠ 雲端儲存失敗，稽核未送出，請檢查網路後再按一次儲存");
    return;
  }
  const list = kind==="labor" ? store.labor : store.equipment;
  const idx = list.findIndex(r=>r.id===id);
  if(idx >= 0) list[idx] = updated;
  ssSet("dm_auditor", auditor);
  attFinalize(auditAtt);   // 儲存成功後才真正刪除被移除的附件
  toast(orig ? "稽核紀錄已更新" : "稽核紀錄已儲存至共用資料庫");
  if(seqAtSave === auditFetchSeq){
    resetAuditView();
    renderAuditView();
  }else{
    renderAuditLog();        // 使用者已在操作別的稽核對象：只更新清單，不動他的表單
    renderAuditRecList();
  }
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
  const { shown, pagerHTML } = paginate("auditlog", entries);
  /* 操作欄只有三顆小按鈕（編輯／PDF／刪除），比清單頁窄——實測需 202px，取 210 */
  el.innerHTML = fixedTableOpen(
    ["稽核日期","類型","出工日期","廠商","申請","實點","差異","查核結果","稽核人","操作"],
    { actionW: 210 }) + `<tbody>` +
    shown.map(e=>{
      const bad = e.a.items.filter(i=>!i.ok).length;
      const resTag = bad ? `<span class="tag warn">${bad} 項不符</span>` : `<span class="tag ok">全數相符</span>`;
      const ids = `data-kind="${e.kind}" data-rid="${esc(e.rec.id)}" data-aid="${esc(e.a.id)}"`;
      return `<tr>
        <td>${esc(e.a.auditedAt)}${e.a.editedAt?`<span class="edited-mark" title="編輯於 ${esc(e.a.editedAt)}">（已編輯）</span>`:""}</td>
        <td>${e.kind==="labor"?"點工":"機具"}</td>
        <td>${esc(e.rec.date)}</td>
        <td>${esc(recVendor(e.rec))}</td>
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
    }).join("") + "</tbody></table>" + pagerHTML;
}

async function deleteAudit(kind, rid, aid){
  const store = cur();   // 快照：await 期間切換工地，寫回位置仍是這筆紀錄所屬的工地
  const rec = auditFindRec(kind, rid);
  if(!rec){ toast("找不到該單據，可能已被刪除；請重新整理後再試"); return; }
  const a = (rec.audits||[]).find(x=>x.id===aid);
  if(!a){ toast("找不到該筆稽核紀錄，可能已被刪除；請重新整理後再試"); return; }
  if(!confirm(`確定刪除這筆稽核紀錄嗎？（${a.auditedAt}／${recVendor(rec)}）\n此操作影響所有使用者且無法復原。`)) return;
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
  // API 成功後才關閉正在編輯的同一筆表單（失敗時保留使用者輸入，紀錄其實還在）
  if(editingAuditId === aid) resetAuditView();
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
      <h3>${n+1}. ${esc(e.rec.date)}｜${e.kind==="labor"?"點工":"機具"}｜${esc(recVendor(e.rec)||"（未填廠商）")} — ${bad?`<span class="r-bad">${bad} 項不符</span>`:`<span class="r-ok">全數相符</span>`}</h3>
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
      ${(() => {   // v14：現場照片嵌入報告；PDF 附件列出檔名
        const atts = e.a.attachments || [];
        const imgs = atts.filter(a => a.type && a.type.startsWith("image/"));
        const pdfs = atts.filter(a => a.type === "application/pdf");
        return (imgs.length ? `<div class="photos">${imgs.map(a=>`<img src="${esc(attSrc(a.id))}" alt="${esc(a.name)}">`).join("")}</div>` : "")
             + (pdfs.length ? `<p class="meta">附件（PDF）：${esc(pdfs.map(a=>a.name).join("、"))}</p>` : "");
      })()}
      <p class="meta">稽核日期：${esc(e.a.auditedAt)}｜稽核人員：${esc(e.a.auditor)}${e.a.editedAt?`｜編輯於：${esc(e.a.editedAt)}`:""}</p>
    </div>`;
  }).join("");

  const sumRows = entries.map((e,n)=>{
    const bad = e.a.items.filter(i=>!i.ok).length;
    return `<tr><td>${n+1}</td><td>${esc(e.a.auditedAt)}</td><td>${e.kind==="labor"?"點工":"機具"}</td><td>${esc(e.rec.date)}</td><td>${esc(recVendor(e.rec))}</td><td>${fmt(e.a.applied)}</td><td>${fmt(e.a.actualCount)}</td><td>${fmt(e.a.diff)}</td><td class="${bad?"r-bad":"r-ok"}">${bad?bad+" 項不符":"全數相符"}</td><td>${esc(e.a.auditor)}</td></tr>`;
  }).join("");

  const auditors = [...new Set(entries.map(e=>e.a.auditor).filter(Boolean))];

  return `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><title>成控現場稽核報告</title>
  <style>
    body{font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;color:#1C1C1C;margin:32px;font-size:13px;}
    h1{font-size:20px;margin:0 0 4px;} .sub{color:#76736C;margin:0 0 20px;}
    h2{font-size:15px;border-left:4px solid #2E3F5A;padding-left:8px;margin:24px 0 8px;}
    h3{font-size:14px;margin:20px 0 6px;}
    table{border-collapse:collapse;width:100%;margin:4px 0 8px;}
    th,td{border:1px solid #D0C9BE;padding:4px 8px;text-align:left;vertical-align:top;}
    thead th{background:#F5F1EC;}
    .info th{background:#F5F1EC;width:110px;white-space:nowrap;}
    .w1{width:64px;white-space:nowrap;}
    /* v22.5：不符原因可用 1. 2. 列點，PDF 也要照原樣斷行（.note 早已 pre-wrap） */
    .items td{white-space:pre-line;}
    .r-ok{color:#3A6B52;font-weight:bold;} .r-bad{color:#8B3A3A;font-weight:bold;}
    .note{margin:4px 0;white-space:pre-wrap;} .meta{color:#76736C;margin:2px 0 0;}
    .photos{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;}
    .photos img{max-width:46%;max-height:300px;border:1px solid #D0C9BE;object-fit:contain;}
    .sec{page-break-inside:avoid;}
    .signs{display:flex;gap:40px;flex-wrap:wrap;margin-top:36px;page-break-inside:avoid;font-size:13px;}
    .toolbar{margin:0 0 16px;}
    .toolbar button{font-size:14px;padding:6px 16px;cursor:pointer;}
    @media print{.toolbar{display:none;} body{margin:12mm;}}
  </style></head><body>
  <div class="toolbar"><button id="auditPrintBtn" type="button">🖨 列印 / 另存 PDF</button>（於列印對話框選「另存為 PDF」）</div>
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
  // 列印鈕改事件綁定（不再用內聯 onclick，配合 CSP script-src 'self'）：由父視窗掛在
  // 子視窗按鈕上，子文件因此完全不含內聯腳本；about:blank 繼承本頁 CSP 也不會擋到列印
  w.document.getElementById("auditPrintBtn")?.addEventListener("click", ()=>w.print());
}

function exportAuditCSV(){
  const entries = auditLogEntries();
  if(!entries.length){ toast("此條件內沒有稽核紀錄可匯出"); return; }
  const headers = ["稽核日期","編輯日期","類型","工地","出工日期","廠商","工作內容","工作地點","申請","現場實點","差異","不符項數","不符項目與原因","現場狀況說明","稽核人","稽核時單據狀態"];
  const rows = entries.map(e=>{
    const badItems = e.a.items.filter(i=>!i.ok);
    return [
      e.a.auditedAt, e.a.editedAt||"", e.kind==="labor"?"點工":"機具", MASTER.currentSite,
      e.rec.date, recVendor(e.rec), auditRecCats(e.kind, e.rec),
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
    // v14：附件列（動態表單 → 事件委派）
    const ab = e.target.closest("[data-att-act]");
    if(ab){
      const act = ab.dataset.attAct;
      if(act === "add"){ const inp = document.getElementById("auditAttachInput"); if(inp) inp.click(); return; }
      const ai = parseInt(ab.dataset.i, 10);
      if(act === "del-existing" && auditAtt.existing[ai]){
        auditAtt.pendingDelete.push(auditAtt.existing[ai].id);
        auditAtt.existing.splice(ai, 1);
        renderAttBox(auditAtt, "auditAttachBox");
      }
      if(act === "del-pending" && auditAtt.pendingFiles[ai]){
        if(auditAtt.pendingFiles[ai].url) URL.revokeObjectURL(auditAtt.pendingFiles[ai].url);
        auditAtt.pendingFiles.splice(ai, 1);
        renderAttBox(auditAtt, "auditAttachBox");
      }
      return;
    }
    const btn = e.target.closest(".ai-btn");
    if(!btn) return;
    const i = parseInt(btn.dataset.i, 10);
    if(!auditItemState[i]) return;
    auditItemState[i].ok = btn.dataset.val === "1";
    renderAuditItems();
  });
  document.getElementById("auditFormWrap").addEventListener("change", async e=>{
    if(e.target.id !== "auditAttachInput") return;
    await attPick(auditAtt, e.target.files, "auditAttachBox");
    e.target.value = "";
  });
  document.getElementById("auditFormWrap").addEventListener("input", e=>{
    if(!e.target.classList.contains("ai-reason")) return;
    const i = parseInt(e.target.dataset.i, 10);
    if(auditItemState[i]) auditItemState[i].reason = e.target.value;
  });
  document.getElementById("auditLogList").addEventListener("click", e=>{
    const pg = e.target.closest(".pager-prev, .pager-next");   // v15.2：稽核紀錄分頁（委派）
    if(pg){
      listPage.auditlog += pg.classList.contains("pager-next") ? 1 : -1;
      renderAuditLog();
      return;
    }
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
    listPage.auditlog = 1;   // v15.2：改篩選回第 1 頁
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

function isAdmin(){ return ssGet("dm_admin") === "1"; }

function initAdmin(){
  document.getElementById("adminToggleBtn").addEventListener("click", ()=>{
    if(isAdmin()){
      ssDel("dm_admin");
      toast("已登出管理員模式");
    }else{
      const pin = prompt("請輸入管理員密碼：");
      if(pin === null) return;
      if(String(pin) === ADMIN_PIN){
        ssSet("dm_admin", "1");
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
  document.getElementById("cfg_adminDepts").readOnly = !admin;   // v23.2
  // v23.3：納管會建立工地並寫入專案代碼，非管理員不開放
  const adopt = document.getElementById("adoptPanel");
  if(adopt) adopt.style.display = admin ? "" : "none";
  Object.keys(SITE_CFG_MAP).forEach(id=>{
    document.getElementById(id).readOnly = !admin;
  });
  document.getElementById("cfg_lockDate").disabled = !admin;
  document.getElementById("saveSettings").style.display = admin ? "" : "none";
  document.getElementById("resetSettings").style.display = admin ? "" : "none";
  document.getElementById("dangerZone").style.display = admin ? "" : "none";
  /* v22.8 行情通報：匯入會覆蓋全公司共用的費率、綁定直接影響計價金額，
     與資料管理同級，非管理員完全隱藏 */
  document.getElementById("ratesPanel").style.display = admin ? "" : "none";

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
  // v23.2：管理員部門白名單（未設定時留白，代表沿用系統預設）
  document.getElementById("cfg_adminDepts").value = (MASTER.adminDepartments || []).join("\n");
  document.getElementById("siteConfigTitle").childNodes[0].textContent = `目前工地基礎資料：${MASTER.currentSite}`;
  const c = cur().config;
  Object.entries(SITE_CFG_MAP).forEach(([id,key])=>{
    document.getElementById(id).value = (c[key]||[]).join("\n");
  });
  document.getElementById("cfg_lockDate").value = c.lockDate || "";
  applyAdminUI();
}

/* ==========================================================
   工地納管（v23.3，合約 §2.5／§3.11／§4.11）

   要解決的是「新工地要人工做三件事」，其中 project_code 漏填**不會報錯**，
   只會讓該站除了管理員以外沒人看得到——最難察覺的一種設定失誤。

   ⚠ 僅地端可用（需要 ERP 權限檢視表連線）。雲端會回空清單並附 reason，
     畫面照實說明「此環境無法列出」，不是顯示失敗。
   ========================================================== */
let candidateState = [];   // [{projectCode, projectName, engineers, leads}]

function renderCandidates(msg){
  const box = document.getElementById("candidateBox");
  if(!box) return;
  if(msg){ box.innerHTML = `<div class="empty-row">${esc(msg)}</div>`; return; }
  if(!candidateState.length){
    box.innerHTML = '<div class="empty-row">目前沒有可納管的專案——ERP 裡有工地角色人員的專案都已建立</div>';
    return;
  }
  box.innerHTML = candidateState.map((c,i)=>`
    <div class="att-row present">
      <span class="tr-name">${esc(c.projectCode)}<br><small>${esc(c.projectName||"（無專案名稱）")}</small></span>
      <div class="att-fields">
        <label class="ag-note">工地名稱<input type="text" class="cand-name" data-i="${i}"
          value="${esc(c.siteName != null ? c.siteName : (c.projectName||""))}" placeholder="顯示在選單上的名稱"></label>
        <span class="cand-cnt">工程師 ${c.engineers}${c.leads ? "・主任 " + c.leads : ""}</span>
      </div>
      <button type="button" class="btn-secondary btn-sm cand-adopt" data-i="${i}">納管</button>
    </div>`).join("");
}

async function loadCandidates(){
  if(!isAdmin()){ toast("僅限管理員操作"); return; }
  renderCandidates("比對中…");
  try{
    const r = await api("GET", null, { candidates: "1" });
    candidateState = (r.candidates || []).map(c=>Object.assign({}, c));
    renderCandidates(r.reason && !candidateState.length ? r.reason : null);
  }catch(err){
    renderCandidates("⚠ 無法取得候選清單" + (err && err.status ? `（HTTP ${err.status}）` : ""));
  }
}

async function adoptCandidate(i){
  const c = candidateState[i];
  if(!c) return;
  const el = document.querySelector(`.cand-name[data-i="${i}"]`);
  const siteName = (el ? el.value : "").trim();
  if(!siteName){ toast("請先填工地名稱"); return; }
  if(MASTER.sites.includes(siteName)
     && !confirm(`工地「${siteName}」已存在。\n\n繼續會把專案代碼 ${c.projectCode} 寫到這個既有工地，並把該專案的工程師併入它的人員池。\n\n確定嗎？`)) return;
  try{
    const r = await api("POST", { op:"adoptSite", projectCode: c.projectCode, site: siteName });
    /* 納管會改動工地清單與名單池，兩者都在 scope=all 裡——重抓一次才看得到 */
    await refreshData(true).catch(()=>{});
    toast(`已納管「${siteName}」（專案代碼 ${c.projectCode}，帶入 ${r.peopleAdded} 位人員）`);
    candidateState.splice(i, 1);
    renderCandidates();
    renderSettings();
  }catch(err){
    if(err && err.status === 501){ toast("⚠ 此環境無 ERP 連線，工地納管僅地端可用"); return; }
    if(err && err.status === 409){ toast("⚠ 這個專案代碼已對映到別的工地，請先確認"); return; }
    toast("⚠ 納管失敗，請稍後再試");
  }
}

function initAdoptUI(){
  const btn = document.getElementById("loadCandidatesBtn");
  if(!btn) return;
  btn.addEventListener("click", loadCandidates);
  const box = document.getElementById("candidateBox");
  box.addEventListener("input", e=>{
    const el = e.target.closest(".cand-name");
    if(!el) return;
    const c = candidateState[parseInt(el.dataset.i,10)];
    if(c) c.siteName = el.value;      // 記住使用者改過的名稱，重繪時不會被吃掉
  });
  box.addEventListener("click", e=>{
    const b = e.target.closest(".cand-adopt");
    if(b) adoptCandidate(parseInt(b.dataset.i,10));
  });
}

function initSettings(){
  document.getElementById("saveSettings").addEventListener("click", async ()=>{
    if(!isAdmin()){ toast("僅限管理員操作"); return; }
    const siteLines = document.getElementById("cfg_sites").value.split("\n").map(s=>s.trim()).filter(Boolean);
    if(siteLines.length) MASTER.sites = Array.from(new Set(siteLines));

    /* v23.2 管理員部門白名單。留白＝送空陣列，後端會回退到系統預設值
       （而不是「沒有任何管理員」——那會把所有人鎖在門外，見合約 §4.1） */
    MASTER.adminDepartments = Array.from(new Set(
      document.getElementById("cfg_adminDepts").value.split("\n").map(s=>s.trim()).filter(Boolean)));

    // v15.1：人員名單批次貼上也須逐行單一人名（與「新增選項」同一規則）
    const peopleLines = document.getElementById("cfg_people").value.split("\n").map(s=>s.trim()).filter(Boolean);
    const badNames = peopleLines.filter(p=>MULTI_NAME_RE.test(p));
    if(badNames.length){
      toast(`人員名單每行僅限一位人名，請修正後再儲存：${badNames.slice(0,3).join("、")}${badNames.length>3?"…":""}`);
      return;
    }

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
      ssSet("dm_site", MASTER.currentSite);
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
      downloadBlob(blob, `點工機具_完整備份_${localDate()}.json`, "備份已下載，請妥善保存");
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
    ssDel("dm_site");
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
  renderRatesPanel();   // v22.8：含切換工地——綁定選單必須跟著換站重畫
}

/* ==========================================================
   登出與閒置逾時（v22，資訊處要求）
   - 閒置 10 分鐘無操作 → 清除本分頁工作狀態（含管理員模式）並回選站畫面
   - 「登出」按鈕：同樣的清除，手動觸發
   - 過渡期範圍限制：Basic Auth 帳密由瀏覽器保存、無法用程式清除——
     本機制清的是 sessionStorage（dm_site/dm_admin）與畫面狀態；
     地端 SSO 上線後改為丟棄 token（AUTH-PLAN §4），機制沿用
   - 分頁在背景時不靠計時器輪詢：記「最後操作時間」，回前景立即補查，
     掛著過夜的分頁一回來就會被登出
   ========================================================== */
const IDLE_LIMIT_MS = 10 * 60 * 1000;
/* 絕對上限：即使表單有未送出內容也照樣登出。
   放著超過半小時的表單已非「正在填」，而共用平板上留著管理員 session
   的風險大於那份內容——寬限不可無限延長。 */
const IDLE_HARD_LIMIT_MS = 30 * 60 * 1000;
let lastActivityAt = Date.now();
/* 本輪是否由登出／逾時進來（initIdleLogout 消費旗標後寫入，供 boot 判斷
   是否跳過「單一工地自動進入」）——宣告在此供兩處共用 */
let lastLogoutReason = null;

function resetWorkSession(reason){
  // dm_auditor＝上一位稽核人員的真實姓名，會回填稽核表單預設值；
  // 共用平板上不清會讓下一位以前一位的名義送出稽核
  ["dm_site", "dm_admin", "dm_auditor"].forEach(ssDel);
  ssSet("dm_logout_reason", reason);                    // reload 後由本檔尾段顯示提示
  location.reload();
}

/* 有沒有「還沒送出的輸入」——決定逾時要不要寬限。

   不可改用 anyEditing()：那組 editing*Id 只在**編輯既有單**時才設定
   （loadXxxRecord），使用者新開一張申請單填到一半時全是 null，
   正好是最常見的情境卻不受保護。這裡直接看畫面上有沒有值。 */
function hasUnsavedInput(){
  const scopes = ["laborApplyForm", "laborReportForm", "equipApplyForm", "equipReportForm",
                  "auditFormWrap", "tab-settings"];
  for(const id of scopes){
    const root = document.getElementById(id);
    if(!root || root.offsetParent === null) continue;    // 未顯示的面板不算
    for(const el of root.querySelectorAll("input, textarea, select")){
      if(el.disabled || el.readOnly || el.type === "hidden") continue;
      if(el.type === "checkbox" || el.type === "radio"){ if(el.checked) return true; continue; }
      if(el.value && el.value.trim() !== "" && el.value !== el.defaultValue) return true;
    }
    // 逐工種列／逐台列／標籤是 DOM 產生的，不在 input 掃描範圍內
    if(root.querySelector(".att-row, .tag-chip, .att-cell")) return true;
  }
  return typeState.length > 0 || usageState.length > 0
      || agentState.length > 0 || equipAgentState.length > 0;   // v23 代辦列
}

function idleCheck(){
  if(!READY) return;                                    // 尚未載入完成不計
  const idle = Date.now() - lastActivityAt;
  if(idle < IDLE_LIMIT_MS) return;
  /* 有未送出的輸入 → 寬限到絕對上限為止。
     **不可重置 lastActivityAt**：那等於每輪都給一個全新的 10 分鐘，
     只要表單開著就永遠不會登出，資訊處要求的共用平板防護會完全失效。
     不重置的話，表單一送出/取消，下一個 30 秒 tick 就會立刻登出。 */
  if(idle < IDLE_HARD_LIMIT_MS && hasUnsavedInput()) return;
  resetWorkSession("idle");
}

function initIdleLogout(){
  ["pointerdown", "keydown", "wheel", "touchmove", "scroll"].forEach(ev=>
    document.addEventListener(ev, ()=>{ lastActivityAt = Date.now(); }, { passive: true, capture: true }));
  setInterval(idleCheck, 30 * 1000);
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) idleCheck(); });

  // 舊版 index.html 配新版 app.js 時按鈕可能不存在——不可讓整個 init 中斷
  const btn = document.getElementById("logoutBtn");
  if(btn) btn.addEventListener("click", ()=>{
    if(!confirm("登出將清除本分頁的工作狀態（含管理員模式與未送出的表單內容），回到選擇工地畫面。確定登出？")) return;
    resetWorkSession("manual");
  });

  // 顯示上一輪的登出原因（reload 後執行到這裡）。本函式先於 boot() 執行，
  // 故把消費掉的旗標留在 lastLogoutReason 供 boot 判斷是否跳過自動進站
  lastLogoutReason = ssGet("dm_logout_reason");
  if(lastLogoutReason){
    ssDel("dm_logout_reason");
    setTimeout(()=>toast(lastLogoutReason === "idle"
      ? "閒置超過 10 分鐘，為保護資料已自動登出，請重新選擇工地"
      : "已登出，請重新選擇工地"), 600);
  }
}

/* ---------------- init ---------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  initTabs();
  initSubTabs();
  initCollapsibles();
  initListFilter("labor", "laborListDate", "laborListVendor", "laborListClear", renderLaborList, "laborListApplicant");
  initListFilter("equipment", "equipListDate", "equipListVendor", "equipListClear", renderEquipList, "equipListApplicant");
  initTagRemoveHandler();

  initCombobox("cb_l_vendor", "vendors", "輸入以搜尋分包商");
  initCombobox("cb_l_applicant", "people", "輸入以搜尋申請人");
  initCombobox("cb_l_engineer", "people", "輸入以搜尋簽單責任工程師");
  initCombobox("cb_l_type_add", "laborTypes", "加入出工工種：直接輸入即可（清單沒有的工種會出現「＋ 新增選項」，例：夜班雜工）", {onPick: addTypeRow});
  initCombobox("cb_l_locations", "locations", "輸入以搜尋工作地點", {multi:"l_locations"});
  initCombobox("cb_e_vendor", "vendors", "輸入以搜尋機具廠商");
  initCombobox("cb_e_applyVendor", "vendors", "選填：已知車行可先填，否則回報時再填");   // v22.9.1
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
  initRatesPanel();      // v22.8 行情通報匯入與綁定
  initAdoptUI();         // v23.3 工地納管
  /* v23.1：計價呈現開關。用 class 收起而非把元素移出 DOM——
     多處程式會讀這些容器與 e_rateItem.value（代辦扣抵也要用），
     真的拿掉會整支壞掉。改 PRICING_UI 一個常數就整組回來。 */
  if(!PRICING_UI) document.documentElement.classList.add("no-pricing");
  document.getElementById("refreshBtn").addEventListener("click", ()=>refreshData(false));
  // 連線失敗覆蓋層的「重新載入」鈕：改用事件綁定、不再用內聯 onclick，配合 CSP script-src 'self'
  document.getElementById("fatalReloadBtn").addEventListener("click", ()=>location.reload());
  /* v22.5：說明文字欄位的自動列點。稽核的「現場狀況說明」與「不符原因」是動態
     產生，各自在 renderAuditForm／renderAuditItems 內掛；設定頁名單池與
     工作內容補充刻意不納入（見 initAutoNumber 上方說明）。 */
  // v23：代辦備註改為逐列的單行輸入（不需要列點），故從清單移除
  ["l_conclusion", "e_applyNote", "e_workContent"]
    .forEach(id=>initAutoNumber(document.getElementById(id)));
  initIdleLogout();

  boot();
});
