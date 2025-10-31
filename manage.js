// ▼▼ 接続設定 ▼▼
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzHAkmuVd8ap40sKMEDFs73ji1YlCRxPxu3xRfmRq0S7XUzptjMAp8gkp8WeHvadMWu/exec';
const SECURITY_SECRET = '9f3a7c1e5b2d48a0c6e1f4d9b3a8c2e7d5f0a1b6c3d8e2f7a9b0c4e6d1f3a5b7';

// オートセグメントしきい値
const FOLLOWUP_THRESHOLD_DAYS = 90;
const LOYAL_MIN_VISITS = 5;
const NEW_THRESHOLD_DAYS = 30;
const TICKET_EXPIRY_SOON_DAYS = 30;

// ===== Settings (localStorage) =====
const LS = {
  theme: 'crm_theme',
  cols:  'crm_cols',
  view:  'crm_viewMode',
  per:   'crm_perPage',
  sort:  'crm_sort'
};
const settings = {
  get theme(){ return localStorage.getItem(LS.theme) || 'system'; },
  set theme(v){ localStorage.setItem(LS.theme, v); applyTheme(); },
  get cols(){ try { return JSON.parse(localStorage.getItem(LS.cols) || '[]'); } catch { return []; } },
  set cols(arr){ localStorage.setItem(LS.cols, JSON.stringify(arr)); applyColumnVisibility(); },
  get view(){ return localStorage.getItem(LS.view) || 'auto'; },
  set view(v){ localStorage.setItem(LS.view, v); document.body.classList.remove('view-auto','view-mobile','view-desktop'); document.body.classList.add('view-'+v); selectViewRadio(v); },
  get per(){ return Number(localStorage.getItem(LS.per) || '20'); },
  set per(n){ localStorage.setItem(LS.per, String(n)); state.perPage = n; state.page = 1; render(); showToast(`1ページ ${n} 件表示`, 'success'); },
  get sort(){ return localStorage.getItem(LS.sort) || 'lastReservation:desc'; },
  set sort(s){ localStorage.setItem(LS.sort, s); }
};

const state = {
  customers: [],
  reservations: [],
  filtered: [],
  page: 1, perPage: settings.per,
  sortKey: 'lastReservation', sortDir: 'desc',
  selectedCustomerKey: null,
  distinctMenus: [],
  editMode: false,
  editSnapshot: null,
  focusIndex: -1,
  currentHist: [],
};

// ===== Util =====
const qs = s => document.querySelector(s);
const qsa = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const z = n => String(n).padStart(2,'0');
const fmt = iso => {
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return iso;
  return `${d.getFullYear()}/${z(d.getMonth()+1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};
const keyOf = r => (r.email || r.phone || r.name || '').toLowerCase().trim();
function getKey(obj){ return (obj && (obj.key || (obj.email || obj.phone || obj.name)))?.toLowerCase().trim() || ''; }

const parseAnyDate = v => v ? new Date(v) : null;
const toIsoTZ = (ymdhm, tz='+09:00') => `${ymdhm}:00${tz}`;

function debounce(fn, wait=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }

// 入力タイプ対応チェック（iOS古め対策）
const supportsDatetimeLocal = (() => {
  const i = document.createElement('input');
  i.setAttribute('type', 'datetime-local');
  return i.type === 'datetime-local';
})();

// GET helper
async function fetchJson(url){
  const res = await fetch(url, { method:'GET' });
  const j = await res.json().catch(()=>null);
  if(!res.ok || !j || !j.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.data || [];
}

// ===== Toasts =====
function ensureToastHost(){
  if (!document.getElementById('toastwrap')) {
    const w = document.createElement('div');
    w.id = 'toastwrap';
    w.setAttribute('aria-live','polite');
    document.body.appendChild(w);
  }
}
function showToast(msg, type=''){
  ensureToastHost();
  const w = document.getElementById('toastwrap');
  const t = document.createElement('div');
  t.className = `toast ${type||''}`;
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; }, 2600);
  setTimeout(()=>{ t.remove(); }, 3100);
}

// ===== Theme =====
function applyTheme(){
  const v = settings.theme;
  const root = document.documentElement;
  if (v === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', v);
}
function toggleThemeQuick(){
  const v = settings.theme;
  settings.theme = (v === 'dark') ? 'light' : 'dark';
}

// ===== Global Loading Overlay =====
function setGlobalLoading(on, text){
  const el = document.querySelector('#loading');
  if (!el) return;
  if (text) el.querySelector('.loading-text').textContent = text;
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
  document.body.classList.toggle('is-loading', !!on);
}
function showLoadError(msg){
  setGlobalLoading(true, msg || '読み込みに失敗しました。');
  const retryBtn = document.querySelector('#loading .retry');
  if (retryBtn) retryBtn.hidden = false;
}
function wireLoadingRetry(){
  const retryBtn = document.querySelector('#loading .retry');
  if (!retryBtn || retryBtn.dataset.wired) return;
  retryBtn.dataset.wired = '1';
  retryBtn.addEventListener('click', async ()=>{
    retryBtn.hidden = true;
    setGlobalLoading(true, '再試行中…');
    try { await loadData(); setGlobalLoading(false); }
    catch(e){ console.error(e); showLoadError('再試行に失敗しました。ネットワークや権限をご確認ください。'); }
  });
}

/* ===== Global Saving Overlay ===== */
function setGlobalSaving(on, text){
  const el = document.getElementById('saving');
  if (!el) return;
  if (text) el.querySelector('.saving-text').textContent = text;
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
  el.setAttribute('aria-busy', on ? 'true' : 'false');
  document.body.classList.toggle('is-saving', !!on);
  document.documentElement.classList.toggle('is-saving', !!on);
}
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
/** 保存系で使う共通ラッパー（保存中ロック→保存しました→自動クローズ） */
async function withSaving(task, opts={}){
  const { start='保存中です…', done='保存しました', hold=900 } = opts;
  setGlobalSaving(true, start);
  try{
    const result = typeof task === 'function' ? await task() : await task;
    setGlobalSaving(true, done);
    await sleep(hold);
    setGlobalSaving(false);
    return result;
  }catch(e){
    setGlobalSaving(false);
    throw e;
  }
}

// ====== Data Load & Enhance ======
async function loadData(){
  const base = GAS_WEBAPP_URL;
  const [customersRaw, reservationsRaw] = await Promise.all([
    fetchJson(`${base}?resource=customers&secret=${encodeURIComponent(SECURITY_SECRET)}`),
    fetchJson(`${base}?resource=reservations&secret=${encodeURIComponent(SECURITY_SECRET)}`)
  ]);

  state.reservations = (reservationsRaw || []).map(r=>{
    const startD = parseAnyDate(r.startIso || r.start);
    const endD   = parseAnyDate(r.endIso   || r.end);
    return {
      ...r,
      key: (r.key || keyOf(r)),
      startIso: startD ? `${startD.getFullYear()}-${z(startD.getMonth()+1)}-${z(startD.getDate())}T${z(startD.getHours())}:${z(startD.getMinutes())}:00+09:00` : '',
      endIso:   endD   ? `${endD.getFullYear()}-${z(endD.getMonth()+1)}-${z(endD.getDate())}T${z(endD.getHours())}:${z(endD.getMinutes())}:00+09:00`   : '',
      startMs: startD ? startD.getTime() : NaN,
      endMs:   endD   ? endD.getTime()   : NaN,
      memo: r.memo || '',
      medium: r.medium || ''
    };
  });

  state.customers = (customersRaw || []).map(c => ({
    ...c,
    firstReservation: c.firstReservationIso,
    lastReservation:  c.lastReservationIso
  })).map(enhanceCustomer);

  state.distinctMenus = [...new Set(state.reservations.map(r => r.menu).filter(Boolean))].sort();
  qs('#menuFilter').innerHTML =
    `<option value="">すべて</option>` + state.distinctMenus.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');

  applyColumnVisibility();
  state.perPage = settings.per;

  applyFilter();
}

function enhanceCustomer(c){
  const now = new Date();
  const last = c.lastReservation ? new Date(c.lastReservation) : null;
  const days = last ? Math.floor((now - last)/86400000) : null;

  const auto = [];
  if ((c.totalReservations||0) === 1 && last && (now - last)/86400000 <= NEW_THRESHOLD_DAYS) auto.push({k:'new', label:'新規'});
  if ((c.totalReservations||0) >= LOYAL_MIN_VISITS && last && (now - last)/86400000 <= FOLLOWUP_THRESHOLD_DAYS) auto.push({k:'loyal', label:'常連'});
  if (days!=null && days >= FOLLOWUP_THRESHOLD_DAYS) auto.push({k:'idle', label:`休眠`});

  if (c.ticketExpiry) {
    const exp = new Date(c.ticketExpiry);
    if (!isNaN(exp) && exp - now <= TICKET_EXPIRY_SOON_DAYS*86400000 && exp - now > 0) {
      auto.push({k:'ticket', label:'回数券期限近'});
    }
  }

  const latestPast = c.latestPast ?? (!!last && (now - last) > 0);
  const daysSinceLast = c.daysSinceLast ?? (last ? Math.floor((now - last)/86400000) : null);

  return { ...c, _auto: auto, _idleDays: days, latestPast, daysSinceLast };
}

// ====== Filter / Sort / Render ======
const applyFilterDebounced = debounce(applyFilter, 250);

function applyFilter(){
  const qVal = qs('#q').value.trim().toLowerCase();
  const from = qs('#from').value ? new Date(qs('#from').value) : null;
  const to   = qs('#to').value   ? new Date(qs('#to').value)   : null; if (to) to.setHours(23,59,59,999);
  const menu = qs('#menuFilter').value;
  const tagQ = qs('#tagFilter').value.trim().toLowerCase();
  const quick = qs('#quickSeg').value;

  let arr = state.customers.filter(c =>
    !qVal || [c.name,c.email,c.phone].some(v => (v||'').toLowerCase().includes(qVal))
  );

  if (tagQ) arr = arr.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(tagQ)));

  if (from || to || menu) {
    const match = (cust) => {
      const k = getKey(cust);
      return state.reservations.some(r => {
        if (getKey(r) !== k) return false;
        const d = r.startIso ? new Date(r.startIso) : null;
        if (from && (!d || d < from)) return false;
        if (to   && (!d || d > to))   return false;
        if (menu && r.menu !== menu)  return false;
        return true;
      });
    };
    arr = arr.filter(match);
  }

  if (quick === 'new')  arr = arr.filter(c => (c._auto||[]).some(a => a.k==='new'));
  if (quick === 'loyal')arr = arr.filter(c => (c._auto||[]).some(a => a.k==='loyal'));
  if (quick === 'idle') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='idle'));

  state.filtered = arr;
  applySort();
}

function applySort(){
  const [key,dir] = qs('#sort').value.split(':');
  state.sortKey=key; state.sortDir=dir;
  const m = dir==='asc' ? 1 : -1;
  state.filtered.sort((a,b)=>{
    const va=a[key]??'', vb=b[key]??'';
    if (typeof va==='number' && typeof vb==='number') return (va - vb)*m;
    return String(va).localeCompare(String(vb))*m;
  });
  settings.sort = qs('#sort').value;
  state.page=1;
  render();
}

function render(){ renderTable(); renderCards(); renderPager(); }

function highlightText(text, query){
  const s = String(text ?? '');
  const q = String(query ?? '').trim();
  if(!q) return esc(s);
  const terms = q.split(/\s+/).filter(Boolean).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  if(terms.length===0) return esc(s);
  const r = new RegExp(terms.join('|'), 'ig');
  let out = '', last = 0;
  s.replace(r, (m, _1, idx) => { out += esc(s.slice(last, idx)) + `<mark class="hl">${esc(m)}</mark>`; last = idx + m.length; return m; });
  out += esc(s.slice(last));
  return out;
}

function makeContactCell(r, qVal){
  const phone = esc(r.phone||'');
  const mail = esc(r.email||'');
  const items = [];
  if (phone) items.push(`<a href="tel:${phone}">📞 ${highlightText(r.phone||'', qVal)}</a>`);
  if (mail) items.push(`<a href="mailto:${mail}">✉️ ${highlightText(r.email||'', qVal)}</a>`);
  return `<div class="cell-contacts">${items.join('')}</div>`;
}

function makeActionLinks(r){
  const phone = r.phone ? `<a href="tel:${esc(r.phone)}" title="電話">📞</a>` : '';
  const mail  = r.email ? `<a href="mailto:${esc(r.email)}" title="メール">✉️</a>` : '';
  const map   = r.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(r.address)}" target="_blank" title="地図">🗺️</a>` : '';
  return `${phone}${mail}${map}`;
}

function renderTable(){
  const tb = qs('#customers tbody'); tb.innerHTML='';
  const qVal = qs('#q').value.trim();
  const start=(state.page-1)*state.perPage, rows=state.filtered.slice(start, start+state.perPage);

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="empty" colspan="9">該当する顧客が見つかりません。条件や期間、メニューを見直してください。</td>`;
    tb.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for(const r of rows){
    const tr=document.createElement('tr');

    const tagsHtml = (r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ');
    const autoHtml = (r._auto||[]).map(a=>{
      const cls = a.k==='idle'?'badge idle':(a.k==='loyal'?'badge loyal':(a.k==='new'?'badge new':'badge'));
      return `<span class="${cls}">${esc(a.label)}</span>`;
    }).join(' ');

    const lastBadge = (()=>{
      if (!r.lastReservation) return '';
      return r.latestPast ? ` <span class="badge past">過去（${r.daysSinceLast ?? '-'}日前）</span>` : ` <span class="badge future">未来</span>`;
    })();

    tr.innerHTML = `
      <td>${highlightText(r.name || '', qVal)}${r._idleDays!=null && r._idleDays>=FOLLOWUP_THRESHOLD_DAYS ? ' <span class="badge idle">要フォロー</span>' : ''}</td>
      <td>${makeContactCell(r, qVal)}</td>
      <td>${highlightText(r.address||'', qVal)}</td>
      <td>${fmt(r.lastReservation)}${lastBadge}</td>
      <td>${r.totalReservations ?? 0}</td>
      <td>${highlightText(r.lastMenu || r.lastItems || '', qVal)}</td>
      <td>${highlightText(r.staff || '', qVal)}</td>
      <td><div class="tags">${tagsHtml} ${autoHtml}</div></td>
      <td class="cell-actions">${makeActionLinks(r)}</td>
    `;
    tr.addEventListener('click', (e)=>{ if (e.target.tagName === 'A') return; openDrawer(r); });
    frag.appendChild(tr);
  }
  tb.appendChild(frag);
  updateRowFocus();
}

function renderCards(){
  const wrap = qs('#cardsSection'); wrap.innerHTML='<h2 class="section-title">顧客一覧（モバイル表示）</h2>';
  const qVal = qs('#q').value.trim();
  const start=(state.page-1)*state.perPage, rows=state.filtered.slice(start, start+state.perPage);

  if (rows.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-card';
    div.textContent = '該当する顧客が見つかりません。条件を調整してください。';
    wrap.appendChild(div);
    return;
  }

  const frag = document.createDocumentFragment();
  for(const r of rows){
    const div=document.createElement('div'); div.className='card';

    const autoHtml = (r._auto||[]).map(a=>{
      const cls = a.k==='idle'?'badge idle':(a.k==='loyal'?'badge loyal':(a.k==='new'?'badge new':'badge'));
      return `<span class="${cls}">${esc(a.label)}</span>`;
    }).join(' ');

    const lastBadge = (()=>{
      if (!r.lastReservation) return '';
      return r.latestPast ? ` <span class="badge past">過去（${r.daysSinceLast ?? '-'}日前）</span>` : ` <span class="badge future">未来</span>`;
    })();

    div.innerHTML = `
      <div class="name">${highlightText(r.name || r.email || r.phone || '', qVal)}</div>
      <div class="meta">最終来店：${fmt(r.lastReservation)}${lastBadge} / 回数：${r.totalReservations ?? 0}</div>
      <div>直近メニュー：${highlightText(r.lastMenu || r.lastItems || '', qVal)}</div>
      <div>担当者：${highlightText(r.staff || '-', qVal)}</div>
      <div class="tags">${(r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ')} ${autoHtml}</div>
      <div style="margin-top:8px">${makeActionLinks(r)}</div>
    `;
    div.addEventListener('click', (e)=>{ if (e.target.tagName !== 'A') openDrawer(r); });
    frag.appendChild(div);
  }
  wrap.appendChild(frag);
}

function renderPager(){
  const pager=qs('#pager'), total=state.filtered.length, pages=Math.max(1,Math.ceil(total/state.perPage));
  pager.innerHTML='';
  const mk=(t,fn)=>{const b=document.createElement('button'); b.textContent=t; b.onclick=fn; return b;};
  pager.appendChild(mk('«',()=>{state.page=1;render();}));
  pager.appendChild(mk('‹',()=>{state.page=Math.max(1,state.page-1);render();}));
  pager.appendChild(document.createTextNode(` ${state.page}/${pages} `));
  pager.appendChild(mk('›',()=>{state.page=Math.min(pages,state.page+1);render();}));
  pager.appendChild(mk('»',()=>{state.page=pages;render();}));
}

// ===== Drawer =====
function openDrawer(customer){
  const k = getKey(customer);
  state.selectedCustomerKey = k;

  const hist = state.reservations
    .filter(r => getKey(r) === k)
    .sort((a,b)=>String(b.startIso||'').localeCompare(String(a.startIso||'')));

  state.currentHist = hist.slice();

  // 流入元カウント
  const srcCounts = {};
  for (const h of hist) {
    const label = (h.medium || '').trim() || '不明';
    srcCounts[label] = (srcCounts[label] || 0) + 1;
  }
  renderSourceStats(srcCounts);

  // 履歴描画（ドロワー幅依存）
  renderHistory(hist);

  const titleName = customer.name || customer.email || customer.phone || '';
  qs('#drawerTitle').textContent = `顧客プロファイル：${titleName}`;
  qs('#quickActions').innerHTML = [
    customer.phone ? `<a href="tel:${esc(customer.phone)}">📞 電話</a>` : '',
    customer.email ? `<a href="mailto:${esc(customer.email)}">✉️ メール</a>` : '',
    customer.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(customer.address)}" target="_blank">🗺️ 地図</a>` : ''
  ].filter(Boolean).join('');

  // フォーム値
  fillProfileForm(customer);

  // 初期は編集不可
  setEditMode(false);

  const drawer=qs('#drawer');
  drawer.setAttribute('aria-hidden','false');
  document.body.classList.add('drawer-open');
  drawer.addEventListener('click',(e)=>{ if(e.target===drawer) closeDrawer(); },{once:true});
  qs('#drawer .close').onclick = closeDrawer;

  // リサイズ/向き変更/ドロワー幅変化を監視して再描画
  if (!openDrawer._resizeBound) {
    openDrawer._resizeBound = true;
    window.addEventListener('resize', debounce(()=> {
      if (qs('#drawer')?.getAttribute('aria-hidden')==='false') {
        renderHistory(state.currentHist);
      }
    }, 150));
  }
  window.addEventListener('orientationchange', debounce(() => {
    if (qs('#drawer')?.getAttribute('aria-hidden') === 'false') {
      renderHistory(state.currentHist);
    }
  }, 150));

  if (!openDrawer._ro) {
    const target = document.querySelector('#drawer .drawer-inner');
    if (target && 'ResizeObserver' in window) {
      openDrawer._ro = new ResizeObserver(debounce(()=> {
        if (qs('#drawer')?.getAttribute('aria-hidden') === 'false') {
          renderHistory(state.currentHist);
        }
      }, 120));
      openDrawer._ro.observe(target);
    }
  }
}

function fillProfileForm(customer){
  setVal('#editName', customer.name);
  setVal('#editKana', customer.kana);
  setVal('#editGender', customer.gender);
  setVal('#editPhone', customer.phone);
  setVal('#editEmail', customer.email);
  setVal('#editAddress', customer.address);
  setVal('#editBirthdate', (customer.birthdate||'').slice(0,10));
  setVal('#editStaff', customer.staff);
  setVal('#editTags', (customer.tags||[]).join(', '));
  setVal('#editMemo', customer.memo);
  setVal('#editAttention', customer.attention);
  setChecked('#editOptEmail', toBool(customer.optInEmail));
  setChecked('#editOptLine', toBool(customer.optInLine));
  setVal('#editConsentDate', (customer.consentDate||'').slice(0,10));
  setVal('#editReferredBy', customer.referredBy);
  setVal('#editReferralCode', customer.referralCode);
  setVal('#editTicketType', customer.ticketType);
  setVal('#editTicketRemain', customer.ticketRemaining);
  setVal('#editTicketExpiry', (customer.ticketExpiry||'').slice(0,10));
  setVal('#editFirst', fmt(customer.firstReservation) || '');
  setVal('#editLast', fmt(customer.lastReservation)  || '');
  qs('#saveStatus').textContent = '';
  state.editSnapshot = JSON.parse(JSON.stringify(customer || {}));
}

function setEditMode(on){
  state.editMode = !!on;
  const grid = document.querySelector('.note-editor .grid');
  if (grid) grid.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.id === 'editFirst' || el.id === 'editLast') { el.readOnly = true; el.disabled = true; return; }
    el.disabled = !on;
  });
  qs('#editToggle').hidden = !!on;
  qs('#saveNote').hidden = !on;
  qs('#cancelEdit').hidden = !on;
}

function setVal(sel, v){ const el=qs(sel); if(el) el.value = v ?? ''; }
function setChecked(sel, v){ const el=qs(sel); if(el) el.checked = !!v; }
function toBool(v){ return String(v).toLowerCase()==='true' || v===true || v==='1' || v===1; }

function closeDrawer(){
  qs('#drawer').setAttribute('aria-hidden','true');
  document.body.classList.remove('drawer-open');
}

function renderSourceStats(counts){
  const wrap = qs('#sourceStats'); if (!wrap) return;
  const entries = Object.entries(counts).sort((a,b)=> b[1]-a[1]);
  if (entries.length === 0) { wrap.innerHTML = '<span class="srcchip">データなし</span>'; return; }
  wrap.innerHTML = entries.map(([label, cnt]) => `<span class="srcchip">${esc(label)}：<span class="count">${cnt}</span></span>`).join(' ');
}

// ===== 来店履歴（PC=表／SP=カード）：ドロワー幅で判定 =====
let lastHistoryIsMobile = null;
function isHistoryMobileLayout() {
  const drawerInner = document.querySelector('#drawer .drawer-inner');
  const w = drawerInner ? drawerInner.clientWidth : window.innerWidth;
  return w <= 900;
}
function renderHistory(hist){
  const mount = qs('#historyMount');
  if (!mount) return;
  const isMobile = isHistoryMobileLayout();
  if (lastHistoryIsMobile === isMobile && mount.childElementCount > 0) return;
  lastHistoryIsMobile = isMobile;

  mount.innerHTML = '';
  if (isMobile) renderHistoryCards(hist, mount);
  else renderHistoryTable(hist, mount);
  wireHistoryEvents(mount);
}

function renderHistoryTable(hist, mount){
  const table = document.createElement('table');
  table.id = 'history';
  table.innerHTML = `
    <thead>
      <tr>
        <th>日時</th>
        <th>メニュー</th>
        <th>項目</th>
        <th>流入元</th>
        <th>メモ</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector('tbody');
  const now = Date.now();

  for(const h of hist){
    const canResched = h.startMs && h.startMs > now;
    const tr=document.createElement('tr');
    tr.dataset.resvId = h.resvId || '';
    tr.dataset.startIso = h.startIso || '';
    tr.innerHTML = `
      <td>${fmt(h.startIso)} ${h.startMs>now?'<span class="hchip future">未来</span>':'<span class="hchip past">過去</span>'}</td>
      <td>${esc(h.menu || '')}</td>
      <td>${esc(h.items||h.opts||'')}</td>
      <td>${esc(h.medium || '')}</td>
      <td>
        <div class="memo-text">${esc(h.memo || '')}</div>
        <button class="memo-edit" type="button">メモ編集</button>
      </td>
      <td>
        ${canResched ? `
          <button class="resched-btn" type="button">日時変更</button>
          <span class="resched-editor" hidden>
            <input type="datetime-local" class="resched-dt" />
            <button class="do-resched" type="button">保存</button>
            <button class="cancel-resched" type="button">×</button>
          </span>
        ` : `<span style="color:#888">-</span>`}
      </td>
    `;
    tb.appendChild(tr);
  }

  mount.appendChild(table);
}

function renderHistoryCards(hist, mount){
  const wrap = document.createElement('div');
  wrap.className = 'history-cards';
  const now = Date.now();

  for(const h of hist){
    const canResched = h.startMs && h.startMs > now;
    const card = document.createElement('div');
    card.className = 'hcard';
    card.dataset.resvId = h.resvId || '';
    card.dataset.startIso = h.startIso || '';

    const chipTime = h.startMs>now ? '<span class="hchip future">未来</span>' : '<span class="hchip past">過去</span>';
    const chipSrc  = `<span class="hchip src">${esc(h.medium || '不明')}</span>`;

    card.innerHTML = `
      <div class="top">
        <div class="when">${fmt(h.startIso)}</div>
        <div class="meta">${chipTime} ${chipSrc}</div>
      </div>
      <div class="body">
        <div><span class="label">メニュー</span><div>${esc(h.menu || '-')}</div></div>
        <div><span class="label">項目</span><div>${esc(h.items||h.opts||'-')}</div></div>
        <div><span class="label">メモ</span><div class="memo memo-text">${esc(h.memo || '')}</div></div>
      </div>
      <div class="actions">
        <button class="memo-edit" type="button">メモ編集</button>
        ${canResched ? `
          <button class="resched-btn" type="button">日時変更</button>
          <span class="resched-editor" hidden>
            <input type="datetime-local" class="resched-dt" />
            <button class="do-resched" type="button">保存</button>
            <button class="cancel-resched" type="button">×</button>
          </span>
        ` : `<span style="color:#888">日時変更不可</span>`}
      </div>
    `;
    wrap.appendChild(card);
  }
  mount.appendChild(wrap);
}

function wireHistoryEvents(container){
  // メモ編集
  container.querySelectorAll('.memo-edit').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const holder = e.target.closest('[data-resv-id]');
      const resvId = holder?.dataset?.resvId || '';
      const cur = holder.querySelector('.memo-text')?.textContent || '';
      const memo = prompt('この予約のメモ', cur);
      if (memo == null) return;
      try{
        await withSaving(async ()=>{
          await postJSON({ action:'upsertResvMemo', resvId, memo });
        }, {start:'保存中です…', done:'保存しました', hold:700});
        holder.querySelector('.memo-text').textContent = memo;
        const keepKey = state.selectedCustomerKey;
        await loadData();
        const again = state.customers.find(c => getKey(c) === keepKey);
        if (again) openDrawer(again);
        showToast('メモを保存しました', 'success');
      }catch(err){ console.error(err); showToast('保存に失敗しました', 'error'); }
    });
  });

  // 日時変更：開く（datetime-local未対応にも対応）
  container.querySelectorAll('.resched-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const holder = e.target.closest('[data-resv-id]');
      const ed = holder.querySelector('.resched-editor');
      ed?.removeAttribute('hidden');

      const startIso = holder.dataset.startIso || '';
      const d = startIso ? new Date(startIso) : null;
      if (!d || isNaN(d)) return;

      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      const hh = String(d.getHours()).padStart(2,'0');
      const mm = String(d.getMinutes()).padStart(2,'0');

      const dt = holder.querySelector('.resched-dt');
      if (supportsDatetimeLocal && dt) {
        dt.value = `${y}-${m}-${day}T${hh}:${mm}`;
      } else {
        if (!holder.querySelector('.resched-date')) {
          const dateInput = document.createElement('input');
          dateInput.type = 'date';
          dateInput.className = 'resched-date';
          const timeInput = document.createElement('input');
          timeInput.type = 'time';
          timeInput.className = 'resched-time';
          const where = holder.querySelector('.resched-editor');
          where.insertBefore(dateInput, where.querySelector('.do-resched'));
          where.insertBefore(timeInput, where.querySelector('.do-resched'));
        }
        const di = holder.querySelector('.resched-date');
        const ti = holder.querySelector('.resched-time');
        di.value = `${y}-${m}-${day}`;
        ti.value = `${hh}:${mm}`;
      }
    });
  });

  // 日時変更：閉じる
  container.querySelectorAll('.cancel-resched').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const holder = e.target.closest('[data-resv-id]');
      holder.querySelector('.resched-editor')?.setAttribute('hidden','');
    });
  });

  // 日時変更：保存（datetime-local 未対応でも保存可能）
  container.querySelectorAll('.do-resched').forEach(btn=>{
    btn.addEventListener('click', async e=>{
      const holder = e.target.closest('[data-resv-id]');
      const resvId = holder?.dataset?.resvId || '';

      let dtValue = '';
      const dt = holder.querySelector('.resched-dt');
      if (supportsDatetimeLocal && dt && dt.value) {
        dtValue = dt.value;
      } else {
        const di = holder.querySelector('.resched-date');
        const ti = holder.querySelector('.resched-time');
        if (di?.value && ti?.value) {
          dtValue = `${di.value}T${ti.value}`;
        }
      }

      if (!dtValue) return showToast('日時を選択してください', 'warn');

      try{
        await withSaving(async ()=>{
          await postJSON({ action:'rescheduleById', resvId, newStartIso: toIsoTZ(dtValue) });
          const keepKey = state.selectedCustomerKey;
          await loadData();
          const again = state.customers.find(c => getKey(c) === keepKey);
          if (again) openDrawer(again);
        }, { start:'保存中です…', done:'保存しました', hold:900 });
        showToast('日時を変更しました', 'success');
      }catch(err){
        console.error(err);
        showToast('変更に失敗しました（営業時間外・重複・過去予約等の可能性）','error');
      }
    });
  });
}

// ===== 保存（POST） =====
async function postJSON(body){
  const res = await fetch(GAS_WEBAPP_URL, {
    method:'POST',
    headers:{ 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret:SECURITY_SECRET, ...body })
  });
  const j = await res.json().catch(()=>null);
  if (!res.ok || !j || j.ok===false) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.data || j.result || j;
}

async function saveNote(){
  if (!state.editMode) return;
  const key = state.selectedCustomerKey; if(!key) return;

  const body = {
    action:'upsertNote', key,
    name: qs('#editName').value.trim(),
    kana: qs('#editKana').value.trim(),
    gender: qs('#editGender').value,
    phone: qs('#editPhone').value.trim(),
    email: qs('#editEmail').value.trim(),
    address: qs('#editAddress').value.trim(),
    birthdate: qs('#editBirthdate').value,
    staff: qs('#editStaff').value.trim(),
    tags: qs('#editTags').value.split(',').map(s=>s.trim()).filter(Boolean),
    memo: qs('#editMemo').value,
    attention: qs('#editAttention').value,
    optInEmail: qs('#editOptEmail').checked ? 'TRUE' : 'FALSE',
    optInLine: qs('#editOptLine').checked ? 'TRUE' : 'FALSE',
    consentDate: qs('#editConsentDate').value,
    referredBy: qs('#editReferredBy').value,
    referralCode: qs('#editReferralCode').value,
    ticketType: qs('#editTicketType').value,
    ticketRemaining: qs('#editTicketRemain').value,
    ticketExpiry: qs('#editTicketExpiry').value
  };

  qs('#saveNote').disabled = true; qs('#saveStatus').textContent = '';
  try{
    await withSaving(async ()=>{
      await postJSON(body);
      const keepKey = state.selectedCustomerKey;
      await loadData();
      const again = state.customers.find(c => getKey(c) === keepKey);
      if (again) openDrawer(again);
      setEditMode(false);
    }, { start:'保存中です…', done:'保存しました', hold:900 });
    showToast('顧客情報を保存しました', 'success');
  }catch(e){
    console.error(e);
    qs('#saveStatus').textContent = '保存に失敗しました。';
    showToast('保存に失敗しました', 'error');
  }finally{
    qs('#saveNote').disabled = false;
  }
}

// ===== 列表示切替（任意/将来用） =====
function getColumnsMeta(){
  const ths = qsa('#customers thead th');
  return ths.map((th, i)=>({ index:i+1, label: th.textContent.trim() || `列${i+1}` }));
}
function applyColumnVisibility(){
  const cols = settings.cols;
  const meta = getColumnsMeta();
  const table = qs('#customers');
  if (!table) return;
  for(let i=1;i<=meta.length;i++){ table.classList.remove(`hide-col-${i}`); }
  if (!Array.isArray(cols) || cols.length===0) return;
  meta.forEach((m,idx)=>{
    const visible = cols[idx] !== false;
    if (!visible) table.classList.add(`hide-col-${m.index}`);
  });
}
function selectViewRadio(v){
  const r = document.querySelector(`.view-toggle input[value="${v}"]`);
  if (r) r.checked = true;
}

// ===== Keyboard Navigation =====
function getRenderedRowEls(){ return qsa('#customers tbody tr'); }
function updateRowFocus(){
  const rows = getRenderedRowEls();
  rows.forEach(r=>r.classList.remove('row-focus'));
  if (state.focusIndex<0 || state.focusIndex>=rows.length) return;
  rows[state.focusIndex].classList.add('row-focus');
}
function moveFocus(delta){
  const rows = getRenderedRowEls();
  if (rows.length===0) return;
  if (state.focusIndex===-1) state.focusIndex = 0;
  else state.focusIndex = Math.min(rows.length-1, Math.max(0, state.focusIndex + delta));
  updateRowFocus();
}
function openFocused(){
  const idx = state.focusIndex;
  if (idx<0) return;
  const abs = (state.page-1)*state.perPage + idx;
  const r = state.filtered[abs];
  if (r) openDrawer(r);
}

// ===== Events =====
function attach(){
  // 入力 → デバウンス
  ['#q','#from','#to','#menuFilter','#tagFilter','#quickSeg'].forEach(sel=>{
    const el = qs(sel);
    el.addEventListener('input', applyFilterDebounced);
    el.addEventListener('change', applyFilter);
  });

  qs('#sort').addEventListener('change', ()=>{ applySort(); });

  // 再読込
  qs('#reload').addEventListener('click', async ()=>{
    try { setGlobalLoading(true, '更新中…'); await loadData(); showToast('最新データを取得しました', 'success'); }
    finally { setGlobalLoading(false); }
  });

  // CSV
  qs('#exportCsv').addEventListener('click', exportCsv);

  // 編集ゲート：編集/保存/キャンセル
  qs('#editToggle').addEventListener('click', ()=> setEditMode(true));
  qs('#cancelEdit').addEventListener('click', ()=>{
    if (state.editSnapshot) fillProfileForm(state.editSnapshot);
    setEditMode(false);
    qs('#saveStatus').textContent = '';
  });
  qs('#saveNote').addEventListener('click', saveNote);

  // ビュー切替（永続化）
  document.querySelectorAll('input[name="view"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      const v = r.value;
      document.body.classList.remove('view-auto','view-mobile','view-desktop');
      document.body.classList.add('view-'+v);
      settings.view = v;
      // :has() 非対応フォールバック
      updateViewToggleChecked();
    });
  });
  document.body.classList.remove('view-auto','view-mobile','view-desktop');
  document.body.classList.add('view-'+settings.view);
  selectViewRadio(settings.view);

  // :has() 非対応フォールバック（label.checkedを付与）
  function updateViewToggleChecked() {
    document.querySelectorAll('.view-toggle label').forEach(l => l.classList.remove('checked'));
    const cur = document.querySelector('.view-toggle input:checked');
    if (cur) cur.closest('label')?.classList.add('checked');
  }
  document.querySelectorAll('.view-toggle input').forEach(r => {
    r.addEventListener('change', updateViewToggleChecked);
  });
  updateViewToggleChecked();

  // キーボードショートカット
  document.addEventListener('keydown', (e)=>{
    // 保存中はキーボード操作も抑止
    if (document.body.classList.contains('is-saving')) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag==='input' || tag==='textarea' || e.target.isContentEditable;

    if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); qs('#q').focus(); return;
    }
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); moveFocus(e.key==='ArrowDown' ? 1 : -1); return;
    }
    if (!typing && e.key === 'Enter') { openFocused(); return; }
    if (e.key === 'Escape') {
      const drawerOpen = qs('#drawer')?.getAttribute('aria-hidden')==='false';
      if (drawerOpen){ closeDrawer(); return; }
    }
  });
}

// ===== CSV =====
function exportCsv(){
  const headers = [
    '氏名','氏名（カナ）','性別','電話','メール','住所','生年月日',
    '初回予約日','最終予約日','回数','直近メニュー','担当者',
    'タグ','メモ','注意事項','配信同意(メール)','配信同意(LINE)','同意日',
    '紹介者','紹介コード','回数券','残回数','券期限',
    '自動セグメント'
  ];
  const rows = state.filtered.map(r=>{
    const auto = (r._auto||[]).map(a=>a.label).join(' ');
    return [
      r.name||'', r.kana||'', r.gender||'', r.phone||'', r.email||'', r.address||'', (r.birthdate||'').slice(0,10),
      fmt(r.firstReservation), fmt(r.lastReservation),
      r.totalReservations??0, r.lastMenu||r.lastItems||'', r.staff||'',
      (r.tags||[]).join(' '), r.memo||'', r.attention||'',
      toBool(r.optInEmail)?'TRUE':'FALSE', toBool(r.optInLine)?'TRUE':'FALSE', (r.consentDate||'').slice(0,10),
      r.referredBy||'', r.referralCode||'', r.ticketType||'', r.ticketRemaining||'', (r.ticketExpiry||'').slice(0,10),
      auto
    ];
  });

  const csv = [headers,...rows].map(line=>line.map(v=>(/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a=document.createElement('a'); a.href=url; a.download=`customers_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

// ===== Init =====
(async function init(){
  try {
    ensureToastHost();
    setGlobalLoading(true, 'データを読み込んでいます…');
    attach();
    wireLoadingRetry();
    await (async function maybeHandleTokenView(){
      const p = new URLSearchParams(location.search); const token=p.get('token'); if(!token) return;
      qs('#tokenView').style.display='';
      try{
        const res=await fetch(`${GAS_WEBAPP_URL}?op=view&format=json&token=${encodeURIComponent(token)}`);
        qs('#tokenResult').textContent = JSON.stringify(await res.json(), null, 2);
      }catch(e){ qs('#tokenResult').textContent='読み込みに失敗しました。'; }
    })();
    await loadData();
    setGlobalLoading(false);
  } catch(e){
    console.error(e);
    showLoadError('読み込みに失敗しました。［再読み込み］を押してください。');
  }
})();
