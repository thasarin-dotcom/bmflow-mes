// ════════════════════════════════════════════════════════════════════════════
// ProFlow Wise MES — Supplier Stock: สต็อกฝั่งบลูมมิ่ง (2026-11-02)
// คำขอผู้ใช้: "ลงยอดสต็อกของรายการที่ซื้อจากบลูมมิ่ง เพื่อดูว่าเราเบิกมาแล้วสต็อกบลูมมิ่งเหลือเท่าไหร่ ทำงานร่วมกับใบขอเบิก
//   ตัดยอดสต็อกจากบลูมมิ่งมาอยู่คลัง WNV แสดงยอดรวมทั้ง 2 คลัง และทำงานร่วมกับระบบพยากรณ์ของแต่ละซีรี่"
// ผู้ใช้เลือก (2026-11-02):
//   • รายการของบลูมมิ่ง = วัตถุดิบที่เคยรับเข้า (mr_receive) จาก Supplier ที่ชื่อมีคำว่า "บลูม"/"blooming" + ที่ลงยอดไว้ในหน้านี้
//   • ฝั่งบลูมมิ่งลงเป็นรายการ: ยอดยกมา (OPEN) / บลูมมิ่งรับเข้า-ผลิตเพิ่ม (IN) / ปรับยอดตามที่บลูมมิ่งแจ้งนับจริง (ADJ)
//   • ตัดยอดบลูมมิ่งตอน "รับเข้า MR" ที่ Supplier เป็นบลูมมิ่ง (ใบขอซื้อเดิม → รับเข้า) — ไม่บันทึกซ้ำในตาราง คำนวณเอา
//   • หน้าพยากรณ์ตามซีรี่ (ภาพรวม CO → ประมาณการสั่งซื้อวัตถุดิบ) ใช้ยอดรวม 2 คลังคิด "ต้องสั่งเพิ่ม" (ssBalanceMap)
// คงเหลือบลูมมิ่ง = ยอดยกมาล่าสุด + IN + ADJ (หลังยอดยกมา) − MR จากบลูมมิ่งที่ Date > วันยอดยกมา (ยอดยกมา = ยอด ณ สิ้นวัน)
// ยังไม่ตั้งยอดยกมา = ไม่รู้ยอด (null) → ไม่เอาไปรวม 2 คลัง/พยากรณ์
// ตาราง supplier_stock_moves (create_supplier_stock.sql) เพิ่ม/อ่านได้อย่างเดียว · ไฟล์นี้ต้องอัปโหลดคู่ index.html (?v=)
// ════════════════════════════════════════════════════════════════════════════

const SS_SUPPLIER = 'บลูมมิ่ง';
const SS_MATCH = /บลูม|blooming/i;
const SS_TYPE_LABEL = { OPEN: 'ยอดยกมา', IN: 'บลูมมิ่งรับเข้า', ADJ: 'ปรับยอด', MR: 'เบิกเข้าคลัง WNV' };
let _ss = null;                                  // ข้อมูลล่าสุดของหน้า { items, byCode, materials, movesOk, ... }
let _ssMapCache = null, _ssMapAt = 0;            // แคชของ ssBalanceMap (หน้าพยากรณ์)

function _ssEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function _ssJs(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function _ssNum(n, d = 3) { return n == null ? '—' : (Number(n) || 0).toLocaleString('th-TH', { maximumFractionDigits: d }); }
function _ssWho() { return (typeof _currentUser !== 'undefined' && _currentUser && (_currentUser.name || _currentUser.email)) || null; }
// ยอดยกมา / ปรับยอด = หัวหน้างานขึ้นไป · บลูมมิ่งรับเข้า = ทุกคนที่ล็อกอิน
function _ssCanManage() { return (typeof _hasRole === 'function' && _hasRole('supervisor')) || !!(typeof _currentUser !== 'undefined' && _currentUser && _currentUser.isAdmin); }
const _ssToday = () => (typeof _planWeekLocalDateStr === 'function' ? _planWeekLocalDateStr(new Date()) : new Date().toISOString().slice(0, 10));
const _ssDaysAgo = n => (typeof _planWeekLocalDateStr === 'function' ? _planWeekLocalDateStr(new Date(Date.now() - n * 864e5)) : new Date(Date.now() - n * 864e5).toISOString().slice(0, 10));

// ── สร้างหน้า (แบบเดียวกับ stocktools.js / qc.js) ──
function _ssEnsurePage() {
  const host = document.getElementById('page-holdstock')?.parentNode;
  if (!host || document.getElementById('page-supplierstock')) return;
  const div = document.createElement('div');
  div.className = 'page-view'; div.id = 'page-supplierstock';
  div.innerHTML = `<div class="page-header"><div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4 class="fw-bold mb-0" style="color:white"><i class="fas fa-warehouse me-2"></i>Supplier Stock — สต็อกบลูมมิ่ง</h4>
        <div class="text-white-50 small">ของที่ซื้อจากบลูมมิ่งเหลือที่บลูมมิ่งเท่าไหร่ · รับเข้า MR จากบลูมมิ่ง = ตัดยอดบลูมมิ่งเข้าคลัง WNV อัตโนมัติ · ยอดรวม 2 คลังใช้ในพยากรณ์ตามซีรี่</div></div>
      <div class="d-flex gap-1">
        <button class="btn btn-light btn-sm fw-bold text-primary shadow-sm" onclick="supplierStockLoad()"><i class="fas fa-rotate me-1"></i>รีเฟรช</button>
        <button class="btn btn-light btn-sm fw-bold text-success shadow-sm" id="ss-add-btn" onclick="ssOpenMove('IN')"><i class="fas fa-plus me-1"></i>บลูมมิ่งรับเข้า</button>
      </div></div></div>
    <div class="scroll-content" id="supplierstock-body"><div class="glass-card text-muted text-center py-5">กำลังโหลด…</div></div>`;
  host.appendChild(div);
}

// ── อ่านข้อมูล ──
// ใบรับจากบลูมมิ่ง — กรองฝั่งเซิร์ฟเวอร์ (ilike) แล้วกรองซ้ำด้วย SS_MATCH · อ่านทีละ 1000 แถว
async function _ssFetchMR() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await _sb.from('mr_receive').select('*').or('Supplier.ilike.*บลูม*,Supplier.ilike.*blooming*').range(from, from + 999);
    if (error) return { rows, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return {
    rows: rows.filter(r => SS_MATCH.test(r.Supplier || '') && r.MaterialCode).map(r => ({
      code: r.MaterialCode, name: r.MaterialName || '', uom: r.UOM || '',
      date: String(r.Date ?? r.ReceiveDate ?? '').slice(0, 10), qty: parseFloat(r.Qty ?? r.QtyIn) || 0,
      doc: r.MR_ID || r.RC_No || '', lot: r.Lot || '', unitCost: parseFloat(r.UnitCost) || 0, supplier: r.Supplier || '',
    })),
    error: null,
  };
}
async function _ssFetchMoves() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await _sb.from('supplier_stock_moves').select('*').eq('Supplier', SS_SUPPLIER).range(from, from + 999);
    if (error) return { rows: [], error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { rows, error: null };
}

// คงเหลือบลูมมิ่งต่อรหัส + ประวัติ (เรียงวันที่) พร้อมยอดสะสมหลังยอดยกมา
function _ssCompute(moves, mrs) {
  const byCode = {};
  const touch = (code, name, uom) => {
    const o = (byCode[code] ||= { code, name: '', uom: '', moves: [], mrs: [], open: null, balance: null, lastCost: 0 });
    if (!o.name && name) o.name = name;
    if (!o.uom && uom) o.uom = uom;
    return o;
  };
  moves.forEach(m => touch(m.MaterialCode, m.MaterialName, m.UOM).moves.push(m));
  mrs.forEach(r => touch(r.code, r.name, r.uom).mrs.push(r));
  Object.values(byCode).forEach(o => {
    o.moves.sort((a, b) => String(a.MoveDate).localeCompare(String(b.MoveDate)) || a._row_id - b._row_id);
    o.mrs.sort((a, b) => a.date.localeCompare(b.date));
    const costed = o.mrs.filter(r => r.unitCost > 0);
    o.lastCost = costed.length ? costed[costed.length - 1].unitCost : 0;
    // ยอดยกมาล่าสุด (OPEN ที่ MoveDate มากสุด ถ้าวันเดียวกันใช้แถวหลังสุด)
    o.moves.forEach(m => { if (m.MoveType === 'OPEN') o.open = m; });
    // ประวัติ: รายการฝั่งบลูมมิ่ง + ใบรับ MR เรียงตามวัน — วันเดียวกัน: MR ก่อน (ยอดยกมา = ยอดสิ้นวัน รวม MR วันนั้นไปแล้ว)
    // แล้วรายการฝั่งบลูมมิ่งเรียงตามลำดับที่บันทึก (_row_id) — รับเข้า/ปรับที่บันทึกหลังยอดยกมาในวันเดียวกันจึงยังนับ
    const ev = [
      ...o.moves.map(m => ({ date: String(m.MoveDate).slice(0, 10), type: m.MoveType, qty: parseFloat(m.Qty) || 0, ref: m.Ref || '', note: m.Note || '', by: m.CreatedBy || '', row: m._row_id, before: m.BeforeQty })),
      ...o.mrs.map(r => ({ date: r.date, type: 'MR', qty: r.qty, ref: r.doc, note: [r.lot && 'Lot ' + r.lot, r.supplier].filter(Boolean).join(' · '), by: '', row: 0 })),
    ];
    ev.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'MR' ? 0 : 1) - (b.type === 'MR' ? 0 : 1) || a.row - b.row);
    let bal = null, started = false;
    ev.forEach(e => {
      if (o.open && e.type === 'OPEN' && e.row === o.open._row_id) { bal = e.qty; started = true; e.bal = bal; return; }
      if (!started) { e.pre = true; return; }   // ก่อนยอดยกมาล่าสุด = ไม่นับ (แสดงเป็นประวัติเฉยๆ)
      if (e.type === 'OPEN') { e.pre = true; return; }
      bal += e.type === 'MR' ? -e.qty : e.qty;
      e.bal = bal;
    });
    o.events = ev;
    o.balance = o.open ? bal : null;
  });
  return byCode;
}

// สำหรับหน้าพยากรณ์ตามซีรี่ (codashLoadData) — { MaterialCode: คงเหลือบลูมมิ่ง } เฉพาะรหัสที่ตั้งยอดยกมาแล้ว · แคช 60 วิ
async function ssBalanceMap() {
  if (_ssMapCache && Date.now() - _ssMapAt < 60000) return _ssMapCache;
  const [mv, mr] = await Promise.all([_ssFetchMoves(), _ssFetchMR()]);
  if (mv.error) return {};   // ยังไม่ได้รัน create_supplier_stock.sql
  const byCode = _ssCompute(mv.rows, mr.rows || []);
  const out = {};
  Object.values(byCode).forEach(o => { if (o.balance !== null) out[o.code] = o.balance; });
  _ssMapCache = out; _ssMapAt = Date.now();
  return out;
}

// ── โหลดหน้า ──
async function supplierStockLoad() {
  _ssEnsurePage();
  const body = document.getElementById('supplierstock-body');
  if (!body) return;
  if (typeof _showLoader === 'function') _showLoader();
  try {
    const [mv, mr, sb, mats] = await Promise.all([
      _ssFetchMoves(), _ssFetchMR(),
      _fetchAllPaged('stock_balance', 'MaterialCode,QtyBalance'),
      _fetchAllPaged('materials', 'MaterialCode,MaterialName,TYPE,UOM'),
    ]);
    if (mr.error) throw new Error('อ่านใบรับวัตถุดิบไม่ได้: ' + mr.error.message);
    const byCode = _ssCompute(mv.error ? [] : mv.rows, mr.rows);
    const wnv = {};
    (sb.data || []).forEach(r => { if (r.MaterialCode) wnv[r.MaterialCode] = (wnv[r.MaterialCode] || 0) + (parseFloat(r.QtyBalance) || 0); });
    const matByCode = Object.fromEntries((mats.data || []).map(m => [m.MaterialCode, m]));
    const prMap = typeof _codemandLoadApprovedPR === 'function' ? await _codemandLoadApprovedPR(Object.keys(byCode)).catch(() => ({})) : {};
    const d180 = _ssDaysAgo(180);
    const items = Object.values(byCode).map(o => {
      const m = matByCode[o.code] || {};
      const w = wnv[o.code] || 0;
      const avg = o.mrs.filter(r => r.date >= d180).reduce((s, r) => s + r.qty, 0) / 6;
      const pr = prMap[o.code] || { outstanding: 0, prs: [] };
      return {
        ...o, name: m.MaterialName || o.name || o.code, uom: o.uom || m.UOM || '', type: m.TYPE || '',
        wnv: w, total: o.balance === null ? null : w + Math.max(0, o.balance),
        avg, cover: o.balance !== null && avg > 0 ? Math.max(0, o.balance) / avg : null,
        prOut: pr.outstanding, prList: pr.prs,
      };
    }).sort((a, b) => (a.type || '').localeCompare(b.type || '') || a.code.localeCompare(b.code));
    _ss = { items, byCode: Object.fromEntries(items.map(i => [i.code, i])), materials: mats.data || [], movesOk: !mv.error,
      suppliers: [...new Set(mr.rows.map(r => r.supplier))], at: new Date() };
    _ssMapCache = null;
    supplierStockRender();
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="glass-card text-danger">${_ssEsc(e.message || e)}</div>`;
  } finally { if (typeof _hideLoader === 'function') _hideLoader(); }
}

function supplierStockRender() {
  const body = document.getElementById('supplierstock-body');
  if (!body || !_ss) return;
  const q = (document.getElementById('ss-q')?.value || '').trim().toLowerCase();
  const tf = document.getElementById('ss-type')?.value || '';
  const sf = document.getElementById('ss-status')?.value || '';
  const can = _ssCanManage();
  const all = _ss.items;
  const kpi = (n, label, color, sub) => `<div class="col-6 col-lg-3"><div class="kpi-card"><div class="kpi-num" style="${color ? 'color:' + color : ''}">${n}</div><div class="kpi-label">${label}</div>${sub ? `<div class="small text-muted">${sub}</div>` : ''}</div></div>`;
  const opened = all.filter(i => i.balance !== null);
  const empty = opened.filter(i => i.balance <= 0.0001);
  const value = opened.reduce((s, i) => s + Math.max(0, i.balance) * (i.lastCost || 0), 0);
  const typeOpts = [...new Set(all.map(i => i.type).filter(Boolean))].sort();
  const rows = all.filter(i => (!q || (i.code + ' ' + i.name).toLowerCase().includes(q)) && (!tf || i.type === tf) &&
    (!sf || (sf === 'noopen' ? i.balance === null : sf === 'empty' ? i.balance !== null && i.balance <= 0.0001 : sf === 'low' ? i.cover !== null && i.cover < 2 : true)));
  const bloomCell = i => {
    if (i.balance === null) return can && _ss.movesOk ? `<button class="btn btn-sm btn-outline-primary py-0" onclick="ssOpenMove('OPEN','${_ssJs(i.code)}')">ตั้งยอดยกมา</button>` : '<span class="text-muted small">ยังไม่ตั้งยอดยกมา</span>';
    const neg = i.balance < -0.0001;
    return `<span class="fw-bold ${neg ? 'text-danger' : i.balance <= 0.0001 ? 'text-warning-emphasis' : 'text-primary'}"${neg ? ' title="เบิกเข้าคลัง WNV มากกว่ายอดที่ลงไว้ — ลงบลูมมิ่งรับเข้า หรือปรับยอดตามที่บลูมมิ่งแจ้ง"' : ''}>${_ssNum(i.balance)}</span>`;
  };
  const coverCell = i => i.cover === null ? '<span class="text-muted">—</span>'
    : `<span class="${i.cover < 1 ? 'text-danger fw-bold' : i.cover < 2 ? 'text-warning-emphasis fw-bold' : 'text-success'}">~${i.cover < 10 ? i.cover.toFixed(1) : Math.round(i.cover)} เดือน</span>`;
  const prCell = i => i.prOut > 0 ? `<span class="text-primary fw-bold" title="${_ssEsc(i.prList.map(p => p.prNo + ': ' + _ssNum(p.left)).join(' · '))}">${_ssNum(i.prOut)}</span><div class="text-muted" style="font-size:.7rem">${_ssEsc(i.prList.map(p => p.prNo).join(', '))}</div>` : '<span class="text-muted">—</span>';
  body.innerHTML = `
    ${_ss.movesOk ? '' : '<div class="alert alert-warning small"><i class="fas fa-triangle-exclamation me-1"></i>ยังไม่ได้รัน <code>create_supplier_stock.sql</code> — ดูรายการที่เคยรับจากบลูมมิ่งได้ แต่ยังลงยอดบลูมมิ่งไม่ได้</div>'}
    <div class="row g-2 mb-2">
      ${kpi(all.length, 'รายการที่ซื้อจากบลูมมิ่ง', '', `ตั้งยอดยกมาแล้ว ${opened.length}/${all.length}`)}
      ${kpi('฿' + _ssNum(value, 0), 'มูลค่าคงเหลือที่บลูมมิ่ง', '#1e3a8a', 'คิดจากราคารับล่าสุด')}
      ${kpi(empty.length, 'บลูมมิ่งหมด/ติดลบ', empty.length ? '#dc2626' : '', 'ต้องลงรับเข้า หรือสั่งบลูมมิ่งผลิตเพิ่ม')}
      ${kpi(opened.filter(i => i.cover !== null && i.cover < 2).length, 'พอเบิกไม่ถึง 2 เดือน', '#d97706', 'เทียบเบิกเฉลี่ย 6 เดือน')}
    </div>
    <div class="glass-card">
      <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
        <input id="ss-q" class="form-control form-control-sm" style="max-width:240px" placeholder="ค้นหารหัส / ชื่อ" value="${_ssEsc(q)}" oninput="supplierStockRender()">
        <select id="ss-type" class="form-select form-select-sm" style="max-width:140px" onchange="supplierStockRender()"><option value="">ทุกประเภท</option>${typeOpts.map(t => `<option ${t === tf ? 'selected' : ''}>${_ssEsc(t)}</option>`).join('')}</select>
        <select id="ss-status" class="form-select form-select-sm" style="max-width:190px" onchange="supplierStockRender()">
          ${[['', 'ทุกสถานะ'], ['low', 'พอเบิกไม่ถึง 2 เดือน'], ['empty', 'บลูมมิ่งหมด/ติดลบ'], ['noopen', 'ยังไม่ตั้งยอดยกมา']].map(([v, l]) => `<option value="${v}" ${v === sf ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="small text-muted ms-auto">${rows.length} รายการ · Supplier ที่จับได้: ${_ssEsc(_ss.suppliers.join(', ') || '—')}</span>
      </div>
      <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
        <thead><tr><th class="text-center" style="width:44px">#</th><th>รายการ</th><th>ประเภท</th><th class="text-end">บลูมมิ่ง<br>คงเหลือ</th><th class="text-end">คลัง WNV</th><th class="text-end">รวม 2 คลัง</th>
          <th class="text-end" title="ใบขอซื้อที่อนุมัติแล้ว ยังรับเข้าไม่ครบ">ขอซื้อ<br>ค้างรับ</th><th class="text-end">เบิกเฉลี่ย<br>/เดือน</th><th class="text-end" title="คงเหลือบลูมมิ่ง ÷ เบิกเฉลี่ย/เดือน">บลูมมิ่ง<br>พอเบิกอีก</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map((i, n) => `<tr>
          <td class="text-center text-muted">${n + 1}</td>
          <td><div class="fw-semibold">${_ssEsc(i.name)}</div><div class="small text-muted"><code>${_ssEsc(i.code)}</code> · ${_ssEsc(i.uom)}</div></td>
          <td>${i.type ? `<span class="badge ${i.type === 'BULK' ? 'bg-info text-dark' : 'bg-secondary'}">${_ssEsc(i.type)}</span>` : ''}</td>
          <td class="text-end">${bloomCell(i)}</td>
          <td class="text-end">${_ssNum(i.wnv)}</td>
          <td class="text-end fw-bold">${_ssNum(i.total)}</td>
          <td class="text-end">${prCell(i)}</td>
          <td class="text-end">${i.avg ? _ssNum(i.avg, 1) : '<span class="text-muted">—</span>'}</td>
          <td class="text-end">${coverCell(i)}</td>
          <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-outline-secondary py-0" onclick="ssHistory('${_ssJs(i.code)}')" title="ประวัติ"><i class="fas fa-clock-rotate-left"></i></button>
            ${_ss.movesOk ? `<button class="btn btn-sm btn-outline-success py-0" onclick="ssOpenMove('IN','${_ssJs(i.code)}')" title="บลูมมิ่งรับเข้า"><i class="fas fa-plus"></i></button>` : ''}
            ${_ss.movesOk && can && i.balance !== null ? `<button class="btn btn-sm btn-outline-warning py-0" onclick="ssOpenMove('ADJ','${_ssJs(i.code)}')" title="ปรับยอดตามที่บลูมมิ่งแจ้ง"><i class="fas fa-scale-balanced"></i></button>` : ''}
          </td></tr>`).join('') : '<tr><td colspan="10" class="text-center text-muted py-4">ไม่มีรายการ</td></tr>'}</tbody></table></div>
      <div class="small text-muted mt-2">
        <b>บลูมมิ่งคงเหลือ</b> = ยอดยกมา + บลูมมิ่งรับเข้า ± ปรับยอด − รับเข้า MR จากบลูมมิ่ง (หลังวันยอดยกมา) ·
        <b>รวม 2 คลัง</b> ไม่นับยอดบลูมมิ่งที่ติดลบ · ยอดนี้ใช้คิด "ต้องสั่งเพิ่ม" ในหน้าภาพรวม CO → พยากรณ์ตามซีรี่ ·
        ยอดยกมา/ปรับยอด = หัวหน้างานขึ้นไป · อัปเดตเมื่อ ${_ss.at.toLocaleTimeString('th-TH')}
      </div>
    </div>`;
  const addBtn = document.getElementById('ss-add-btn');
  if (addBtn) addBtn.disabled = !_ss.movesOk;
}

// ── ลงยอด: OPEN (ยอดยกมา) / IN (บลูมมิ่งรับเข้า) / ADJ (ปรับยอดเป็นยอดนับจริง) ──
async function ssOpenMove(type, code) {
  if (!_ss || !_ss.movesOk) return;
  if (type !== 'IN' && !_ssCanManage()) { _err('ไม่มีสิทธิ์', 'ยอดยกมา/ปรับยอด สำหรับหัวหน้างานขึ้นไป'); return; }
  const it = code ? _ss.byCode[code] : null;
  if (type === 'ADJ' && (!it || it.balance === null)) return;
  const matList = _ss.materials.map(m => `<option value="${_ssEsc(m.MaterialCode)}">${_ssEsc(m.MaterialName || '')}</option>`).join('');
  const title = { OPEN: 'ตั้งยอดยกมา (บลูมมิ่ง)', IN: 'บลูมมิ่งรับเข้า / ผลิตเพิ่ม', ADJ: 'ปรับยอดตามที่บลูมมิ่งแจ้ง' }[type];
  const hint = {
    OPEN: 'ยอดคงเหลือที่บลูมมิ่ง ณ <b>สิ้นวัน</b>ที่เลือก — ใบรับ MR จากบลูมมิ่งหลังวันนี้จะถูกตัดจากยอดนี้อัตโนมัติ' + (it && it.open ? `<br><span class="text-danger">มียอดยกมาเดิมแล้ว (${_ssNum(it.open.Qty)} ณ ${String(it.open.MoveDate).slice(0, 10)}) — ยอดใหม่จะใช้แทน</span>` : ''),
    IN: 'ของเข้าคลังบลูมมิ่ง (บลูมมิ่งผลิต/รับเพิ่มไว้ให้เรา) — <b>ไม่ใช่</b>ของที่เบิกมาเข้า WNV (อันนั้นตัดเองตอนรับเข้า MR)',
    ADJ: `ยอดในระบบตอนนี้ <b>${it ? _ssNum(it.balance) : ''} ${_ssEsc(it?.uom || '')}</b> — กรอกยอดที่บลูมมิ่งนับได้จริง ระบบบันทึกส่วนต่างให้`,
  }[type];
  const r = await Swal.fire({
    title, width: 560, showCancelButton: true, confirmButtonText: 'บันทึก', cancelButtonText: 'ยกเลิก', focusConfirm: false,
    html: `<div class="text-start small">
      <div class="alert alert-light border py-2">${hint}</div>
      <label class="form-label mb-1">รายการ</label>
      ${it ? `<div class="form-control form-control-sm bg-light mb-2">${_ssEsc(it.code)} — ${_ssEsc(it.name)}</div><input type="hidden" id="ss-f-code" value="${_ssEsc(it.code)}">`
        : `<input id="ss-f-code" class="form-control form-control-sm mb-2" list="ss-mat-list" placeholder="พิมพ์รหัส/ชื่อวัตถุดิบ"><datalist id="ss-mat-list">${matList}</datalist>`}
      <div class="row g-2">
        <div class="col-6"><label class="form-label mb-1">วันที่</label><input id="ss-f-date" type="date" class="form-control form-control-sm" value="${_ssToday()}" ${type === 'ADJ' ? 'readonly' : ''}></div>
        <div class="col-6"><label class="form-label mb-1">${type === 'ADJ' ? 'ยอดนับจริง' : type === 'OPEN' ? 'ยอดคงเหลือ' : 'จำนวนรับเข้า'}${it?.uom ? ' (' + _ssEsc(it.uom) + ')' : ''}</label><input id="ss-f-qty" type="number" step="any" min="0" class="form-control form-control-sm"></div>
      </div>
      <label class="form-label mb-1 mt-2">เลขเอกสารบลูมมิ่ง (ถ้ามี)</label><input id="ss-f-ref" class="form-control form-control-sm">
      <label class="form-label mb-1 mt-2">หมายเหตุ${type === 'ADJ' ? ' / เหตุผล <span class="text-danger">*</span>' : ''}</label><input id="ss-f-note" class="form-control form-control-sm">
    </div>`,
    preConfirm: () => {
      const v = id => document.getElementById(id).value.trim();
      const c = v('ss-f-code'), qty = parseFloat(v('ss-f-qty')), date = v('ss-f-date');
      const mat = _ss.materials.find(m => m.MaterialCode === c);
      if (!c || (!it && !mat)) { Swal.showValidationMessage('เลือกรายการวัตถุดิบจากรายการ'); return false; }
      if (!date) { Swal.showValidationMessage('ใส่วันที่'); return false; }
      if (!(qty >= 0) || (type === 'IN' && !(qty > 0))) { Swal.showValidationMessage('ใส่จำนวนให้ถูกต้อง'); return false; }
      if (type === 'ADJ' && !v('ss-f-note')) { Swal.showValidationMessage('ใส่เหตุผลการปรับยอด'); return false; }
      if (type === 'ADJ' && Math.abs(qty - it.balance) < 0.0001) { Swal.showValidationMessage('ยอดนับเท่ากับยอดในระบบแล้ว ไม่ต้องปรับ'); return false; }
      return { c, qty, date, ref: v('ss-f-ref'), note: v('ss-f-note'), mat };
    },
  });
  if (!r.isConfirmed) return;
  const { c, qty, date, ref, note, mat } = r.value;
  const row = {
    Supplier: SS_SUPPLIER, MoveDate: date, MoveType: type, MaterialCode: c,
    MaterialName: it?.name || mat?.MaterialName || null, UOM: it?.uom || mat?.UOM || null,
    Qty: type === 'ADJ' ? qty - it.balance : qty, BeforeQty: type === 'ADJ' ? it.balance : null,
    Ref: ref || null, Note: note || null, CreatedBy: _ssWho(),
  };
  const { error } = await _sb.from('supplier_stock_moves').insert(row);
  if (error) { _err('บันทึกไม่สำเร็จ', _ssEsc(error.message)); return; }
  if (typeof _logAudit === 'function') _logAudit('CREATE', 'supplier_stock_moves', c, `${SS_TYPE_LABEL[type]} ${SS_SUPPLIER} ${_ssNum(row.Qty)} ${row.UOM || ''}${note ? ' · ' + note : ''}`);
  Swal.fire({ icon: 'success', title: 'บันทึกแล้ว', timer: 1200, showConfirmButton: false });
  await supplierStockLoad();
}

// ── ประวัติต่อรายการ (ฝั่งบลูมมิ่ง + เบิกเข้า WNV) พร้อมยอดสะสม ──
function ssHistory(code) {
  const it = _ss && _ss.byCode[code];
  if (!it) return;
  const color = { OPEN: 'bg-primary', IN: 'bg-success', ADJ: 'bg-warning text-dark', MR: 'bg-info text-dark' };
  const rows = [...it.events].reverse();
  Swal.fire({
    width: 900, showConfirmButton: false, showCloseButton: true,
    title: `<div class="fs-5">${_ssEsc(it.name)}</div><div class="small text-muted fw-normal">${_ssEsc(it.code)} · บลูมมิ่งคงเหลือ ${_ssNum(it.balance)} ${_ssEsc(it.uom)}</div>`,
    html: `<div class="table-responsive text-start" style="max-height:60vh"><table class="table table-sm mb-0 small">
      <thead class="sticky-top bg-white"><tr><th>วันที่</th><th>รายการ</th><th>เอกสาร</th><th class="text-end">จำนวน</th><th class="text-end">คงเหลือบลูมมิ่ง</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${rows.length ? rows.map(e => `<tr class="${e.pre ? 'text-muted' : ''}"${e.pre ? ' title="ก่อนยอดยกมาล่าสุด — ไม่นับในยอดคงเหลือ"' : ''}>
        <td class="text-nowrap">${_ssEsc(e.date)}</td><td><span class="badge ${color[e.type]}">${SS_TYPE_LABEL[e.type]}</span></td>
        <td>${_ssEsc(e.ref)}</td>
        <td class="text-end">${e.type === 'OPEN' ? '' : e.type === 'MR' ? '−' + _ssNum(e.qty) : (e.qty > 0 ? '+' : '') + _ssNum(e.qty)}</td>
        <td class="text-end fw-bold">${e.pre ? '<span class="fw-normal">ไม่นับ</span>' : _ssNum(e.bal)}</td>
        <td>${_ssEsc([e.note, e.by && 'โดย ' + e.by].filter(Boolean).join(' · '))}</td></tr>`).join('') : '<tr><td colspan="6" class="text-center text-muted">ไม่มีประวัติ</td></tr>'}</tbody></table></div>`,
  });
}

_ssEnsurePage();
