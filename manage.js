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
  theme: 'crm_theme',          // 'system' | 'light' | 'dark'
  cols:  'crm_cols',           // boolean[] 長さ=列数
  view:  'crm_viewMode',       // 'auto' | 'mobile' | 'desktop'
  per:   'crm_perPage',        // 20/50/100...
  sort:  'crm_sort'            // e.g. 'lastReservation:desc'
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
  dupes: [],
  editMode: false,
  editSnapshot: null,
  focusIndex: -1 // 現ページ内のフォーカス行
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

// 高速化：デバウンス
function debounce(fn, wait=300){
  let t; return (...args)=>{ clearTimeout(t); t = setTimeout(()=>fn.apply(null,args), wait); };
}

// 検索ハイライト
function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function highlightText(text, query){
  const s = String(text ?? '');
  const q = String(query ?? '').trim();
  if(!q) return esc(s);
  const terms = q.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if(terms.length===0) return esc(s);
  try{
    const r = new RegExp(terms.join('|'), 'ig');
    let out = '', last = 0;
    s.replace(r, (m, _1, idx) => {
      out += esc(s.slice(last, idx)) + `<mark class="hl">${esc(m)}</mark>`;
      last = idx + m.length;
      return m;
    });
    out += esc(s.slice(last));
    return out;
  }catch{ return esc(s); }
}

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
    w.setAttribute('aria-live','polite'); // SRに伝える
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
  const v = settings.theme; // 'system'|'light'|'dark'
  const root = document.documentElement;
  if (v === 'system') {
    root.removeAttribute('data-theme');
    showToast('テーマ：システムに従う', 'success');
  } else {
    root.setAttribute('data-theme', v);
    showToast(`テーマ：${v==='dark'?'ダーク':'ライト'}`, 'success');
  }
}
function toggleThemeQuick(){
  const v = settings.theme;
  // system→dark→light→dark...ではなく、実用上は dark/light のトグルを好む
  const next = (v === 'dark') ? 'light' : 'dark';
  settings.theme = next;
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

// ====== Data Load & Enhance ======
async function loadData(){
  const base = GAS_WEBAPP_URL;
  const [customersRaw, reservationsRaw] = await Promise.all([
    fetchJson(`${base}?resource=customers&secret=${encodeURIComponent(SECURITY_SECRET)}`),
    fetchJson(`${base}?resource=reservations&secret=${encodeURIComponent(SECURITY_SECRET)}`)
  ]);

  // 正規化
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
    `<option value="">メニュー：すべて</option>` + state.distinctMenus.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');

  state.dupes = findDuplicates(state.customers);
  renderDupes();

  // 設定復元
  applyColumnVisibility();
  // ページサイズ復元
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
const applyFilterDebounced = debounce(applyFilter, 300);

function applyFilter(){
  const qVal = qs('#q').value.trim().toLowerCase();
  const from = qs('#from').value ? new Date(qs('#from').value) : null;
  const to   = qs('#to').value   ? new Date(qs('#to').value)   : null; if (to) to.setHours(23,59,59,999);
  const menu = qs('#menuFilter').value;
  const tagQ = qs('#tagFilter').value.trim().toLowerCase();
  const quick = qs('#quickSeg').value;
  const followOnly = qs('#followOnly').checked;

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

  if (quick === 'new') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='new'));
  if (quick === 'loyal') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='loyal'));
  if (quick === 'idle') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='idle'));

  if (followOnly) arr = arr.filter(c => (c._auto||[]).some(a => a.k==='idle' || a.k==='ticket'));

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
  updateRowFocus(); // 再描画時にフォーカス行の見た目を再適用
}

function renderCards(){
  const wrap = qs('#cardsSection'); wrap.innerHTML='';
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

  // 流入元カウント
  const srcCounts = {};
  for (const h of hist) {
    const label = (h.medium || '').trim() || '不明';
    srcCounts[label] = (srcCounts[label] || 0) + 1;
  }
  renderSourceStats(srcCounts);

  // 履歴テーブル
  const tb = qs('#history tbody'); if (!tb) { console.warn('#history tbody not found'); return; }
  tb.innerHTML='';
  const now = Date.now();
  for(const h of hist){
    const canResched = h.startMs && h.startMs > now;
    const tr=document.createElement('tr');
    tr.dataset.resvId = h.resvId || '';

    tr.innerHTML = `
      <td data-label="日時">${fmt(h.startIso)}</td>
      <td data-label="メニュー">${esc(h.menu || '')}</td>
      <td data-label="項目">${esc(h.items||h.opts||'')}</td>
      <td data-label="流入元">${esc(h.medium || '')}</td>
      <td data-label="メモ">
        <div class="memo-text">${esc(h.memo || '')}</div>
        <button class="memo-edit" type="button">メモ編集</button>
      </td>
      <td data-label="操作">
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

  // 行内イベント
  tb.querySelectorAll('.memo-edit').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      const tr = e.target.closest('tr');
      const resvId = tr?.dataset?.resvId || '';
      const cur = tr.querySelector('.memo-text')?.textContent || '';
      const memo = prompt('この予約のメモ', cur);
      if (memo == null) return;
      try{
        await postJSON({ action:'upsertResvMemo', resvId, memo });
        tr.querySelector('.memo-text').textContent = memo;
        const keepKey = state.selectedCustomerKey;
        await loadData();
        const again = state.customers.find(c => getKey(c) === keepKey);
        if (again) openDrawer(again);
        showToast('メモを保存しました', 'success');
      }catch(err){ console.error(err); showToast('保存に失敗しました', 'error'); }
    });
  });
  tb.querySelectorAll('.resched-btn').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const tr = e.target.closest('tr');
      tr.querySelector('.resched-editor')?.removeAttribute('hidden');
      const dt = tr.querySelector('.resched-dt');
      const whenText = tr.children[0].textContent.trim();
      const d = new Date(whenText.replace(/\//g,'-'));
      if (!isNaN(d)) dt.value = `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
    });
  });
  tb.querySelectorAll('.cancel-resched').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const tr = e.target.closest('tr');
      tr.querySelector('.resched-editor')?.setAttribute('hidden','');
    });
  });
  tb.querySelectorAll('.do-resched').forEach(btn=>{
    btn.addEventListener('click', async e=>{
      const tr = e.target.closest('tr');
      const resvId = tr?.dataset?.resvId || '';
      const dt = tr.querySelector('.resched-dt')?.value;
      if (!dt) return showToast('日時を選択してください', 'warn');
      try{
        await postJSON({ action:'rescheduleById', resvId, newStartIso: toIsoTZ(dt) });
        showToast('日時を変更しました', 'success');
        const keepKey = state.selectedCustomerKey;
        await loadData();
        const again = state.customers.find(c => getKey(c) === keepKey);
        if (again) openDrawer(again);
      }catch(err){
        console.error(err);
        showToast('変更に失敗しました（営業時間外・重複・過去予約等の可能性）','error');
      }
    });
  });

  // タイトル & クイックアクション
  const titleName = customer.name || customer.email || customer.phone || '';
  qs('#drawerTitle').textContent = `顧客プロファイル：${titleName}`;
  qs('#quickActions').innerHTML = [
    customer.phone ? `<a href="tel:${esc(customer.phone)}">📞 電話</a>` : '',
    customer.email ? `<a href="mailto:${esc(customer.email)}">✉️ メール</a>` : '',
    customer.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(customer.address)}" target="_blank">🗺️ 地図</a>` : ''
  ].filter(Boolean).join('');

  // フォーム値
  fillProfileForm(customer);

  // 初期は編集不可（編集ゲート）
  setEditMode(false);

  const drawer=qs('#drawer');
  drawer.setAttribute('aria-hidden','false');
  document.body.classList.add('drawer-open');
  drawer.addEventListener('click',(e)=>{ if(e.target===drawer) closeDrawer(); },{once:true});
  qs('#drawer .close').onclick = closeDrawer;
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

  qs('#saveNote').disabled = true; qs('#saveStatus').textContent = '保存中…';
  try{
    await postJSON(body);
    qs('#saveStatus').textContent = '保存しました。';
    showToast('顧客情報を保存しました', 'success');
    const keepKey = state.selectedCustomerKey;
    await loadData();
    const again = state.customers.find(c => getKey(c) === keepKey);
    if (again) openDrawer(again);
    setEditMode(false);
  }catch(e){
    console.error(e); qs('#saveStatus').textContent = '保存に失敗しました。'; showToast('保存に失敗しました', 'error');
  }finally{
    qs('#saveNote').disabled = false;
  }
}

// ===== 重複候補（簡易） =====
function findDuplicates(customers){
  const out = [];
  const byEmail = new Map();
  const byPhone = new Map();

  customers.forEach(c=>{
    const e = (c.email||'').toLowerCase().trim();
    const p = (c.phone||'').replace(/\D/g,'');
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(c); }
    if (p) { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(c); }
  });

  for(const [,arr] of byEmail) if (arr.length>1) pushPairs(arr, '同一メール');
  for(const [,arr] of byPhone) if (arr.length>1) pushPairs(arr, '同一電話');

  const last4 = s => (s||'').replace(/\D/g,'').slice(-4);
  for(let i=0;i<customers.length;i++){
    for(let j=i+1;j<customers.length;j++){
      const a=customers[i], b=customers[j];
      const n1=(a.name||'').toLowerCase().replace(/\s/g,'');
      const n2=(b.name||'').toLowerCase().replace(/\s/g,'');
      if (!n1 || !n2) continue;
      const sim = nameSimilarity(n1,n2);
      if (sim >= 0.85 && last4(a.phone) && last4(a.phone)===last4(b.phone)) {
        out.push([a,b,'氏名類似 + 電話下4桁一致']);
      }
    }
  }

  function pushPairs(list, reason){
    for(let i=0;i<list.length;i++){
      for(let j=i+1;j<list.length;j++){
        out.push([list[i], list[j], reason]);
      }
    }
  }
  return out;
}
function nameSimilarity(a,b){ const dist = levenshtein(a,b); const maxLen = Math.max(a.length,b.length) || 1; return 1 - dist/maxLen; }
function levenshtein(a,b){
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, ()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function renderDupes(){
  const tb = qs('#dupesTbody'); tb.innerHTML='';
  for(const [a,b,why] of state.dupes){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(a.name||a.email||a.phone||'')}</td>
      <td>${esc(b.name||b.email||b.phone||'')}</td>
      <td>${esc(why)}</td>
    `;
    tb.appendChild(tr);
  }
  qs('#toggleDuplicates').disabled = state.dupes.length===0;
}
function showDupes(show){ qs('#dupesPanel').setAttribute('aria-hidden', show?'false':'true'); }

// ===== 保存済み条件 =====
function saveCurrentSegment(){
  const name = qs('#segmentName').value.trim();
  if(!name) return alert('保存名を入力してください。');
  const seg = {
    q: qs('#q').value, from: qs('#from').value, to: qs('#to').value,
    menu: qs('#menuFilter').value, tag: qs('#tagFilter').value,
    quick: qs('#quickSeg').value, follow: qs('#followOnly').checked,
    sort: qs('#sort').value
  };
  const key = 'crm_segments';
  const list = JSON.parse(localStorage.getItem(key) || '[]').filter(s=>s.name!==name);
  list.push({ name, seg });
  localStorage.setItem(key, JSON.stringify(list));
  loadSavedSegments();
  qs('#segmentName').value='';
  showToast('条件を保存しました', 'success');
}
function loadSavedSegments(){
  const key='crm_segments';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  const sel = qs('#savedSegments');
  sel.innerHTML = `<option value="">保存済み条件…</option>` + list.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join('');
}
function applySelectedSegment(){
  const key='crm_segments';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  const idx = Number(qs('#savedSegments').value);
  if (isNaN(idx) || list[idx]==null) return;
  const s = list[idx].seg;
  qs('#q').value = s.q||'';
  qs('#from').value = s.from||'';
  qs('#to').value = s.to||'';
  qs('#menuFilter').value = s.menu||'';
  qs('#tagFilter').value = s.tag||'';
  qs('#quickSeg').value = s.quick||'';
  qs('#followOnly').checked = !!s.follow;
  qs('#sort').value = s.sort||'lastReservation:desc';
  applyFilter();
  showToast('条件を適用しました', 'success');
}
function deleteSelectedSegment(){
  const key='crm_segments';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  const idx = Number(qs('#savedSegments').value);
  if (isNaN(idx) || list[idx]==null) return;
  const name = list[idx].name;
  if(!confirm(`「${name}」を削除しますか？`)) return;
  list.splice(idx,1);
  localStorage.setItem(key, JSON.stringify(list));
  loadSavedSegments();
  showToast('削除しました', 'success');
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
  showToast('CSVを書き出しました', 'success');
}

// ===== token表示（任意） =====
async function maybeHandleTokenView(){
  const p = new URLSearchParams(location.search); const token=p.get('token'); if(!token) return;
  qs('#tokenView').style.display='';
  try{
    const res=await fetch(`${GAS_WEBAPP_URL}?op=view&format=json&token=${encodeURIComponent(token)}`);
    qs('#tokenResult').textContent = JSON.stringify(await res.json(), null, 2);
  }catch(e){ qs('#tokenResult').textContent='読み込みに失敗しました。'; }
}

// ===== Column Visibility =====
function getColumnsMeta(){
  // 現在のヘッダーから列名を取得（9列想定だが動的対応）
  const ths = qsa('#customers thead th');
  return ths.map((th, i)=>({ index:i+1, label: th.textContent.trim() || `列${i+1}` }));
}
function applyColumnVisibility(){
  const cols = settings.cols;
  const meta = getColumnsMeta();
  const table = qs('#customers');
  if (!table) return;
  // まず既存 hide-col-* を外す
  for(let i=1;i<=meta.length;i++){ table.classList.remove(`hide-col-${i}`); }
  // 設定が空なら全部表示で終了
  if (!Array.isArray(cols) || cols.length===0) return;
  // false の列に hide クラスを当てる
  meta.forEach((m,idx)=>{
    const visible = cols[idx] !== false; // デフォルトtrue
    if (!visible) table.classList.add(`hide-col-${m.index}`);
  });
}
function openColumnMenuAt(x, y){
  let menu = document.getElementById('colmenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'colmenu';
    menu.setAttribute('role','dialog');
    menu.setAttribute('aria-label','列の表示/非表示');
    document.body.appendChild(menu);
  }
  const meta = getColumnsMeta();
  const cols = settings.cols;
  menu.innerHTML = '';
  meta.forEach((m, idx)=>{
    const row = document.createElement('label');
    row.className = 'row';
    const ck = document.createElement('input');
    ck.type='checkbox';
    const visible = cols[idx] !== false; // 未定義はtrue
    ck.checked = visible;
    ck.addEventListener('change', ()=>{
      const next = (Array.isArray(settings.cols) && settings.cols.slice(0, meta.length)) || new Array(meta.length).fill(true);
      next[idx] = ck.checked;
      settings.cols = next;
    });
    const span = document.createElement('span'); span.textContent = m.label;
    row.appendChild(ck); row.appendChild(span);
    menu.appendChild(row);
  });
  menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
  menu.style.top  = `${Math.min(y, window.innerHeight - 260)}px`;
  menu.hidden = false;

  const onDismiss = (ev)=>{
    if (ev.type==='keydown' && ev.key!=='Escape') return;
    menu.hidden = true;
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onDismiss);
  };
  const onDocClick = (ev)=>{ if (!menu.contains(ev.target)) onDismiss({type:'keydown', key:'Escape'}); };
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onDismiss);
}

// ===== Command Palette =====
function ensureKbar(){
  if (document.getElementById('kbar')) return;
  const wrap = document.createElement('div');
  wrap.id = 'kbar'; wrap.hidden = true;
  wrap.innerHTML = `
    <div class="kbar-card" role="dialog" aria-modal="true" aria-labelledby="kbarTitle">
      <div id="kbarTitle" style="position:absolute;left:-9999px;">コマンドパレット</div>
      <input class="kbar-input" type="search" placeholder="コマンドを検索（例：CSV、テーマ、列表示、モード、件数…）" />
      <div class="kbar-list" role="listbox"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const input = wrap.querySelector('.kbar-input');
  const list  = wrap.querySelector('.kbar-list');

  const commands = () => ([
    { title:'CSVをエクスポート', run: exportCsv },
    { title:'テーマ：ライトにする', run: ()=>{ settings.theme='light'; } },
    { title:'テーマ：ダークにする',  run: ()=>{ settings.theme='dark'; } },
    { title:'テーマ：システムに従う', run: ()=>{ settings.theme='system'; } },
    { title:'表示モード：自動', run: ()=>{ settings.view='auto'; selectViewRadio('auto'); } },
    { title:'表示モード：モバイル', run: ()=>{ settings.view='mobile'; selectViewRadio('mobile'); } },
    { title:'表示モード：PC', run: ()=>{ settings.view='desktop'; selectViewRadio('desktop'); } },
    { title:'表示件数：20', run: ()=>{ settings.per=20; } },
    { title:'表示件数：50', run: ()=>{ settings.per=50; } },
    { title:'表示件数：100', run: ()=>{ settings.per=100; } },
    { title:'列の表示/非表示…', run: ()=>{ const r = qs('#customers thead'); const rect = r.getBoundingClientRect(); openColumnMenuAt(rect.left + 12, rect.bottom + 6); } },
    { title:'クイック：新規のみ', run: ()=>{ qs('#quickSeg').value='new'; applyFilter(); } },
    { title:'クイック：常連のみ', run: ()=>{ qs('#quickSeg').value='loyal'; applyFilter(); } },
    { title:'クイック：休眠のみ', run: ()=>{ qs('#quickSeg').value='idle'; applyFilter(); } },
    { title:'クイック：解除',     run: ()=>{ qs('#quickSeg').value=''; applyFilter(); } },
    { title:'重複候補を表示', run: ()=> showDupes(true) },
    { title:'重複候補を閉じる', run: ()=> showDupes(false) },
    { title:'検索にフォーカス', run: ()=>{ qs('#q').focus(); } },
  ]);

  function open(){
    wrap.hidden = false;
    input.value = '';
    renderList('');
    setTimeout(()=>input.focus(), 0);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
  }
  function close(){
    wrap.hidden = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onClickOutside);
  }
  function onClickOutside(e){ if (e.target.closest('#kbar .kbar-card')) return; close(); }

  function renderList(query){
    const q = query.trim().toLowerCase();
    const items = commands().filter(c => !q || c.title.toLowerCase().includes(q));
    list.innerHTML = '';
    items.forEach((c,i)=>{
      const div = document.createElement('div');
      div.className = 'kbar-item';
      div.setAttribute('role','option');
      div.setAttribute('aria-selected', i===0 ? 'true' : 'false');
      div.innerHTML = `<span>${esc(c.title)}</span>`;
      div.addEventListener('mouseenter', ()=> selectIndex(i));
      div.addEventListener('click', ()=>{ c.run(); close(); });
      list.appendChild(div);
    });
    kbarIndex = 0;
  }

  let kbarIndex = 0;
  function selectIndex(i){
    const items = list.querySelectorAll('.kbar-item');
    if (items.length===0) return;
    kbarIndex = (i + items.length) % items.length;
    items.forEach((el,idx)=> el.setAttribute('aria-selected', idx===kbarIndex ? 'true' : 'false'));
    items[kbarIndex]?.scrollIntoView({block:'nearest'});
  }

  function onKey(e){
    if (e.key==='Escape'){ close(); return; }
    if (e.key==='ArrowDown'){ e.preventDefault(); selectIndex(kbarIndex+1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); selectIndex(kbarIndex-1); return; }
    if (e.key==='Enter'){
      const items = list.querySelectorAll('.kbar-item');
      const sel = items[kbarIndex];
      if (sel){ sel.click(); }
      return;
    }
  }

  input.addEventListener('input', ()=> renderList(input.value));
  wrap.openKbar = open;
  wrap.closeKbar = close;
}
function openKbar(){ ensureKbar(); document.getElementById('kbar').openKbar(); }

// ===== Keyboard Navigation (table rows) =====
function getRenderedRowEls(){
  return qsa('#customers tbody tr');
}
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
function selectViewRadio(v){
  const r = document.querySelector(`.view-toggle input[value="${v}"]`);
  if (r) r.checked = true;
}

// ===== Events =====
function attach(){
  // 入力 → デバウンス
  ['#q','#from','#to','#menuFilter','#tagFilter','#quickSeg','#followOnly'].forEach(sel=>{
    const el = qs(sel);
    el.addEventListener('input', applyFilterDebounced);
    el.addEventListener('change', applyFilter);
  });
  // ソート
  qs('#sort').addEventListener('change', ()=>{
    applySort();
  });

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
    });
  });
  // 初期ビュー復元
  document.body.classList.remove('view-auto','view-mobile','view-desktop');
  document.body.classList.add('view-'+settings.view);
  selectViewRadio(settings.view);

  // セグメント
  qs('#saveSegment').addEventListener('click', saveCurrentSegment);
  qs('#applySegment').addEventListener('click', applySelectedSegment);
  qs('#deleteSegment').addEventListener('click', deleteSelectedSegment);
  loadSavedSegments();

  // 重複候補
  qs('#toggleDuplicates').addEventListener('click', ()=>showDupes(true));
  qs('#dupesPanel .close').addEventListener('click', ()=>showDupes(false));
  qs('#dupesPanel').addEventListener('click', (e)=>{ if(e.target.id==='dupesPanel') showDupes(false); });

  // テーマ適用（初回）
  if (settings.theme !== 'system') applyTheme();

  // コマンドパレット
  ensureKbar();

  // テーブルヘッダーの右クリックで列メニュー
  const thead = qs('#customers thead');
  thead.addEventListener('contextmenu', (e)=>{ e.preventDefault(); openColumnMenuAt(e.clientX, e.clientY); });

  // キーボードショートカット
  document.addEventListener('keydown', (e)=>{
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag==='input' || tag==='textarea' || e.target.isContentEditable;

    // / で検索フォーカス（入力中は無効）
    if (!typing && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      qs('#q').focus();
      return;
    }
    // ⌘/Ctrl + K = コマンドパレット
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); openKbar(); return;
    }
    // Alt + T = テーマトグル
    if (e.key.toLowerCase() === 't' && e.altKey) {
      e.preventDefault(); toggleThemeQuick(); return;
    }
    // 行選択（表）
    if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveFocus(e.key==='ArrowDown' ? 1 : -1);
      return;
    }
    if (!typing && e.key === 'Enter') {
      openFocused();
      return;
    }
    // ESC で各種モーダル類を閉じる（優先度：KBar → 重複 → ドロワー）
    if (e.key === 'Escape') {
      const kbar = document.getElementById('kbar');
      if (kbar && !kbar.hidden){ kbar.closeKbar(); return; }
      const dupesOpen = qs('#dupesPanel')?.getAttribute('aria-hidden')==='false';
      if (dupesOpen){ showDupes(false); return; }
      const drawerOpen = qs('#drawer')?.getAttribute('aria-hidden')==='false';
      if (drawerOpen){ closeDrawer(); return; }
    }
  });
}

// ===== Init =====
(async function init(){
  try {
    ensureToastHost();
    setGlobalLoading(true, 'データを読み込んでいます…');
    attach();
    wireLoadingRetry();
    await maybeHandleTokenView();
    await loadData();
    setGlobalLoading(false);
  } catch(e){
    console.error(e);
    showLoadError('読み込みに失敗しました。［再読み込み］を押してください。');
  }
})();
