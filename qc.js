// ════════════════════════════════════════════════════
// BM Flow — ระบบ QC เฟส 1: ตรวจรับวัตถุดิบ / วัสดุบรรจุ (IQC) + NCR + ป้ายสถานะ  (ตามมาตรฐาน QP-WH-01)
// ไฟล์นี้ต้องอัปโหลดคู่กับ index.html เสมอ (<script src="qc.js?v=..."> ท้าย index.html) — เปลี่ยนไฟล์นี้ให้เปลี่ยนเลข ?v= ด้วย กัน cache
// ตาราง/ฟังก์ชัน DB ดู migration_2026-10-31_qc_phase1.sql (ต้องรันก่อน) — ผู้ตรวจ/อนุมัติ = แอดมิน, ทุกคนอ่านได้
// ใช้ global ของสคริปต์หลักตรงๆ: _sb, Swal, Dlg, esc, badge, fmtDate, todayStr, _hasRole, _currentUser, _rmLotCache, rmLotLoad,
//   _rmMasterCache, _rmName, _rmFmtQty, _lotLabel, _planFefo, _isRefDate, REAL_DATA_START, PAGE_LOADERS, showPage
// สถานะ Lot = ใบตรวจล่าสุดของ Lot_ID (stock_rm_lot) · ไม่มีใบตรวจ = รอตรวจ (รวมของก่อน 1 ต.ค. 2026 — ผู้ใช้ตัดสิน: ไม่ผ่านโดยปริยาย)
// โหมดเบิก: Enforce=false → เตือนแล้วให้เบิกต่อได้ (ค่าเริ่มต้น) · true → บล็อก  ไม่แตะ stock เลย (ไม่ผ่าน = ย้ายของไป Rejected Area ด้วยมือ)
// ════════════════════════════════════════════════════

const QC_CHECKS = [
  'ลักษณะ สี กลิ่น ตรงตามมาตรฐาน',
  'ภาชนะ/บรรจุภัณฑ์ไม่แตก ไม่รั่ว ไม่เปียกชื้น',
  'ฉลาก / ชื่อ Lot ตรงกับใบส่งของ',
  'ไม่มีสิ่งแปลกปลอม แมลง หรือเชื้อรา',
  'วันที่ผลิต / วันหมดอายุระบุชัดเจน',
];
const QC_DISP = { SCRAP: 'ทำลาย', RETURN_SUPPLIER: 'ส่งคืนซัพพลายเออร์', REWORK: 'Rework / คัดแยก', USE_AS_IS: 'ใช้ตามสภาพ (ต้องอนุมัติ)' };
const QC_LABEL = {
  pending: { word: 'QUARANTINE', th: 'กักกัน — รอ QC ตรวจ', form: 'FM-WH-02', color: '#b8860b', bg: '#fff3cd' },
  PASS:    { word: 'PASSED',     th: 'ผ่าน — ใช้ผลิตได้',   form: 'FM-WH-03', color: '#15803d', bg: '#dcfce7' },
  REJECT:  { word: 'REJECTED',   th: 'ไม่ผ่าน — ห้ามใช้',    form: 'FM-WH-04', color: '#b91c1c', bg: '#fee2e2' },
};

let _qcReady = true;          // false = ยังไม่ได้รัน migration_2026-10-31_qc_phase1.sql
let _qcEnforce = false;
let _qcInsp = [], _qcNcr = [];
let _qcLatest = {};           // Lot_ID → ใบตรวจล่าสุด
let _qcAt = 0;
let _qcTab = 'pending', _qcAge = 'new';
let _qcSel = new Set();

const _qcAdmin = () => typeof _hasRole === 'function' && _hasRole('admin');
const _qcMe = () => _currentUser?.name || _currentUser?.email || null;
const qcStatusOf = lotId => _qcLatest[lotId]?.Result || 'pending';
function qcBadge(lotId) {
  if (!_qcReady) return '';
  const s = qcStatusOf(lotId);
  return s === 'PASS' ? '<span class="badge text-bg-success" title="ผ่าน QC">ผ่าน QC</span>'
    : s === 'REJECT' ? '<span class="badge text-bg-danger" title="ไม่ผ่าน QC — ห้ามใช้">ไม่ผ่าน QC</span>'
    : '<span class="badge text-bg-warning" title="ยังไม่มีใบตรวจ QC">รอตรวจ</span>';
}

async function _qcFetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await _sb.from(table).select('*').order(order, { ascending: false }).range(from, from + 999);
    if (error) return { error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out };
}
// โหลดสถานะ — เรียกจาก rmLotLoad() ด้วย เพื่อให้ป้ายสถานะในหน้า Stock ขึ้นตามล็อตเสมอ
async function qcLoadStatus() {
  const [st, ins] = await Promise.all([
    _sb.from('qc_settings').select('Enforce').eq('id', 1).maybeSingle(),
    _qcFetchAll('qc_inspections', 'InspectedAt'),
  ]);
  if (st.error || ins.error) { _qcReady = false; _qcInsp = []; _qcLatest = {}; return; }
  _qcReady = true;
  _qcEnforce = !!st.data?.Enforce;
  _qcInsp = ins.data;                       // เรียงใหม่ → เก่า
  _qcLatest = {};
  for (const r of _qcInsp) if (!_qcLatest[r.Lot_ID]) _qcLatest[r.Lot_ID] = r;
  _qcAt = Date.now();
  _qcNavBadge();
}
function _qcPendingLots() { return (_rmLotCache || []).filter(l => (+l.Qty || 0) > 0 && qcStatusOf(l.Lot_ID) === 'pending'); }
function _qcNavBadge() {
  const el = document.getElementById('qcNavBadge'); if (!el) return;
  const n = _qcPendingLots().filter(l => !_isRefDate(l.ReceiveDate)).length;   // นับเฉพาะล็อตใหม่ (ตั้งแต่ 1 ต.ค.) ไม่ให้ตัวเลขท่วมด้วยของเก่า
  el.textContent = n; el.style.display = _qcReady && n > 0 && _qcAdmin() ? '' : 'none';
}

// ── เตือน/บล็อกตอนเบิก — เรียกจากหน้าเบิกก่อนส่งคำสั่งเข้า DB ──
// lotIds = Lot_ID ที่จะถูกตัด → true = ไปต่อได้ · false = ผู้ใช้กลับไปแก้ (หรือถูกบล็อก)
async function qcConfirmLots(lotIds) {
  if (!_qcReady) return true;
  if (Date.now() - _qcAt > 20000) await qcLoadStatus();
  if (!_qcReady) return true;
  const bad = [...new Set(lotIds.filter(Boolean))].map(id => (_rmLotCache.find(l => l.Lot_ID === id) || { Lot_ID: id }))
    .map(l => ({ l, s: qcStatusOf(l.Lot_ID) })).filter(x => x.s !== 'PASS');
  if (!bad.length) return true;
  const list = bad.slice(0, 8).map(x => `<div>${esc(_rmName(x.l.RM_ID))} · Lot <b>${esc(_lotLabel(x.l))}</b> — ${x.s === 'REJECT' ? '<span class="text-danger fw-semibold">ไม่ผ่าน QC</span>' : '<span class="text-warning-emphasis fw-semibold">ยังไม่ผ่านการตรวจ QC</span>'}</div>`).join('')
    + (bad.length > 8 ? `<div class="text-muted">…และอีก ${bad.length - 8} ล็อต</div>` : '');
  if (_qcEnforce) {
    await Swal.fire({ icon: 'error', title: 'เบิกไม่ได้ — ล็อตยังไม่ผ่าน QC', html: `<div class="small text-start">${list}</div><div class="small text-muted mt-2">ให้แอดมิน (QC) ตรวจรับล็อตเหล่านี้ที่หน้า "ตรวจคุณภาพ (QC)" ก่อน</div>` });
    return false;
  }
  const c = await Swal.fire({ icon: 'warning', title: 'มีล็อตที่ยังไม่ผ่าน QC',
    html: `<div class="small text-start">${list}</div><div class="small text-muted mt-2">ตามมาตรฐาน ควรเบิกเฉพาะล็อตที่ผ่านการตรวจ (ตอนนี้อยู่ในโหมดเตือน — เบิกต่อได้)</div>`,
    showCancelButton: true, confirmButtonText: 'เบิกต่อ', cancelButtonText: 'กลับไปแก้' });
  return c.isConfirmed;
}
// rows = [{ rm_id, qty }] → ล็อตที่ระบบจะตัดแบบ FEFO (เหมือน rm_issue_post ฝั่ง DB)
const qcConfirmPlan = rows => qcConfirmLots(rows.flatMap(r => _planFefo(r.rm_id, r.qty).map(p => p.lot_id)));

// ── ป้ายสถานะ (FM-WH-02 กักกัน / 03 ผ่าน / 04 ไม่ผ่าน) — พิมพ์ได้ทุกคน ──
async function qcPrintLabel(lotId) {
  const lot = _rmLotCache.find(l => l.Lot_ID === lotId); if (!lot) return;
  if (_qcReady && Date.now() - _qcAt > 20000) await qcLoadStatus();
  const s = qcStatusOf(lotId), L = QC_LABEL[s], insp = _qcLatest[lotId];
  if (s === 'PASS') return qcPrintReleased(lotId);   // ป้ายเขียว = ใบ Released แบบ ProFlow (สติกเกอร์ 10 ดวง/แผ่น A4)
  const rm = _rmMasterCache.find(r => r.RM_ID === lot.RM_ID);
  let qr = '';
  try { if (typeof QRCode !== 'undefined') qr = await QRCode.toDataURL(String(lotId), { margin: 1, width: 220 }); } catch (e) { /* ไม่มี QR ก็พิมพ์ป้ายได้ */ }
  document.getElementById('qc-print-root')?.remove();
  const root = document.createElement('div'); root.id = 'qc-print-root';
  root.innerHTML = `<div class="qcl" style="border-color:${L.color};background:${L.bg};color:${L.color}">
    <div class="qcl-top"><div class="qcl-word">${L.word}</div><div class="qcl-th">${L.th}</div></div>
    <div class="qcl-body" style="color:#111">
      <div class="qcl-info">
        <div class="qcl-name">${esc(rm?.RM_Name || lot.RM_ID)}</div>
        <div>รหัส <b>${esc(lot.RM_ID)}</b></div>
        <div>Lot <b>${esc(_lotLabel(lot))}</b> <span class="qcl-sm">(${esc(lot.Lot_ID)})</span></div>
        <div>คงเหลือ <b>${_rmFmtQty(+lot.Qty || 0)} ${esc(lot.Unit || '')}</b></div>
        <div>วันที่รับ ${fmtDate(lot.ReceiveDate)} · หมดอายุ ${lot.ExpDate ? fmtDate(lot.ExpDate) : '-'}</div>
        ${insp ? `<div>ใบตรวจ <b>${esc(insp.Insp_ID)}</b> · ${esc(insp.InspectedBy || '')} · ${fmtDate(insp.InspectedAt)}</div>` : '<div>ยังไม่มีใบตรวจ</div>'}
      </div>
      ${qr ? `<img class="qcl-qr" src="${qr}" alt="QR Lot">` : ''}
    </div>
    <div class="qcl-foot" style="color:${L.color}">${L.form}${s === 'REJECT' ? ' · นำไป Rejected Area' : ''}</div></div>`;
  document.body.appendChild(root);
  document.body.classList.add('print-qclabel');
  const done = () => { document.body.classList.remove('print-qclabel'); root.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

// ── ใบ Released (สติกเกอร์เขียว) — หน้าตาเหมือน ProFlow (FM-QC-01-05) แต่ใช้รหัสฟอร์ม FM-WH-03 ของ BM Flow ──
// ช่อง Approved by เว้นว่างให้เซ็นมือ · Retest Date เว้นว่าง · Date = วันที่ตรวจ · MFG = วันเก็บเกี่ยว/ผลิตของใบรับ (ถ้ามี ไม่เดา) · EXP แสดงเดือน/ปี
const QC_REL_FORM_CODE = 'FM-WH-03 / Rev. 00';
function _qcRelSticker(d) {
  const v = x => (x === null || x === undefined || x === '') ? '&nbsp;' : esc(x);
  const box = (on, t) => `<span><span class="box ${on ? 'on' : ''}">${on ? '✓' : ''}</span>${t}</span>`;
  return `<div class="qcr-formcode">${QC_REL_FORM_CODE}</div><div class="qcr-title">Released</div>
    <div class="qcr-checks">${box(d.rm, 'RM')}${box(d.pm, 'PM')}${box(false, 'Bulk')}${box(false, 'FG')}</div>
    <div class="qcr-line"><b>Code No.:</b><span class="val mid">${v(d.code)}</span></div>
    <div class="qcr-line emph"><b>Name:</b><span class="val">${v(d.name)}</span></div>
    <div class="qcr-line split"><div class="emph"><b>RC No./Lot No.:</b><span class="val">${v(d.lot)}</span></div><div class="mid"><b>MFG. Date:</b><span class="val">${v(d.mfg)}</span></div></div>
    <div class="qcr-line split"><div><b>Retest Date:</b><span class="val">&nbsp;</span></div><div class="emph"><b>EXP. Date:</b><span class="val">${v(d.exp)}</span></div></div>
    <div class="qcr-line split"><div class="sig"><b>Approved by:</b><span class="val">&nbsp;</span></div><div class="mid"><b>Date:</b><span class="val">${v(d.date)}</span></div></div>
    <div class="qcr-line emph"><b>Remark:</b><span class="val">${v(d.remark)}</span></div>`;
}
async function qcPrintReleased(lotId) {
  const lot = _rmLotCache.find(l => l.Lot_ID === lotId); if (!lot) return;
  const insp = _qcLatest[lotId], rm = _rmMasterCache.find(r => r.RM_ID === lot.RM_ID);
  const rec = (typeof _receivedCache !== 'undefined' ? _receivedCache : []).find(x => x.Receive_ID === lot.Receive_ID);
  // จำนวนดวงตั้งต้น = จำนวนภาชนะที่รับ + 2 (ผู้ใช้กำหนด 2026-10-31) · ใบรับเก่า/ใบรับโอนที่ไม่ได้บันทึกภาชนะ = 1 ให้กรอกเอง
  const cont = parseInt(rec?.Containers, 10), defN = cont >= 0 ? cont + 2 : 1;
  const wpc = parseFloat(rec?.WeightPerContainer), defRemark = wpc >= 0 && rec?.WeightPerContainer !== null ? `${Math.round(wpc * 1000) / 1000} ${lot.Unit || rm?.Unit || ''}`.trim() : '';
  const r = await Dlg.form({ title: '<i class="fa-solid fa-tag me-2"></i>พิมพ์ใบ Released (ป้ายเขียว)', width: 440, confirmText: 'พิมพ์',
    html: `<div class="p-2 mb-3 rounded bg-light small"><b>${esc(rm?.RM_Name || lot.RM_ID)}</b> · Lot ${esc(_lotLabel(lot))}${insp ? ` · ใบตรวจ ${esc(insp.Insp_ID)}` : ''}</div>
      <label class="form-label small mb-1">จำนวนดวงที่จะพิมพ์</label>
      <input type="number" id="qcr-n" class="form-control form-control-sm mb-1" min="1" max="200" value="${defN}">
      <div class="form-text mb-1">${cont >= 0 ? `ภาชนะที่รับ <b>${cont}</b> + 2 สำรอง = <b>${defN}</b> ดวง` : 'ใบรับนี้ไม่ได้บันทึกจำนวนภาชนะ — กรอกจำนวนดวงเอง'} (แก้ได้)</div>
      <div class="form-text mb-2">10 ดวง/แผ่น A4 · ดวงที่เหลือในแผ่นสุดท้ายพิมพ์เป็นดวงว่างไว้เขียนมือ (เหมือน ProFlow)</div>
      <label class="form-label small mb-1">Remark (ทุกดวง) เช่น 5 กก.</label><input id="qcr-remark" class="form-control form-control-sm" value="${esc(defRemark)}">
      ${defRemark ? '<div class="form-text">ตั้งต้นจากน้ำหนัก/ภาชนะที่บันทึกตอนรับเข้า (แก้ได้)</div>' : ''}`,
    preConfirm() {
      const n = parseInt(document.getElementById('qcr-n').value, 10);
      if (!(n >= 1 && n <= 200)) { Dlg.invalid('กรอกจำนวนดวง 1–200'); return false; }
      return { n, remark: document.getElementById('qcr-remark').value.trim() };
    } });
  if (!r.isConfirmed) return;
  const dmy = x => { const p = String(x || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''; };
  const my = x => { const p = String(x || '').slice(0, 10).split('-'); return p.length === 3 ? `${p[1]}/${p[0]}` : ''; };
  const data = { rm: rm?.Category !== CAT_PKG, pm: rm?.Category === CAT_PKG, code: lot.RM_ID, name: rm?.RM_Name || lot.RM_ID, lot: _lotLabel(lot),
    mfg: dmy(rec?.HarvestDate), exp: my(lot.ExpDate), date: dmy(insp?.InspectedAt ? new Date(new Date(insp.InspectedAt).getTime() + 7 * 3600000).toISOString() : todayStr()), remark: r.value.remark };
  const sheets = Math.ceil(r.value.n / 10); let html = '', k = 0;
  for (let s = 0; s < sheets; s++) {
    let st = '';
    for (let i = 0; i < 10; i++, k++) st += `<div class="qcr-sticker">${_qcRelSticker(k < r.value.n ? data : { rm: false, pm: false })}</div>`;
    html += `<div class="qcr-sheet">${st}</div>`;
  }
  document.getElementById('qc-print-root')?.remove();
  const root = document.createElement('div'); root.id = 'qc-print-root'; root.innerHTML = html; document.body.appendChild(root);
  document.body.classList.add('print-qclabel');
  const done = () => { document.body.classList.remove('print-qclabel'); root.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

// ── หน้า QC (ฉีด DOM เอง ไม่ต้องแก้โครงหน้าใน index.html) ──
function _qcEnsurePage() {
  if (document.getElementById('page-qc')) return;
  const host = document.getElementById('page-stockmove')?.parentNode; if (!host) return;
  const st = document.createElement('style');
  st.textContent = `
    #page-qc .qc-tabs .btn { border-radius: 999px; }
    #qc-print-root { display: none; }
    @media print {
      body.print-qclabel { background: #fff !important; display: block !important; height: auto !important; overflow: visible !important; }
      body.print-qclabel > *:not(#qc-print-root) { display: none !important; }
      body.print-qclabel #qc-print-root { display: block !important; }
      @page qclabel { size: A5 landscape; margin: 8mm; }
      @page qcrel { size: A4; margin: 0; }
      .qcl { page: qclabel; } .qcr-sheet { page: qcrel; box-shadow: none !important; margin: 0 !important; }
    }
    /* ป้าย "ผ่าน" = ใบ Released สติกเกอร์เขียวแบบ ProFlow (ดวง 7.5×4.5 ซม. · 2×5 = 10 ดวง/แผ่น A4) */
    .qcr-sheet { width: 210mm; min-height: 297mm; background: #fff; box-sizing: border-box; padding: 7mm; display: grid;
      grid-template-columns: repeat(2, 75mm); grid-template-rows: repeat(5, 45mm); gap: 5mm; justify-content: center; align-content: center;
      page-break-after: always; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .qcr-sheet:last-child { page-break-after: auto; }
    .qcr-sticker { background: #92d050; border: 1.6px solid #141a0e; border-radius: 2px; padding: 1.6mm 2.2mm; display: flex; flex-direction: column;
      font-family: Sarabun, sans-serif; color: #12210a; overflow: hidden; }
    .qcr-formcode { font-size: 7px; text-align: right; letter-spacing: .01em; }
    .qcr-title { text-align: center; font-family: 'Times New Roman', Georgia, serif; font-weight: 700; font-size: 14.5px; margin: .2mm 0 .6mm; letter-spacing: .02em; }
    .qcr-checks { display: flex; justify-content: space-between; font-size: 7px; margin: 0 auto .7mm; width: 80%; }
    .qcr-checks span { display: inline-flex; align-items: center; gap: 2.5px; white-space: nowrap; }
    .qcr-checks .box { width: 7px; height: 7px; border: 1px solid #12210a; display: inline-block; text-align: center; line-height: 6px; font-size: 6px; }
    .qcr-checks .box.on { background: #12210a; color: #92d050; font-weight: 700; }
    .qcr-line { font-size: 9px; display: flex; gap: 2.5px; margin: .25mm 0; align-items: flex-end; }
    .qcr-line b { font-weight: 600; white-space: nowrap; }
    .qcr-line .val { flex: 1; border-bottom: .6px solid #12210a; min-height: 7px; padding-left: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qcr-line.split { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    .qcr-line.split > div { display: flex; gap: 3px; align-items: flex-end; }
    .qcr-line.emph .val, .qcr-line.split > div.emph .val { font-size: 9.5px; font-weight: 700; min-height: 1px; }
    .qcr-line .val.mid, .qcr-line.split > div.mid .val { font-size: 8.5px; min-height: 1px; }
    .qcr-line.split > div.sig .val { min-height: 8px; }
    .qcl { border: 6px solid; border-radius: 10px; padding: 12px 16px; font-family: inherit; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .qcl-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; border-bottom: 2px solid currentColor; padding-bottom: 6px; margin-bottom: 8px; }
    .qcl-word { font-size: 40px; font-weight: 800; letter-spacing: .04em; } .qcl-th { font-size: 20px; font-weight: 700; }
    .qcl-body { display: flex; justify-content: space-between; gap: 16px; font-size: 17px; line-height: 1.55; }
    .qcl-name { font-size: 26px; font-weight: 700; } .qcl-sm { font-size: 12px; color: #555; }
    .qcl-qr { width: 120px; height: 120px; align-self: center; }
    .qcl-foot { margin-top: 8px; font-size: 13px; font-weight: 700; text-align: right; }`;
  document.head.appendChild(st);
  const div = document.createElement('div'); div.className = 'page-view'; div.id = 'page-qc';
  div.innerHTML = `
    <div class="page-header d-flex justify-content-between align-items-start flex-wrap gap-2">
      <div><h4 class="mb-0 text-white"><i class="fa-solid fa-clipboard-check me-2"></i>ตรวจคุณภาพ (QC)</h4>
        <div class="text-white-50 small">ตรวจรับวัตถุดิบ / วัสดุบรรจุ — กักกัน → ผ่าน / ไม่ผ่าน (ผู้ตรวจ = แอดมิน)</div></div>
      <div class="d-flex gap-2 align-items-center" id="qcHeadTools"></div>
    </div>
    <div class="scroll-content">
      <div class="row g-3 mb-3" id="qcKpis"></div>
      <div id="qcNotReady"></div>
      <div class="d-flex flex-wrap gap-2 align-items-center mb-2 qc-tabs">
        <div class="btn-group" id="qcTabs">
          <button class="btn btn-sm btn-light" data-tab="pending" onclick="qcSetTab('pending')">รอตรวจ</button>
          <button class="btn btn-sm btn-light" data-tab="insp" onclick="qcSetTab('insp')">ผลตรวจทั้งหมด</button>
          <button class="btn btn-sm btn-light" data-tab="ncr" onclick="qcSetTab('ncr')">NCR (ไม่ผ่าน)</button>
        </div>
        <div class="btn-group" id="qcAgeTabs">
          <button class="btn btn-sm btn-outline-light" data-age="new" onclick="qcSetAge('new')">ล็อตใหม่ (ตั้งแต่ 1 ต.ค.)</button>
          <button class="btn btn-sm btn-outline-light" data-age="old" onclick="qcSetAge('old')">ล็อตเก่า (ก่อน 1 ต.ค.)</button>
          <button class="btn btn-sm btn-outline-light" data-age="all" onclick="qcSetAge('all')">ทั้งหมด</button>
        </div>
        <div class="search-wrap ms-auto"><input class="form-control search-input" id="qcSearch" placeholder="ค้นหา รหัส / ชื่อ / Lot / เลขใบ..." oninput="qcRender()"></div>
      </div>
      <div class="glass-card p-0 overflow-hidden"><div class="table-responsive"><table class="table table-hover mb-0 align-middle">
        <thead id="qcHead"></thead><tbody id="qcBody"></tbody></table></div></div>
      <div class="small text-white-50 mt-2" id="qcFoot"></div>
    </div>`;
  host.appendChild(div);
}
function qcSetTab(t) { _qcTab = t; _qcSel.clear(); qcRender(); }
function qcSetAge(a) { _qcAge = a; _qcSel.clear(); qcRender(); }
const _qcAgeOk = date => _qcAge === 'all' || (_qcAge === 'old') === _isRefDate(date);

async function qcPageLoad() {
  _qcEnsurePage();
  await rmLotLoad();                         // โหลดล็อต (และสถานะ QC ผ่านตัว hook ใน rmLotLoad)
  if (!_qcReady) await qcLoadStatus();
  const n = await _sb.from('qc_ncr').select('*').order('OpenedAt', { ascending: false });
  _qcNcr = n.error ? [] : (n.data || []);
  qcRender();
}
function qcRender() {
  _qcEnsurePage();
  const nr = document.getElementById('qcNotReady');
  if (!_qcReady) {
    nr.innerHTML = `<div class="glass-card"><div class="text-danger fw-semibold mb-1"><i class="fa-solid fa-triangle-exclamation me-1"></i>ยังไม่ได้ตั้งค่าระบบ QC</div>
      <div class="small text-muted">แอดมินต้องรัน <code>migration_2026-10-31_qc_phase1.sql</code> ใน Supabase SQL Editor แล้วรีเฟรชหน้านี้</div></div>`;
    document.getElementById('qcBody').innerHTML = ''; document.getElementById('qcKpis').innerHTML = ''; return;
  }
  nr.innerHTML = '';
  const pendAll = _qcPendingLots(), pendNew = pendAll.filter(l => !_isRefDate(l.ReceiveDate)).length;
  const lots = (_rmLotCache || []).filter(l => (+l.Qty || 0) > 0);
  const cnt = s => lots.filter(l => qcStatusOf(l.Lot_ID) === s).length;
  document.getElementById('qcKpis').innerHTML = [
    { n: pendAll.length, t: `รอตรวจ (ใหม่ ${pendNew} · เก่า ${pendAll.length - pendNew})` }, { n: cnt('PASS'), t: 'ผ่านแล้ว (ที่ยังมีของ)' },
    { n: cnt('REJECT'), t: 'ไม่ผ่าน (ที่ยังมีของ)' }, { n: _qcNcr.filter(x => x.Status === 'OPEN').length, t: 'NCR ที่ยังเปิดอยู่' },
  ].map(k => `<div class="col-6 col-md-3"><div class="kpi-card"><div class="kpi-num">${k.n}</div><div class="kpi-label">${k.t}</div></div></div>`).join('');
  document.querySelectorAll('#qcTabs button').forEach(b => { b.classList.toggle('btn-light', b.dataset.tab !== _qcTab); b.classList.toggle('btn-primary', b.dataset.tab === _qcTab); });
  document.querySelectorAll('#qcAgeTabs button').forEach(b => { b.classList.toggle('active', b.dataset.age === _qcAge); });
  document.getElementById('qcAgeTabs').style.display = _qcTab === 'pending' ? '' : 'none';
  document.getElementById('qcHeadTools').innerHTML = _qcAdmin()
    ? `<span class="small text-white-50">โหมดเบิก:</span><div class="btn-group btn-group-sm">
        <button class="btn ${_qcEnforce ? 'btn-outline-light' : 'btn-warning'}" onclick="qcSetEnforce(false)" title="เตือนแล้วเบิกต่อได้">เตือน</button>
        <button class="btn ${_qcEnforce ? 'btn-danger' : 'btn-outline-light'}" onclick="qcSetEnforce(true)" title="บล็อกล็อตที่ยังไม่ผ่าน">บล็อก</button></div>`
    : `<span class="badge text-bg-light">โหมดเบิก: ${_qcEnforce ? 'บล็อก' : 'เตือน'}</span>`;
  const term = (document.getElementById('qcSearch').value || '').trim().toLowerCase();
  const hit = (...xs) => !term || xs.join(' ').toLowerCase().includes(term);
  if (_qcTab === 'pending') _qcRenderPending(pendAll, hit); else if (_qcTab === 'insp') _qcRenderInsp(hit); else _qcRenderNcr(hit);
}
function _qcRenderPending(pendAll, hit) {
  const admin = _qcAdmin();
  const rows = pendAll.filter(l => _qcAgeOk(l.ReceiveDate) && hit(l.RM_ID, _rmName(l.RM_ID), l.Lot, l.Lot_ID))
    .sort((a, b) => String(b.ReceiveDate || '').localeCompare(String(a.ReceiveDate || '')));
  document.getElementById('qcHead').innerHTML = `<tr>${admin ? '<th style="width:36px"><input type="checkbox" class="form-check-input" onchange="qcSelAll(this.checked)" title="เลือกทั้งหมดที่แสดง"></th>' : ''}
    <th>วัตถุดิบ</th><th>Lot</th><th class="text-end">คงเหลือ</th><th>วันรับ</th><th>หมดอายุ</th><th class="text-center">จัดการ</th></tr>`;
  document.getElementById('qcBody').innerHTML = rows.map(l => `<tr>
    ${admin ? `<td><input type="checkbox" class="form-check-input" ${_qcSel.has(l.Lot_ID) ? 'checked' : ''} onchange="qcSel('${esc(l.Lot_ID)}', this.checked)"></td>` : ''}
    <td class="fw-semibold">${esc(_rmName(l.RM_ID))} <span class="text-muted small">${esc(l.RM_ID)}</span></td>
    <td title="${esc(l.Lot_ID)}">${esc(_lotLabel(l))}${_isRefDate(l.ReceiveDate) ? ' <span class="badge bg-light text-dark border">ล็อตเก่า</span>' : ''}</td>
    <td class="text-end">${_rmFmtQty(+l.Qty || 0)} ${esc(l.Unit || '')}</td>
    <td>${fmtDate(l.ReceiveDate)}</td><td>${l.ExpDate ? fmtDate(l.ExpDate) : '-'}</td>
    <td class="text-center text-nowrap">
      ${admin ? `<button class="btn btn-sm btn-success" onclick="qcInspect('${esc(l.Lot_ID)}')"><i class="fa-solid fa-clipboard-check me-1"></i>ตรวจ</button>` : ''}
      <button class="btn btn-sm btn-outline-secondary" onclick="qcPrintLabel('${esc(l.Lot_ID)}')" title="พิมพ์ป้ายกักกัน"><i class="fa-solid fa-print"></i></button></td></tr>`).join('')
    || `<tr><td colspan="${admin ? 7 : 6}" class="text-center text-muted py-4">ไม่มีล็อตที่รอตรวจในหมวดนี้</td></tr>`;
  document.getElementById('qcFoot').innerHTML = (admin && rows.length
    ? `<button class="btn btn-sm btn-light me-2" onclick="qcBulkPass()" ${_qcSel.size ? '' : 'disabled'}><i class="fa-solid fa-check-double me-1"></i>ตรวจผ่านแบบรวม (${_qcSel.size} ล็อต)</button>` : '')
    + `แสดง ${rows.length} ล็อต · ล็อตที่ไม่มีใบตรวจนับเป็น "รอตรวจ" ทุกล็อต รวมของก่อน 1 ต.ค. 2569`;
}
function qcSel(id, on) { on ? _qcSel.add(id) : _qcSel.delete(id); qcRender(); }
function qcSelAll(on) {
  const rows = _qcPendingLots().filter(l => _qcAgeOk(l.ReceiveDate));
  rows.forEach(l => on ? _qcSel.add(l.Lot_ID) : _qcSel.delete(l.Lot_ID)); qcRender();
}
function _qcRenderInsp(hit) {
  document.getElementById('qcHead').innerHTML = '<tr><th>เลขใบตรวจ</th><th>วันที่</th><th>วัตถุดิบ</th><th>Lot</th><th>ผล</th><th>ผู้ตรวจ</th><th>เหตุผล / หมายเหตุ</th><th class="text-center">ป้าย</th></tr>';
  const rows = _qcInsp.filter(r => hit(r.Insp_ID, r.RM_ID, _rmName(r.RM_ID), r.LotNo, r.Lot_ID, r.InspectedBy));
  document.getElementById('qcBody').innerHTML = rows.slice(0, 300).map(r => `<tr>
    <td class="fw-semibold">${esc(r.Insp_ID)}</td><td>${fmtDate(r.InspectedAt)}</td>
    <td>${esc(_rmName(r.RM_ID))} <span class="text-muted small">${esc(r.RM_ID || '')}</span></td><td>${esc(r.LotNo || r.Lot_ID)}</td>
    <td>${r.Result === 'PASS' ? '<span class="badge text-bg-success">ผ่าน</span>' : '<span class="badge text-bg-danger">ไม่ผ่าน</span>'}${_qcLatest[r.Lot_ID]?.Insp_ID !== r.Insp_ID ? ' <span class="badge bg-light text-dark border" title="มีการตรวจใหม่กว่านี้แล้ว">เก่า</span>' : ''}</td>
    <td>${esc(r.InspectedBy || '-')}</td><td class="small">${esc([r.Reason, r.Note].filter(Boolean).join(' · ') || '-')}</td>
    <td class="text-center">${_rmLotCache.some(l => l.Lot_ID === r.Lot_ID) ? `<button class="btn btn-sm btn-outline-secondary" onclick="qcPrintLabel('${esc(r.Lot_ID)}')"><i class="fa-solid fa-print"></i></button>` : '<span class="text-muted small">หมดสต็อก</span>'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="text-center text-muted py-4">ยังไม่มีใบตรวจ</td></tr>';
  document.getElementById('qcFoot').textContent = `ทั้งหมด ${rows.length} ใบ${rows.length > 300 ? ' (แสดง 300 ใบล่าสุด)' : ''}`;
}
function _qcRenderNcr(hit) {
  const admin = _qcAdmin();
  document.getElementById('qcHead').innerHTML = '<tr><th>เลข NCR</th><th>วันที่เปิด</th><th>วัตถุดิบ</th><th>Lot</th><th class="text-end">จำนวน</th><th>เหตุผล</th><th>ทางจัดการ</th><th>สถานะ</th><th class="text-center">จัดการ</th></tr>';
  const rows = _qcNcr.filter(r => hit(r.NCR_ID, r.Insp_ID, r.RM_ID, _rmName(r.RM_ID), r.LotNo, r.Reason));
  document.getElementById('qcBody').innerHTML = rows.map(r => `<tr>
    <td class="fw-semibold">${esc(r.NCR_ID)}<div class="small text-muted">${esc(r.Insp_ID || '')}</div></td><td>${fmtDate(r.OpenedAt)}</td>
    <td>${esc(_rmName(r.RM_ID))} <span class="text-muted small">${esc(r.RM_ID || '')}</span></td><td>${esc(r.LotNo || r.Lot_ID)}</td>
    <td class="text-end">${_rmFmtQty(+r.Qty || 0)}</td><td class="small">${esc(r.Reason || '-')}</td>
    <td>${r.Disposition ? esc(QC_DISP[r.Disposition]) : '<span class="text-danger small">ยังไม่เลือก</span>'}${r.Action ? `<div class="small text-muted">${esc(r.Action)}</div>` : ''}</td>
    <td>${r.Status === 'CLOSED' ? '<span class="badge text-bg-secondary">ปิดแล้ว</span>' : '<span class="badge text-bg-warning">เปิดอยู่</span>'}</td>
    <td class="text-center">${admin ? `<button class="btn btn-sm btn-outline-primary" onclick="qcNcrEdit('${esc(r.NCR_ID)}')"><i class="fa-solid fa-pen"></i></button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="9" class="text-center text-muted py-4">ยังไม่มี NCR</td></tr>';
  document.getElementById('qcFoot').textContent = `ทั้งหมด ${rows.length} ใบ · ไม่ผ่าน = ย้ายของไป Rejected Area ด้วยมือ ระบบยังไม่ตัดสต็อกให้ (เฟสถัดไป)`;
}

async function qcSetEnforce(on) {
  if (!_qcAdmin() || on === _qcEnforce) return;
  const c = await Swal.fire({ icon: on ? 'warning' : 'question', title: on ? 'เปิดโหมดบล็อก?' : 'กลับไปโหมดเตือน?',
    html: on ? 'ล็อตที่ยังไม่ผ่าน QC จะ <b>เบิกไม่ได้เลย</b> (รวมล็อตเก่าก่อน 1 ต.ค. ที่ยังไม่ได้ตรวจ) — ควรตรวจล็อตที่ยังมีของให้ครบก่อน' : 'ล็อตที่ยังไม่ผ่านจะขึ้นเตือน แต่เบิกต่อได้',
    showCancelButton: true, confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' });
  if (!c.isConfirmed) return;
  const { data, error } = await _sb.from('qc_settings').update({ Enforce: on, UpdatedAt: new Date().toISOString() }).eq('id', 1).select();
  if (error || !data?.length) { Swal.fire('เปลี่ยนโหมดไม่สำเร็จ', error?.message || 'ไม่มีสิทธิ์ (ต้องเป็นแอดมิน)', 'error'); return; }
  _qcEnforce = on; qcRender();
}

// ── ตรวจ 1 ล็อต ──
async function qcInspect(lotId) {
  const lot = _rmLotCache.find(l => l.Lot_ID === lotId); if (!lot) return;
  const prev = _qcLatest[lotId];
  const r = await Dlg.form({
    title: '<i class="fa-solid fa-clipboard-check me-2"></i>ตรวจรับ', width: 560, confirmText: 'บันทึกผลตรวจ',
    html: `<div class="p-2 mb-3 rounded bg-light small"><div class="fw-semibold fs-6">${esc(_rmName(lot.RM_ID))} <span class="text-muted">${esc(lot.RM_ID)}</span></div>
        Lot <b>${esc(_lotLabel(lot))}</b> · คงเหลือ <b>${_rmFmtQty(+lot.Qty || 0)} ${esc(lot.Unit || '')}</b> · รับ ${fmtDate(lot.ReceiveDate)} · หมดอายุ ${lot.ExpDate ? fmtDate(lot.ExpDate) : '-'}
        ${prev ? `<div class="text-muted">ตรวจครั้งก่อน: ${esc(prev.Insp_ID)} (${prev.Result === 'PASS' ? 'ผ่าน' : 'ไม่ผ่าน'}) — ครั้งนี้จะแทนที่</div>` : ''}</div>
      <div class="fw-semibold mb-1">เช็กลิสต์ตรวจรับ</div>
      <div class="d-flex flex-column gap-1 mb-3" id="qci-checks">${QC_CHECKS.map((t, i) => `<label class="d-flex align-items-center gap-2 p-2 border rounded" style="cursor:pointer">
        <input type="checkbox" class="form-check-input mt-0 qci-chk" style="width:20px;height:20px" data-i="${i}"> ${esc(t)}</label>`).join('')}</div>
      <div class="fw-semibold mb-1">ผลการตรวจ</div>
      <div class="btn-group w-100 mb-2" role="group">
        <input type="radio" class="btn-check" name="qci-res" id="qci-pass" value="PASS" autocomplete="off" checked><label class="btn btn-outline-success py-2" for="qci-pass">ผ่าน</label>
        <input type="radio" class="btn-check" name="qci-res" id="qci-rej" value="REJECT" autocomplete="off"><label class="btn btn-outline-danger py-2" for="qci-rej">ไม่ผ่าน</label></div>
      <div id="qci-rejbox" class="d-none border border-danger-subtle rounded p-2 mb-2">
        <label class="form-label small mb-1">เหตุผลที่ไม่ผ่าน <span class="text-danger">*</span></label><textarea id="qci-reason" class="form-control form-control-sm mb-2" rows="2"></textarea>
        <label class="form-label small mb-1">ทางจัดการเบื้องต้น (เลือกทีหลังที่ NCR ได้)</label>
        <select id="qci-disp" class="form-select form-select-sm"><option value="">— ยังไม่เลือก —</option>${Object.entries(QC_DISP).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></div>
      <label class="form-label small mb-1">หมายเหตุ</label><input id="qci-note" class="form-control form-control-sm">`,
    didOpen(el) {
      const sync = () => el.querySelector('#qci-rejbox').classList.toggle('d-none', el.querySelector('input[name=qci-res]:checked').value !== 'REJECT');
      el.querySelectorAll('input[name=qci-res]').forEach(i => i.addEventListener('change', sync));
    },
    async preConfirm() {
      const g = id => document.getElementById(id);
      const res = document.querySelector('input[name=qci-res]:checked').value;
      const checks = [...document.querySelectorAll('.qci-chk')].map(c => ({ label: QC_CHECKS[+c.dataset.i], ok: c.checked }));
      if (res === 'PASS' && checks.some(c => !c.ok)) { Dlg.invalid('จะให้ "ผ่าน" ต้องติ๊กเช็กลิสต์ครบทุกข้อ — ถ้าข้อไหนไม่ผ่านให้เลือก "ไม่ผ่าน"'); return false; }
      const reason = g('qci-reason').value.trim();
      if (res === 'REJECT' && !reason) { Dlg.invalid('กรอกเหตุผลที่ไม่ผ่าน'); return false; }
      const { data, error } = await _sb.rpc('qc_inspect_post', { p_lot_ids: [lotId], p_result: res, p_checks: checks, p_reason: reason || null,
        p_note: g('qci-note').value.trim() || null, p_disposition: res === 'REJECT' ? (g('qci-disp').value || null) : null, p_by: _qcMe() });
      if (error) { Dlg.invalid(error.code === 'PGRST202' ? 'ยังไม่ได้รัน migration_2026-10-31_qc_phase1.sql' : error.message); return false; }
      return { res, doc: data?.[0] };
    },
  });
  if (!r.isConfirmed) return;
  await qcPageLoad();
  const pr = await Swal.fire({ icon: r.value.res === 'PASS' ? 'success' : 'warning',
    title: `บันทึกใบตรวจ ${esc(r.value.doc?.insp_id || '')} แล้ว`,
    html: r.value.res === 'PASS' ? 'ล็อตนี้ผ่าน — เบิกใช้ได้ · ติดป้ายเขียวที่ภาชนะ'
      : `ไม่ผ่าน — เปิด <b>${esc(r.value.doc?.ncr_id || 'NCR')}</b> แล้ว · ติดป้ายแดงและย้ายของไป Rejected Area`,
    showCancelButton: true, confirmButtonText: `พิมพ์ป้าย${r.value.res === 'PASS' ? 'เขียว' : 'แดง'}`, cancelButtonText: 'ปิด' });
  if (pr.isConfirmed) qcPrintLabel(lotId);
}

// ── ตรวจผ่านแบบรวม (ใช้กับล็อตเก่าก่อน 1 ต.ค. ที่ตรวจสภาพจริงแล้ว) ──
async function qcBulkPass() {
  if (!_qcSel.size) return;
  const ids = [..._qcSel];
  const r = await Dlg.form({ title: '<i class="fa-solid fa-check-double me-2"></i>ตรวจผ่านแบบรวม', width: 480, confirmText: `ผ่านทั้ง ${ids.length} ล็อต`,
    html: `<p class="small">ออกใบตรวจ <b>"ผ่าน"</b> ให้ <b>${ids.length} ล็อต</b> ที่เลือก (1 ล็อต = 1 ใบตรวจ) ใช้เมื่อได้ตรวจสภาพจริงของล็อตเหล่านี้แล้ว เช่น ล็อตเก่าก่อน 1 ต.ค.</p>
      <label class="form-label small mb-1">หมายเหตุ <span class="text-danger">*</span></label>
      <input id="qcb-note" class="form-control form-control-sm mb-2" value="ตรวจแบบรวม (ล็อตเก่า)">
      <label class="d-flex align-items-center gap-2 small"><input type="checkbox" class="form-check-input mt-0" id="qcb-ok"> ยืนยันว่าตรวจสภาพจริงของทุกล็อตที่เลือกแล้ว</label>`,
    async preConfirm() {
      const note = document.getElementById('qcb-note').value.trim();
      if (!note) { Dlg.invalid('กรอกหมายเหตุ'); return false; }
      if (!document.getElementById('qcb-ok').checked) { Dlg.invalid('ติ๊กยืนยันว่าตรวจสภาพจริงแล้ว'); return false; }
      const { error } = await _sb.rpc('qc_inspect_post', { p_lot_ids: ids, p_result: 'PASS', p_checks: [{ label: 'ตรวจแบบรวม (ตรวจสภาพจริงแล้ว)', ok: true }],
        p_reason: null, p_note: note, p_disposition: null, p_by: _qcMe() });
      if (error) { Dlg.invalid(error.message); return false; }
      return true;
    } });
  if (!r.isConfirmed) return;
  _qcSel.clear(); await qcPageLoad();
  Swal.fire({ toast: true, position: 'top-end', icon: 'success', title: `ตรวจผ่าน ${ids.length} ล็อตแล้ว`, showConfirmButton: false, timer: 2200 });
}

// ── แก้ / ปิด NCR ──
async function qcNcrEdit(id) {
  const n = _qcNcr.find(x => x.NCR_ID === id); if (!n) return;
  const r = await Dlg.form({ title: `<i class="fa-solid fa-file-circle-exclamation me-2"></i>${esc(n.NCR_ID)}`, width: 500, confirmText: 'บันทึก',
    html: `<div class="small mb-2"><b>${esc(_rmName(n.RM_ID))}</b> · Lot ${esc(n.LotNo || n.Lot_ID)} · ${_rmFmtQty(+n.Qty || 0)}<br><span class="text-muted">เหตุผล: ${esc(n.Reason || '-')}</span></div>
      <label class="form-label small mb-1">ทางจัดการ</label>
      <select id="qcn-disp" class="form-select form-select-sm mb-2"><option value="">— ยังไม่เลือก —</option>${Object.entries(QC_DISP).map(([k, v]) => `<option value="${k}" ${n.Disposition === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <label class="form-label small mb-1">ผลการดำเนินการ / หมายเหตุ</label><textarea id="qcn-act" class="form-control form-control-sm mb-2" rows="2">${esc(n.Action || '')}</textarea>
      <label class="d-flex align-items-center gap-2 small"><input type="checkbox" class="form-check-input mt-0" id="qcn-close" ${n.Status === 'CLOSED' ? 'checked' : ''}> ปิด NCR (ดำเนินการเสร็จแล้ว)</label>`,
    async preConfirm() {
      const disp = document.getElementById('qcn-disp').value || null, close = document.getElementById('qcn-close').checked;
      if (close && !disp) { Dlg.invalid('ปิด NCR ต้องเลือกทางจัดการก่อน'); return false; }
      const { error } = await _sb.rpc('qc_ncr_update', { p_ncr_id: id, p_disposition: disp, p_action: document.getElementById('qcn-act').value.trim() || null, p_close: close, p_by: _qcMe() });
      if (error) { Dlg.invalid(error.message); return false; }
      return true;
    } });
  if (r.isConfirmed) await qcPageLoad();
}

// ── ลงทะเบียน ──
_qcEnsurePage();
PAGE_LOADERS.qc = qcPageLoad;
