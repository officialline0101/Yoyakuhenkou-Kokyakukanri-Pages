// ▼▼ 設定（差し替え） ▼▼
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzdA1IjGbRtqNhbgTfFkeeuTlCKQ_AqJ6OUbVnnLlFuicIh7cEUOurTmYQUVlby5aka/exec';
const SECURITY_SECRET = '9f3a7c1e5b2d48a0c6e1f4d9b3a8c2e7d5f0a1b6c3d8e2f7a9b0c4e6d1f3a5b7';

const state = {
  customers: [],
  reservations: [],
  filtered: [],
  page: 1,
  perPage: 20,
  sortKey: 'lastReservation',
  sortDir: 'desc',
  selectedCustomerKey: null,
  distinctMenus: []
};

const qs = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const fmt = iso => {
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return iso;
  const z=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}/${z(d.getMonth()+1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};
const keyOf = r => (r.email || r.phone || r.name || '').toLowerCase().trim();

async function fetchJson(url){
  const res = await fetch(url, { method:'GET' });
  const j = await res.json().catch(()=>null);
  if(!res.ok || !j || !j.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.data || [];
}

async function loadData(){
  const base = GAS_WEBAPP_URL;
  const [customers, reservations] = await Promise.all([
    fetchJson(`${base}?resource=customers&secret=${encodeURIComponent(SECURITY_SECRET)}`),
    fetchJson(`${base}?resource=reservations&secret=${encodeURIComponent(SECURITY_SECRET)}`)
  ]);
  state.customers = customers;
  state.reservations = reservations;

  // メニュー候補生成
  const menus = [...new Set(reservations.map(r => r.menu).filter(Boolean))].sort();
  state.distinctMenus = menus;
  qs('#menuFilter').innerHTML =
    `<option value="">メニュー：すべて</option>` + menus.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');

  applyFilter();
}

function applyFilter(){
  const q = qs('#q').value.trim().toLowerCase();
  const from = qs('#from').value ? new Date(qs('#from').value) : null;
  const to   = qs('#to').value   ? new Date(qs('#to').value)   : null;
  if (to) to.setHours(23,59,59,999);
  const menu = qs('#menuFilter').value;
  const tagQ = qs('#tagFilter').value.trim().toLowerCase();

  let arr = state.customers.filter(c =>
    !q || [c.name,c.email,c.phone].some(v => (v||'').toLowerCase().includes(q))
  );

  if (tagQ) {
    arr = arr.filter(c => (c.tags || []).some(t => t.toLowerCase().includes(tagQ)));
  }

  // 期間とメニューは予約履歴から判断
  if (from || to || menu) {
    const match = (cust) => {
      const k = keyOf(cust);
      return state.reservations.some(r => {
        if (keyOf(r) !== k) return false;
        const d = r.start ? new Date(r.start) : null;
        if (from && (!d || d < from)) return false;
        if (to && (!d || d > to)) return false;
        if (menu && r.menu !== menu) return false;
        return true;
      });
    };
    arr = arr.filter(match);
  }

  state.filtered = arr;
  applySort();
}

function applySort(){
  const [key,dir] = qs('#sort').value.split(':');
  state.sortKey = key; state.sortDir = dir;
  const m = dir === 'asc' ? 1 : -1;
  state.filtered.sort((a,b)=>{
    const va=a[key]??'', vb=b[key]??'';
    if (typeof va==='number' && typeof vb==='number') return (va - vb)*m;
    return String(va).localeCompare(String(vb))*m;
  });
  state.page = 1;
  render();
}

function render(){
  renderTable();
  renderCards();
  renderPager();
}

function renderTable(){
  const tb = qs('#customers tbody'); tb.innerHTML = '';
  const start = (state.page-1)*state.perPage;
  const rows = state.filtered.slice(start, start+state.perPage);

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.phone)}</td>
      <td>${fmt(r.lastReservation)}</td>
      <td>${r.totalReservations ?? 0}</td>
      <td>${esc(r.lastMenu || r.lastItems || '')}</td>
      <td>${esc(r.staff || '')}</td>
      <td>${(r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ')}</td>
    `;
    tr.addEventListener('click', ()=>openDrawer(r));
    tb.appendChild(tr);
  }
}

function renderCards(){
  const wrap = qs('#cardsSection'); wrap.innerHTML = '';
  const start = (state.page-1)*state.perPage;
  const rows = state.filtered.slice(start, start+state.perPage);

  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="name">${esc(r.name || r.email || r.phone || '')}</div>
      <div class="meta">最終来店：${fmt(r.lastReservation)} / 回数：${r.totalReservations ?? 0}</div>
      <div>直近メニュー：${esc(r.lastMenu || r.lastItems || '')}</div>
      <div>担当者：${esc(r.staff || '-')}</div>
      <div class="tags">${(r.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join(' ')}</div>
    `;
    div.addEventListener('click', ()=>openDrawer(r));
    wrap.appendChild(div);
  }
}

function renderPager(){
  const pager = qs('#pager');
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.perPage));
  pager.innerHTML = '';

  const mk=(t,fn)=>{ const b=document.createElement('button'); b.textContent=t; b.onclick=fn; return b; };
  pager.appendChild(mk('«',()=>{state.page=1; render();}));
  pager.appendChild(mk('‹',()=>{state.page=Math.max(1,state.page-1); render();}));
  pager.appendChild(document.createTextNode(` ${state.page}/${pages} `));
  pager.appendChild(mk('›',()=>{state.page=Math.min(pages,state.page+1); render();}));
  pager.appendChild(mk('»',()=>{state.page=pages; render();}));
}

function openDrawer(customer){
  const k = keyOf(customer); state.selectedCustomerKey = k;

  // 履歴（新しい順）
  const hist = state.reservations
    .filter(r => keyOf(r) === k)
    .sort((a,b)=> String(b.start||'').localeCompare(String(a.start||'')));

  const tb = qs('#history tbody'); tb.innerHTML = '';
  for (const h of hist) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmt(h.start)}</td><td>${esc(h.menu)}</td><td>${esc(h.items || h.opts || '')}</td><td>${esc(h.status || '')}</td>`;
    tb.appendChild(tr);
  }

  // プロファイル反映
  qs('#drawerTitle').textContent = `顧客プロファイル：${customer.name || customer.email || customer.phone || ''}`;
  qs('#editName').value = customer.name || '';
  qs('#editKana').value = customer.kana || '';
  qs('#editGender').value = customer.gender || '';
  qs('#editPhone').value = customer.phone || '';
  qs('#editEmail').value = customer.email || '';
  qs('#editAddress').value = customer.address || '';
  qs('#editBirthdate').value = (customer.birthdate||'').slice(0,10);
  qs('#editStaff').value = customer.staff || '';
  qs('#editTags').value = (customer.tags || []).join(', ');
  qs('#editMemo').value = customer.memo || '';
  qs('#editFirst').value = fmt(customer.firstReservation) || '';
  qs('#editLast').value  = fmt(customer.lastReservation)  || '';
  qs('#saveStatus').textContent = '';

  const drawer = qs('#drawer');
  drawer.setAttribute('aria-hidden','false');
  drawer.addEventListener('click', (e)=>{ if(e.target===drawer) closeDrawer(); }, { once:true });
  qs('#drawer .close').onclick = closeDrawer;
}

function closeDrawer(){
  qs('#drawer').setAttribute('aria-hidden','true');
}

async function saveNote(){
  const key = state.selectedCustomerKey; if(!key) return;

  const body = {
    action: 'upsertNote',
    secret: SECURITY_SECRET,
    key,
    name: qs('#editName').value.trim(),
    kana: qs('#editKana').value.trim(),
    gender: qs('#editGender').value,
    phone: qs('#editPhone').value.trim(),
    email: qs('#editEmail').value.trim(),
    address: qs('#editAddress').value.trim(),
    birthdate: qs('#editBirthdate').value, // YYYY-MM-DD
    staff: qs('#editStaff').value.trim(),
    tags: qs('#editTags').value.split(',').map(s=>s.trim()).filter(Boolean),
    memo: qs('#editMemo').value
  };

  qs('#saveNote').disabled = true;
  qs('#saveStatus').textContent = '保存中…';

  try{
    const res = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    if(!res.ok || !j || j.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);

    qs('#saveStatus').textContent = '保存しました。';
    // 一覧を更新（プロファイル反映）
    const keepKey = state.selectedCustomerKey;
    await loadData();
    // 同じ顧客を再オープン（任意）
    const again = state.customers.find(c => keyOf(c) === keepKey);
    if (again) openDrawer(again);
  }catch(e){
    console.error(e);
    qs('#saveStatus').textContent = '保存に失敗しました。';
  }finally{
    qs('#saveNote').disabled = false;
  }
}

// 予約メール token 表示（任意）
async function maybeHandleTokenView(){
  const p = new URLSearchParams(location.search);
  const token = p.get('token'); if(!token) return;
  qs('#tokenView').style.display = '';
  try{
    const res = await fetch(`${GAS_WEBAPP_URL}?op=view&format=json&token=${encodeURIComponent(token)}`);
    qs('#tokenResult').textContent = JSON.stringify(await res.json(), null, 2);
  }catch(e){
    qs('#tokenResult').textContent = '読み込みに失敗しました。';
  }
}

function attach(){
  ['#q','#from','#to','#menuFilter','#tagFilter'].forEach(sel=>{
    qs(sel).addEventListener('input', applyFilter);
    qs(sel).addEventListener('change', applyFilter);
  });
  qs('#sort').addEventListener('change', applySort);
  qs('#reload').addEventListener('click', loadData);
  qs('#exportCsv').addEventListener('click', exportCsv);
  qs('#saveNote').addEventListener('click', saveNote);

  // 表示切替（auto / mobile / desktop）
  document.querySelectorAll('input[name="view"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      document.body.classList.remove('view-auto','view-mobile','view-desktop');
      document.body.classList.add('view-'+r.value);
    });
  });
}

function exportCsv(){
  const headers = [
    '氏名','氏名（カナ）','性別','電話','メール','住所','生年月日',
    '初回予約日','最終予約日','回数','直近メニュー','担当者','タグ','メモ'
  ];
  const rows = state.filtered.map(r=>[
    r.name||'', r.kana||'', r.gender||'', r.phone||'', r.email||'', r.address||'', (r.birthdate||'').slice(0,10),
    fmt(r.firstReservation), fmt(r.lastReservation),
    r.totalReservations??0, r.lastMenu||r.lastItems||'', r.staff||'',
    (r.tags||[]).join(' '), r.memo||''
  ]);

  const csv = [headers,...rows]
    .map(line=>line.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v)).join(','))
    .join('\n');

  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = `customers_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

(async function init(){
  attach();
  await maybeHandleTokenView();
  try {
    await loadData();
  } catch(e){
    alert('データ取得に失敗しました。\n' + e);
    console.error(e);
  }
})();
