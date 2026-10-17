// BM Flow Handheld — service worker (2026-10-17)
// เป้าหมาย: ติดตั้งเป็นแอพได้ + เปิดเร็ว + เปิดหน้าแอพได้แม้สัญญาณหลุดชั่วคราว (แต่ข้อมูลสต็อก/การบันทึกต้องออนไลน์ — ตั้งใจไม่ทำ offline-write
// เพราะการเบิก/รับต้องตัดสต็อกตามล็อตจริงบนเซิร์ฟเวอร์ ทำซ้ำ/ทับกันได้ถ้าซิงก์ทีหลัง)
// • หน้า m.html: network-first (ได้เวอร์ชันล่าสุดเสมอเมื่อออนไลน์) แล้วสำรองจาก cache
// • ไลบรารี/ฟอนต์/ไอคอนจาก CDN + ไฟล์ static ของเรา: stale-while-revalidate
// • Supabase (*.supabase.co) และ method ที่ไม่ใช่ GET: ไม่แตะเลย (ผ่านตรง)
const CACHE = 'bmflow-m-v2';   // v2: ไอคอนเปลี่ยนเป็นโลโก้ Blooming (2026-10-17) — เปลี่ยนเลขเวอร์ชันเพื่อให้เครื่องที่เคยติดตั้งดึงไฟล์ใหม่
const SHELL = ['m.html', 'manifest.json', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;
  if (req.mode === 'navigate' || url.pathname.endsWith('/m.html')) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('m.html', copy)); return r; }).catch(() => caches.match('m.html')));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
