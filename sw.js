/* ============================================================
   KEUANGANKU — sw.js (service worker)                  Tahap 1
   Tugasnya: membuat aplikasi bisa dipasang di layar utama dan
   tetap bisa DIBUKA saat sinyal hilang. Antrean transaksi
   offline baru ditambahkan di Tahap 4.

   Strategi:
   - File aplikasi sendiri  : ambil dari internet dulu (supaya
     pembaruan langsung terpakai), cadangan dari simpanan.
   - Chart.js & font        : simpanan dulu, lalu diperbarui.
   - Permintaan ke Apps Script (POST) tidak pernah disentuh.
   ============================================================ */
const SIMPANAN = 'keuanganku-v2';
const KERANGKA = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];
const LUAR = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SIMPANAN)
      .then((c) => Promise.all(KERANGKA.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nama) => Promise.all(nama.filter((n) => n !== SIMPANAN).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) { const salin = res.clone(); caches.open(SIMPANAN).then((c) => c.put(req, salin)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
    return;
  }

  if (LUAR.indexOf(url.hostname) >= 0) {
    e.respondWith(
      caches.match(req).then((ada) => {
        const baru = fetch(req).then((res) => {
          if (res && (res.ok || res.type === 'opaque')) { const salin = res.clone(); caches.open(SIMPANAN).then((c) => c.put(req, salin)); }
          return res;
        });
        if (ada) { baru.catch(() => {}); return ada; }
        return baru;
      })
    );
  }
});
