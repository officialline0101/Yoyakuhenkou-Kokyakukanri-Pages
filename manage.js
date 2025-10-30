// ▼▼ 設定：あなたの GAS Web アプリ URL / シークレット ▼▼
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzdA1IjGbRtqNhbgTfFkeeuTlCKQ_AqJ6OUbVnnLlFuicIh7cEUOurTmYQUVlby5aka/exec';
const SECURITY_SECRET = '9f3a7c1e5b2d48a0c6e1f4d9b3a8c2e7d5f0a1b6c3d8e2f7a9b0c4e6d1f3a5b7';

// ▼▼ オートセグメント しきい値 ▼▼
const FOLLOWUP_THRESHOLD_DAYS = 90;
const LOYAL_MIN_VISITS = 5;
const NEW_THRESHOLD_DAYS = 30;
const TICKET_EXPIRY_SOON_DAYS = 30;

const state = {
  customers: [],
  reservations: [],
  filtered: [],
  page: 1, perPage: 20,
  sortKey: 'lastReservation', sortDir: 'desc',
  selectedCustomerKey: null,
  distinctMenus: [],
  dupes: []
};

const qs = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const keyOf = r => (r.email || r.phone || r.name || '').toLowerCase().trim();
const toBool = v => String(v).toLowerCase()==='true' || v===true || v==='1' || v===1;

function z(n){ return String(n).padStart(2,'0'); }
function fmtIso(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return String(iso);
  return `${d.getFullYear()}/${z(d.getMonth()+1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function toLocalDTValue(iso){
  if(!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
function toIsoTokyo(dtLocal){ // "YYYY-MM-DDTHH:mm" → +09:00
  return `${dtLocal}:00+09:00`;
}

// GASからの display 文字列（例: "2025/10/30 (木) 10:00" など）を頑健にパース
function parseAnyDate(s){
  if(!s) return null;
  if (s instanceof Date) return isNaN(s) ? null : s;
  const t = String(s).trim();
  // ISO風
  const d1 = new Date(t); if (!isNaN(d1)) return d1;
  // yyyy/MM/dd HH:mm, yyyy/MM/dd (E) HH:mm
  const m = t.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s*\(.+?\))?\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const [,y,mo,da,hh,mm] = m.map(Number);
    return new Date(y, mo-1, da, hh, mm, 0);
  }
  // yyyy/MM/dd
  const m2 = t.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m2) {
    const [,y,mo,da] = m2.map(Number);
    return new Date(y, mo-1, da, 0, 0, 0);
  }
  return null;
}
function toIso(d){ return d ? new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().replace('.000Z','+00:00') : ''; }

// ===== API =====
async function fetchJson(url){
  const res = await fetch(url, { method:'GET' });
  const j = await res.json().catch(()=>null);
  if(!res.ok || !j || !j.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.data || [];
}
async function loadData(){
  const base = GAS_WEBAPP_URL;
  const [customersRaw, reservationsRaw] = await Promise.all([
    fetchJson(`${base}?resource=customers&secret=${encodeURIComponent(SECURITY_SECRET)}`),
    fetchJson(`${base}?resource=reservations&secret=${encodeURIComponent(SECURITY_SECRET)}`)
  ]);

  // 予約を正規化
  state.reservations = (reservationsRaw || []).map(r=>{
    const startD = parseAnyDate(r.start);
    const endD   = parseAnyDate(r.end);
    return {
      ...r,
      key: keyOf(r),
      startIso: startD ? `${startD.getFullYear()}-${z(startD.getMonth()+1)}-${z(startD.getDate())}T${z(startD.getHours())}:${z(startD.getMinutes())}:00+09:00` : '',
      endIso:   endD   ? `${endD.getFullYear()}-${z(endD.getMonth()+1)}-${z(endD.getDate())}T${z(endD.getHours())}:${z(endD.getMinutes())}:00+09:00` : '',
      startMs: startD ? startD.getTime() : NaN,
      endMs:   endD   ? endD.getTime()   : NaN,
      memo: r.memo || '' // （GASが返していない場合は空）
    };
  });

  // 顧客を正規化＆オートセグ
  const now = Date.now();
  state.customers = (customersRaw || []).map(c=>{
    const f = parseAnyDate(c.firstReservation); const l = parseAnyDate(c.lastReservation);
    const hasUpcoming = state.reservations.some(r => r.key===keyOf(c) && r.startMs > now);
    const lastMs = l ? l.getTime() : NaN;
    const days = isNaN(lastMs) ? null : Math.floor((now - lastMs)/86400000);

    const auto = [];
    if ((c.totalReservations||0) === 1 && l && (now - lastMs)/86400000 <= NEW_THRESHOLD_DAYS) auto.push({k:'new', label:'新規'});
    if ((c.totalReservations||0) >= LOYAL_MIN_VISITS && l && (now - lastMs)/86400000 <= FOLLOWUP_THRESHOLD_DAYS) auto.push({k:'loyal', label:'常連'});
    if (days!=null && days >= FOLLOWUP_THRESHOLD_DAYS) auto.push({k:'idle', label:'休眠'});
    if (c.ticketExpiry){
      const exp = parseAnyDate(c.ticketExpiry);
      if (exp && exp.getTime() - now > 0 && exp.getTime() - now <= TICKET_EXPIRY_SOON_DAYS*86400000){
        auto.push({k:'ticket', label:'回数券期限近'});
      }
    }

    return {
      ...c,
      firstReservationIso: f ? f.toISOString() : '',
      lastReservationIso: l ? l.toISOString() : '',
      firstReservation: f ? f.toISOString() : c.firstReservation,
      lastReservation:  l ? l.toISOString() : c.lastReservation,
      latestPast: !hasUpcoming && !!l && (l.getTime() <= now),
      daysSinceLast: days,
      _auto: auto,
      _idleDays: days
    };
  });

  // メニュー一覧
  state.distinctMenus = [...new Set(state.reservations.map(r => r.menu).filter(Boolean))].sort();
  qs('#menuFilter').innerHTML =
    `<option value="">メニュー：すべて</option>` + state.distinctMenus.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');

  // 重複候補
  state.dupes = findDuplicates(state.customers);
  renderDupes();

  applyFilter();
}
async function postJson(body){
  const res = await fetch(GAS_WEBAPP_URL, {
    method:'POST',
    headers:{ 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: SECURITY_SECRET, ...body })
  });
  const txt = await res.text();
  let j=null; try{ j=JSON.parse(txt); }catch(_){}
  if(!res.ok || !j || j.ok===false) throw new Error(j?.error || `HTTP ${res.status}`);
  return j;
}

// ===== フィルタ & ソート =====
function applyFilter(){
  const q = qs('#q').value.trim().toLowerCase();
  const from = qs('#from').value ? new Date(qs('#from').value) : null;
  const to   = qs('#to').value   ? new Date(qs('#to').value)   : null; if (to) to.setHours(23,59,59,999);
  const menu = qs('#menuFilter').value;
  const tagQ = qs('#tagFilter').value.trim().toLowerCase();
  const quick = qs('#quickSeg').value;
  const followOnly = qs('#followOnly').checked;

  let arr = state.customers.filter(c =>
    !q || [c.name,c.email,c.phone].some(v => (v||'').toLowerCase().includes(q))
  );

  if (tagQ) arr = arr.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(tagQ)));

  if (from || to || menu) {
    const match = (cust) => {
      const k = keyOf(cust);
      return state.reservations.some(r => {
        if (r.key !== k) return false;
        const d = r.startMs ? new Date(r.startMs) : null;
        if (from && (!d || d < from)) return false;
        if (to && (!d || d > to)) return false;
        if (menu && r.menu !== menu) return false;
        return true;
      });
    };
    arr = arr.filter(match);
  }

  if (quick === 'new') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='new'));
  if (quick === 'loyal') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='loyal'));
  if (quick === 'idle') arr = arr.filter(c => (c._auto||[]).some(a => a.k==='idle'));

  if (followOnly) arr = arr.filter(c => c.latestPast || (c._auto||[]).some(a => a.k==='ticket'));

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
  state.page=1;
  render();
}

// ===== 描画 =====
function render(){ renderTable(); renderCards(); renderPager(); }
function makeContactCell(r){
  const phone = esc(r.phone||''); const mail = esc(r.email||'');
  const items = [];
  if (phone) items.push(`<a href="tel:${phone}">📞 ${phone}</a>`);
  if (mail) items.push(`<a href="mailto:${mail}">✉️ ${mail}</a>`);
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
  const start=(state.page-1)*state.perPage, rows=state.filtered.slice(start, start+state.perPage);

  for(const r of rows){
    const tr=document.createElement('tr');

    // バッジ
    const autoHtml = (r._auto||[]).map(a=>{
      const cls = a.k==='idle'?'badge idle':(a.k==='loyal'?'badge loyal':(a.k==='new'?'badge new':'badge'));
      return `<span class="${cls}">${esc(a.label)}</span>`;
    }).join(' ');
    const followBadge = r.latestPast ? `<span class="badge follow">最新予約は過去（経過${r.daysSinceLast ?? '-'}日）</span>` : '';

    tr.innerHTML = `
      <td>${esc(r.name || '')} ${followBadge}</td>
      <td>${makeContactCell(r)}</td>
      <td>${esc(r.address||'')}</td>
      <td>${fmtIso(r.lastReservation)}</td>
      <td>${r.totalReservations ?? 0}</td>
      <td>${esc(r.lastMenu || r.lastItems || '')}</td>
      <td>${esc(r.staff || '')}</td>
      <td><div class="tags">${(r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ')} ${autoHtml}</div></td>
      <td class="cell-actions">${makeActionLinks(r)}</td>
    `;
    tr.addEventListener('click', (e)=>{ if (e.target.tagName !== 'A') openDrawer(r); });
    tb.appendChild(tr);
  }
}

function renderCards(){
  const wrap = qs('#cardsSection'); wrap.innerHTML='';
  const start=(state.page-1)*state.perPage, rows=state.filtered.slice(start, start+state.perPage);

  for(const r of rows){
    const div=document.createElement('div'); div.className='card';
    const autoHtml = (r._auto||[]).map(a=>{
      const cls = a.k==='idle'?'badge idle':(a.k==='loyal'?'badge loyal':(a.k==='new'?'badge new':'badge'));
      return `<span class="${cls}">${esc(a.label)}</span>`;
    }).join(' ');
    const followBadge = r.latestPast ? `<span class="badge follow">最新予約は過去（経過${r.daysSinceLast ?? '-'}日）</span>` : '';

    div.innerHTML = `
      <div class="name">${esc(r.name || r.email || r.phone || '')}</div>
      <div class="meta">最終来店：${fmtIso(r.lastReservation)} / 回数：${r.totalReservations ?? 0}</div>
      <div>${followBadge}</div>
      <div>直近メニュー：${esc(r.lastMenu || r.lastItems || '')}</div>
      <div>担当者：${esc(r.staff || '-')}</div>
      <div class="tags">${(r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ')} ${autoHtml}</div>
      <div style="margin-top:8px">${makeActionLinks(r)}</div>
    `;
    div.addEventListener('click', (e)=>{ if (e.target.tagName !== 'A') openDrawer(r); });
    wrap.appendChild(div);
  }
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

// ===== ドロワー（プロファイル & 履歴 + メモ/リスケ） =====
function openDrawer(customer){
  const k = keyOf(customer); state.selectedCustomerKey = k;

  // 履歴（予約）を最新順
  const hist = state.reservations
    .filter(r => r.key===k)
    .sort((a,b)=> (b.startMs||0) - (a.startMs||0));

  const tb = qs('#history tbody'); tb.innerHTML='';
  const now = Date.now();

  for(const h of hist){
    const isFuture = h.startMs > now;
    const tr=document.createElement('tr');
    tr.dataset.resvId = h.resvId || '';
    tr.innerHTML = `
      <td>${fmtIso(h.startIso)}</td>
      <td>${esc(h.menu||'')}</td>
      <td>${esc(h.items||h.opts||'')}</td>
      <td>${esc(h.status||'')}</td>
      <td>
        <textarea data-memo rows="2" placeholder="予約ごとのメモ（来店時の注意など）">${esc(h.memo||'')}</textarea>
        <div><button data-save-memo>メモ保存</button></div>
      </td>
      <td>
        ${isFuture ? `
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap">
            <input type="datetime-local" data-dt value="${toLocalDTValue(h.startIso)}">
            <button data-reschedule>日付変更</button>
          </div>
        ` : `<span class="badge">過去予約</span>`}
      </td>
    `;
    tb.appendChild(tr);
  }

  // タイトル / クイックアクション
  const titleName = customer.name || customer.email || customer.phone || '';
  qs('#drawerTitle').textContent = `顧客プロファイル：${titleName}`;
  qs('#quickActions').innerHTML = [
    customer.phone ? `<a href="tel:${esc(customer.phone)}">📞 電話</a>` : '',
    customer.email ? `<a href="mailto:${esc(customer.email)}">✉️ メール</a>` : '',
    customer.address ? `<a href="https://maps.google.com/?q=${encodeURIComponent(customer.address)}" target="_blank">🗺️ 地図</a>` : ''
  ].filter(Boolean).join('');

  // 編集フォーム
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
  setVal('#editFirst', fmtIso(customer.firstReservation));
  setVal('#editLast', fmtIso(customer.lastReservation));
  qs('#saveStatus').textContent = '';

  // メモ保存 / リスケ操作（イベント委譲）
  tb.addEventListener('click', async (e)=>{
    const tr = e.target.closest('tr'); if(!tr) return;
    const resvId = tr.dataset.resvId;
    if (e.target.matches('[data-save-memo]')) {
      const memo = tr.querySelector('[data-memo]').value;
      e.target.disabled = true; e.target.textContent='保存中…';
      try{
        await postJson({ action:'upsertResvMemo', resvId, memo });
        const row = state.reservations.find(x => x.resvId===resvId); if (row) row.memo = memo;
        e.target.textContent='保存しました';
        setTimeout(()=>{ e.target.textContent='メモ保存'; e.target.disabled=false; }, 800);
      }catch(err){
        console.error(err); alert('メモ保存に失敗：' + err.message); e.target.disabled=false; e.target.textContent='メモ保存';
      }
    }
    if (e.target.matches('[data-reschedule]')) {
      const input = tr.querySelector('[data-dt]');
      const dt = input?.value;
      if(!dt) return alert('日時を入力してください');
      e.target.disabled = true; e.target.textContent='変更中…';
      try{
        await postJson({ action:'rescheduleById', resvId, newStartIso: toIsoTokyo(dt) });
        await loadData(); // 反映
        // 再度同じ顧客で開き直す
        const again = state.customers.find(c => keyOf(c)===state.selectedCustomerKey);
        if (again) openDrawer(again);
      }catch(err){
        console.error(err); alert('日付変更に失敗：' + err.message);
      }finally{
        e.target.disabled=false; e.target.textContent='日付変更';
      }
    }
  }, { once:false });

  const drawer=qs('#drawer'); drawer.setAttribute('aria-hidden','false');
  drawer.addEventListener('click',(e)=>{ if(e.target===drawer) closeDrawer(); },{once:true});
  qs('#drawer .close').onclick = closeDrawer;
}
function setVal(sel, v){ const el=qs(sel); if(el) el.value = v ?? ''; }
function setChecked(sel, v){ const el=qs(sel); if(el) el.checked = !!v; }
function closeDrawer(){ qs('#drawer').setAttribute('aria-hidden','true'); }

async function saveNote(){
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

  const btn = qs('#saveNote'); const status = qs('#saveStatus');
  btn.disabled = true; status.textContent = '保存中…';
  try{
    await postJson(body);
    status.textContent = '保存しました。';
    const keepKey = state.selectedCustomerKey;
    await loadData();
    const again = state.customers.find(c => keyOf(c) === keepKey);
    if (again) openDrawer(again);
  }catch(e){
    console.error(e); status.textContent = '保存に失敗しました。';
  }finally{
    btn.disabled = false;
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

  for(const [_,arr] of byEmail) if (arr.length>1) pushPairs(arr, '同一メール');
  for(const [_,arr] of byPhone) if (arr.length>1) pushPairs(arr, '同一電話');

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
function nameSimilarity(a,b){
  const dist = levenshtein(a,b);
  const maxLen = Math.max(a.length,b.length) || 1;
  return 1 - dist/maxLen;
}
function levenshtein(a,b){
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, (_,i)=>Array(n+1).fill(0));
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
    tr.innerHTML = `<td>${esc(a.name||a.email||a.phone||'')}</td><td>${esc(b.name||b.email||b.phone||'')}</td><td>${esc(why)}</td>`;
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
}

// ===== CSV =====
function exportCsv(){
  const headers = [
    '氏名','氏名（カナ）','性別','電話','メール','住所','生年月日',
    '初回予約日','最終予約日','回数','直近メニュー','担当者',
    'タグ','メモ','注意事項','配信同意(メール)','配信同意(LINE)','同意日',
    '紹介者','紹介コード','回数券','残回数','券期限','自動セグメント','最新予約過去','経過日数'
  ];
  const rows = state.filtered.map(r=>{
    const auto = (r._auto||[]).map(a=>a.label).join(' ');
    return [
      r.name||'', r.kana||'', r.gender||'', r.phone||'', r.email||'', r.address||'', (r.birthdate||'').slice(0,10),
      fmtIso(r.firstReservation), fmtIso(r.lastReservation),
      r.totalReservations??0, r.lastMenu||r.lastItems||'', r.staff||'',
      (r.tags||[]).join(' '), r.memo||'', r.attention||'',
      toBool(r.optInEmail)?'TRUE':'FALSE', toBool(r.optInLine)?'TRUE':'FALSE', (r.consentDate||'').slice(0,10),
      r.referredBy||'', r.referralCode||'', r.ticketType||'', r.ticketRemaining||'', (r.ticketExpiry||'').slice(0,10),
      auto, r.latestPast ? 'TRUE' : 'FALSE', r.daysSinceLast ?? ''
    ];
  });

  const csv = [headers,...rows].map(line=>line.map(v=>(/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v)).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a=document.createElement('a'); a.href=url; a.download=`customers_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
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

// ===== イベント付与 =====
function attach(){
  ['#q','#from','#to','#menuFilter','#tagFilter','#quickSeg','#followOnly'].forEach(sel=>{
    qs(sel).addEventListener('input', applyFilter);
    qs(sel).addEventListener('change', applyFilter);
  });
  qs('#sort').addEventListener('change', applySort);
  qs('#reload').addEventListener('click', loadData);
  qs('#exportCsv').addEventListener('click', exportCsv);
  qs('#saveNote').addEventListener('click', saveNote);

  document.querySelectorAll('input[name="view"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      document.body.classList.remove('view-auto','view-mobile','view-desktop');
      document.body.classList.add('view-'+r.value);
    });
  });

  qs('#saveSegment').addEventListener('click', saveCurrentSegment);
  qs('#applySegment').addEventListener('click', applySelectedSegment);
  qs('#deleteSegment').addEventListener('click', deleteSelectedSegment);
  loadSavedSegments();

  qs('#toggleDuplicates').addEventListener('click', ()=>showDupes(true));
  qs('#dupesPanel .close').addEventListener('click', ()=>showDupes(false));
  qs('#dupesPanel').addEventListener('click', (e)=>{ if(e.target.id==='dupesPanel') showDupes(false); });
}

// ===== 起動 =====
(async function init(){
  attach();
  await maybeHandleTokenView();
  try { await loadData(); } catch(e){ alert('データ取得に失敗しました。\n'+e); console.error(e); }
})();
