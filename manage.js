// ▼▼ 設定（ここだけ差し替え） ▼▼
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbz6pK8BoiP23d8SXDYt87eFEliFvcoq3w5udqpHMkFUFYyWaQ4yGNiumXbjiHtG7Ex9/exec';
const SECURITY_SECRET = '9f3a7c1e5b2d48a0c6e1f4d9b3a8c2e7d5f0a1b6c3d8e2f7a9b0c4e6d1f3a5b7';

const state = {
  customers: [],
  reservations: [],
  filtered: [],
  page: 1,
  perPage: 20,
  sortKey: 'lastReservation',
  sortDir: 'desc'
};

function qs(sel){ return document.querySelector(sel); }
function esc(s){ return String(s ?? '').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function fmt(iso){ if(!iso) return ''; const d=new Date(iso); if(isNaN(d)) return iso; const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}/${z(d.getMonth()+1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; }

async function fetchJson(url){
  const res = await fetch(url, { method:'GET' });
  const j = await res.json().catch(()=>null);
  if(!res.ok || !j || !j.ok) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.data || [];
}

async function loadData() {
  const base = `${GAS_WEBAPP_URL}`;
  const [customers, reservations] = await Promise.all([
    fetchJson(`${base}?resource=customers&secret=${encodeURIComponent(SECURITY_SECRET)}`),
    fetchJson(`${base}?resource=reservations&secret=${encodeURIComponent(SECURITY_SECRET)}`)
  ]);
  state.customers = customers;
  state.reservations = reservations;
  applyFilter();
}

function applyFilter(){
  const q = qs('#q').value.trim().toLowerCase();
  state.filtered = !q ? [...state.customers] : state.customers.filter(c =>
    [c.name,c.email,c.phone].some(v => (v||'').toLowerCase().includes(q))
  );
  applySort();
}

function applySort(){
  const sel = qs('#sort').value; // e.g., "lastReservation:desc"
  const [key, dir] = sel.split(':'); state.sortKey = key; state.sortDir = dir;
  const m = state.sortDir === 'asc' ? 1 : -1;
  state.filtered.sort((a,b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * m);
  state.page = 1;
  renderTable();
}

function renderTable(){
  const tb = qs('#customers tbody');
  tb.innerHTML = '';
  const start = (state.page-1)*state.perPage;
  const rows = state.filtered.slice(start, start+state.perPage);

  for(const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td>${esc(r.phone)}</td>
      <td>${fmt(r.lastReservation)}</td>
      <td>${r.totalReservations ?? 0}</td>
      <td>${esc(r.lastMenu || r.lastItems || '')}</td>
    `;
    tr.addEventListener('click', ()=>openHistoryDrawer(r));
    tb.appendChild(tr);
  }
  renderPager();
}

function renderPager(){
  const pager = qs('#pager');
  const total = state.filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.perPage));
  pager.innerHTML = '';
  const mk = (t,fn)=>{ const b=document.createElement('button'); b.textContent=t; b.onclick=fn; return b; };
  pager.appendChild(mk('«',()=>{state.page=1;renderTable();}));
  pager.appendChild(mk('‹',()=>{state.page=Math.max(1,state.page-1);renderTable();}));
  pager.appendChild(document.createTextNode(` ${state.page}/${pages} `));
  pager.appendChild(mk('›',()=>{state.page=Math.min(pages,state.page+1);renderTable();}));
  pager.appendChild(mk('»',()=>{state.page=pages;renderTable();}));
}

function exportCsv(){
  const headers = ['お名前','メール','電話','最初の来店','最終来店','回数','直近メニュー'];
  const rows = state.filtered.map(r=>[
    r.name||'', r.email||'', r.phone||'', fmt(r.firstReservation), fmt(r.lastReservation),
    r.totalReservations??0, r.lastMenu||r.lastItems||''
  ]);
  const csv = [headers,...rows].map(line=>line.map(v=>(/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v)).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const url = URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`customers_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

function openHistoryDrawer(customer){
  const key = (customer.email || customer.phone || customer.name || '').toLowerCase().trim();
  const hist = state.reservations.filter(r => {
    const k = (r.email || r.phone || r.name || '').toLowerCase().trim();
    return k === key;
  }).sort((a,b)=>String(b.start||'').localeCompare(String(a.start||'')));

  qs('#drawerTitle').textContent = `来店履歴：${customer.name || customer.email || customer.phone || ''}`;
  const tb = qs('#history tbody'); tb.innerHTML='';
  for(const h of hist){
    const tr=document.createElement('tr');
    tr.innerHTML = `
      <td>${fmt(h.start)}</td>
      <td>${esc(h.menu)}</td>
      <td>${esc(h.items || h.opts || '')}</td>
      <td>${esc(h.status || '')}</td>
    `;
    tb.appendChild(tr);
  }
  const drawer = qs('#drawer');
  drawer.setAttribute('aria-hidden','false');
  drawer.addEventListener('click', (e)=>{ if(e.target===drawer) closeDrawer(); }, { once:true });
  qs('#drawer .close').onclick = closeDrawer;
}
function closeDrawer(){ qs('#drawer').setAttribute('aria-hidden','true'); }

// 予約メール内リンク（token=...）で開かれた時の単発表示（簡易）
async function maybeHandleTokenView(){
  const p = new URLSearchParams(location.search);
  const token = p.get('token'); if(!token) return;
  qs('#tokenView').style.display='';
  try{
    const res = await fetch(`${GAS_WEBAPP_URL}?op=view&format=json&token=${encodeURIComponent(token)}`);
    const j = await res.json();
    qs('#tokenResult').textContent = JSON.stringify(j, null, 2);
  }catch(e){
    qs('#tokenResult').textContent = '読み込みに失敗しました。';
  }
}

function attach(){
  qs('#q').addEventListener('input', applyFilter);
  qs('#sort').addEventListener('change', applySort);
  qs('#reload').addEventListener('click', loadData);
  qs('#exportCsv').addEventListener('click', exportCsv);
}

(async function init(){
  attach();
  await maybeHandleTokenView();
  try {
    await loadData();
  } catch(e) {
    alert('データ取得に失敗しました。\n' + e);
    console.error(e);
  }
})();
