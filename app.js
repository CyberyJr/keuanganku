/* ============================================================
   KEUANGANKU — app.js                                  Tahap 1
   Input transaksi kilat, koneksi Google Sheets, dashboard dasar.
   Tidak ada URL API maupun token di file ini: keduanya hanya
   disimpan di perangkatmu setelah kamu menghubungkan aplikasi.
   ============================================================ */
(function () {
  'use strict';

  const VERSI = '1.0.0';
  const LS = { cfg: 'kk_cfg', data: 'kk_data', sinkron: 'kk_sinkron', sembunyi: 'kk_sembunyi', akunAkhir: 'kk_akun_akhir', demo: 'kk_demo' };
  const KELOMPOK_TABUNGAN = 'Tabungan & Investasi';
  const HARI = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  /* ==========================================================
     1. HITUNGAN (fungsi murni, tanpa menyentuh layar)
     ========================================================== */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dariYmd = (s) => { const p = String(s).split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); };
  const hariIni = () => ymd(new Date());
  const geserHari = (s, n) => { const d = dariYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

  const H = {
    ymd, dariYmd, geserHari,

    /** Periode gajian yang memuat tanggal acuan; geser = -1 untuk periode sebelumnya, dst. */
    periodeGajian(tglGajian, acuan, geser) {
      const tgl = Math.min(31, Math.max(1, Math.round(Number(tglGajian) || 1)));
      const hariGaji = (y, m) => Math.min(tgl, new Date(y, m + 1, 0).getDate());
      const a = dariYmd(acuan);
      let y = a.getFullYear(), m = a.getMonth();
      if (a.getDate() < hariGaji(y, m)) m -= 1;
      const awalBulan = new Date(y, m + (geser || 0), 1);
      y = awalBulan.getFullYear(); m = awalBulan.getMonth();
      const mulai = new Date(y, m, hariGaji(y, m));
      const bulanDepan = new Date(y, m + 1, 1);
      const berikut = new Date(bulanDepan.getFullYear(), bulanDepan.getMonth(), hariGaji(bulanDepan.getFullYear(), bulanDepan.getMonth()));
      berikut.setDate(berikut.getDate() - 1);
      return { mulai: ymd(mulai), akhir: ymd(berikut) };
    },

    /** Total pemasukan, pengeluaran, arus kas bersih, dan alokasi tabungan pada rentang tanggal. */
    ringkasan(transaksi, petaKategori, mulai, akhir) {
      const r = { masuk: 0, keluar: 0, bersih: 0, tabungan: 0, jumlah: 0, perKategori: {} };
      for (const t of transaksi) {
        if (!(t.tanggal >= mulai && t.tanggal <= akhir)) continue;
        const n = Number(t.nominal) || 0;
        r.jumlah++;
        if (t.jenis === 'Pemasukan') r.masuk += n;
        else if (t.jenis === 'Pengeluaran') { r.keluar += n; r.perKategori[t.kategori_id] = (r.perKategori[t.kategori_id] || 0) + n; }
        else if (t.jenis === 'Transfer') {
          const k = petaKategori[t.kategori_id];
          if (k && k.kelompok === KELOMPOK_TABUNGAN) r.tabungan += n;
        }
      }
      r.bersih = r.masuk - r.keluar;
      return r;
    },

    /** Saldo tiap akun = saldo awal + semua transaksi akun itu. */
    saldoAkun(akun, transaksi) {
      const s = {};
      for (const a of akun) s[a.id] = Number(a.saldo_awal) || 0;
      for (const t of transaksi) {
        const n = Number(t.nominal) || 0;
        if (t.jenis === 'Pemasukan') { if (t.akun_id in s) s[t.akun_id] += n; }
        else if (t.jenis === 'Pengeluaran') { if (t.akun_id in s) s[t.akun_id] -= n; }
        else if (t.jenis === 'Transfer') {
          if (t.akun_id in s) s[t.akun_id] -= n;
          if (t.akun_tujuan_id && t.akun_tujuan_id in s) s[t.akun_tujuan_id] += n;
        }
      }
      return s;
    },

    /** Deret harian pemasukan & pengeluaran untuk grafik garis. */
    deretHarian(transaksi, mulai, akhir) {
      const label = [], masuk = [], keluar = [], idx = {};
      for (let d = mulai, i = 0; d <= akhir && i < 400; d = geserHari(d, 1), i++) { idx[d] = i; label.push(d); masuk.push(0); keluar.push(0); }
      for (const t of transaksi) {
        const i = idx[t.tanggal];
        if (i === undefined) continue;
        if (t.jenis === 'Pemasukan') masuk[i] += Number(t.nominal) || 0;
        else if (t.jenis === 'Pengeluaran') keluar[i] += Number(t.nominal) || 0;
      }
      return { label, masuk, keluar };
    },

    /** Mengubah deret harian menjadi akumulasi sejak awal periode; hari setelah `batas` dikosongkan. */
    kumulatif(deret, batas) {
      let a = 0, b = 0; const masuk = [], keluar = [];
      deret.label.forEach((tgl, i) => {
        a += deret.masuk[i]; b += deret.keluar[i];
        const depan = tgl > batas;
        masuk.push(depan ? null : a); keluar.push(depan ? null : b);
      });
      return { label: deret.label, masuk, keluar };
    },

    /** Perubahan dalam persen dibanding periode lalu; null bila periode lalu nol. */
    persenUbah(kini, lalu) {
      if (!lalu) return null;
      return ((kini - lalu) / Math.abs(lalu)) * 100;
    },

    progresGoal(goals, setoran) {
      const terkumpul = {};
      for (const s of setoran || []) terkumpul[s.goal_id] = (terkumpul[s.goal_id] || 0) + (Number(s.nominal) || 0);
      const bobot = { Tinggi: 0, Sedang: 1, Rendah: 2 };
      return (goals || [])
        .filter((g) => !g.status || g.status === 'Aktif')
        .map((g) => {
          const target = Number(g.target) || 0, ada = terkumpul[g.id] || 0;
          return Object.assign({}, g, { terkumpul: ada, persen: target > 0 ? Math.min(100, (ada / target) * 100) : 0 });
        })
        .sort((a, b) => ((bobot[a.prioritas] ?? 1) - (bobot[b.prioritas] ?? 1)) || ((a.urutan || 0) - (b.urutan || 0)));
    },

    urutTerbaru(transaksi) {
      return transaksi.slice().sort((a, b) => (a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : String(b.dibuat || '').localeCompare(String(a.dibuat || ''))));
    },

    rupiah(n) {
      n = Math.round(Number(n) || 0);
      return (n < 0 ? '-' : '') + 'Rp ' + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    },

    rupiahPendek(n) {
      const a = Math.abs(n), t = n < 0 ? '-' : '';
      const f = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
      if (a >= 1e9) return t + f(a / 1e9) + ' M';
      if (a >= 1e6) return t + f(a / 1e6) + ' jt';
      if (a >= 1e3) return t + f(a / 1e3) + ' rb';
      return t + a;
    },

    angkaDariTeks(s) { return Number(String(s || '').replace(/\D/g, '')) || 0; },
    ribuan(n) { return n ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : ''; }
  };

  // Agar hitungan bisa diuji di luar browser.
  if (typeof module !== 'undefined' && module.exports) { module.exports = H; if (typeof document === 'undefined') return; }

  /* ==========================================================
     2. ALAT BANTU
     ========================================================== */
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baca = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const tulis = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* penyimpanan penuh / mode privat */ } };
  const buang = (k) => { try { localStorage.removeItem(k); } catch (e) { /* abaikan */ } };
  const tglPanjang = (s) => { const d = dariYmd(s); return HARI[d.getDay()] + ', ' + d.getDate() + ' ' + BULAN[d.getMonth()] + ' ' + d.getFullYear(); };
  const tglPendek = (s) => { const d = dariYmd(s); return d.getDate() + ' ' + BULAN[d.getMonth()]; };
  const tglRentang = (a, b) => tglPendek(a) + ' – ' + tglPendek(b) + ' ' + dariYmd(b).getFullYear();
  const idBaru = () => 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const JALUR = {
    beranda: '<path d="M3 10.6 12 3l9 7.6"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h3.8v-6h3.4v6h3.8a1 1 0 0 0 1-1V9.5"/>',
    riwayat: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    tambah: '<path d="M12 5v14M5 12h14"/>',
    goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    lainnya: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    mata: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    mataTutup: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.5 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.5 4.5-1.200"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    segarkan: '<path d="M20 11a8 8 0 0 0-14.3-4.500L4 8.500"/><path d="M4 4v4.500h4.500"/><path d="M4 13a8 8 0 0 0 14.3 4.500L20 15.500"/><path d="M20 20v-4.500h-4.500"/>',
    kiri: '<path d="m15 5-7 7 7 7"/>',
    kanan: '<path d="m9 5 7 7-7 7"/>',
    tutup: '<path d="M6 6l12 12M18 6 6 18"/>',
    cari: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.600-3.600"/>',
    sampah: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'
  };
  const ikon = (n) => '<svg class="ik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + JALUR[n] + '</svg>';

  class Galat extends Error { constructor(kode, pesan) { super(pesan); this.kode = kode; } }

  /* ==========================================================
     3. KEADAAN APLIKASI
     ========================================================== */
  const S = {
    cfg: baca(LS.cfg, null),            // { url, token } atau { demo: true }
    data: baca(LS.data, null),          // salinan data terakhir dari server
    terakhirSinkron: baca(LS.sinkron, 0),
    sembunyi: baca(LS.sembunyi, false),
    halaman: 'beranda',
    geser: 0,                           // 0 = periode gajian berjalan
    sinkron: 'diam',                    // diam | jalan | gagal
    tunda: new Map(),                   // perubahan yang sedang dikirim ke server
    saring: { teks: '', jenis: 'Semua', batas: 80 },
    grafik: []
  };

  const rp = (n) => (S.sembunyi ? 'Rp •••••' : H.rupiah(n));
  const petaKategori = () => { const m = {}; for (const k of S.data.kategori) m[k.id] = k; return m; };
  const petaAkun = () => { const m = {}; for (const a of S.data.akun) m[a.id] = a; return m; };
  const tglGajian = () => Number(S.data && S.data.pengaturan && S.data.pengaturan.tanggal_gajian) || 1;

  /* ==========================================================
     4. KOMUNIKASI DENGAN SERVER
     ========================================================== */
  async function panggil(aksi, payload, cfg) {
    cfg = cfg || S.cfg;
    if (cfg.demo) return Demo.panggil(aksi, payload || {});
    const kendali = new AbortController();
    const waktuHabis = setTimeout(() => kendali.abort(), 30000);
    let res;
    try {
      res = await fetch(cfg.url, {
        method: 'POST',
        // text/plain = "permintaan sederhana", sehingga Apps Script menerimanya tanpa preflight CORS.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: cfg.token, action: aksi, payload: payload || {} }),
        redirect: 'follow',
        signal: kendali.signal
      });
    } catch (e) {
      throw new Galat('JARINGAN', navigator.onLine === false ? 'Tidak ada sinyal internet.' : 'Tidak bisa terhubung ke server. Periksa internet dan URL API.');
    } finally { clearTimeout(waktuHabis); }
    let j;
    try { j = await res.json(); } catch (e) {
      throw new Galat('RESPON', 'Jawaban server tidak terbaca. Periksa URL API dan pastikan deploy memakai akses "Siapa saja".');
    }
    if (!j.ok) throw new Galat(j.code || 'GALAT', j.error || 'Terjadi kesalahan.');
    return j.data;
  }

  // Semua panggilan dijalankan berurutan supaya data yang dibaca selalu sudah memuat tulisan sebelumnya.
  let rantai = Promise.resolve();
  function antre(fn) {
    const p = rantai.then(fn, fn);
    rantai = p.catch(() => {});
    return p;
  }

  function terapkanData(d) {
    // Pasang kembali perubahan yang masih dalam perjalanan ke server.
    for (const op of S.tunda.values()) terapkanLokal(d.transaksi, op);
    S.data = d;
    S.terakhirSinkron = Date.now();
    simpanCache(); tulis(LS.sinkron, S.terakhirSinkron);
  }

  /** Salinan di perangkat tidak memuat perubahan yang belum dipastikan server. */
  function simpanCache() {
    tulis(LS.data, Object.assign({}, S.data, { transaksi: S.data.transaksi.filter((t) => !t._tunda) }));
  }

  function terapkanLokal(daftar, op) {
    const i = daftar.findIndex((t) => t.id === op.t.id);
    if (op.mode === 'hapus') { if (i >= 0) daftar.splice(i, 1); }
    else if (i >= 0) daftar[i] = op.t;
    else daftar.push(op.t);
  }

  async function sinkronkan(opsi) {
    opsi = opsi || {};
    if (S.sinkron === 'jalan') return;
    S.sinkron = 'jalan'; tandaiSinkron();
    try {
      const d = await antre(() => panggil('muat'));
      terapkanData(d);
      S.sinkron = 'diam';
      gambar();
      if (opsi.kabari) toast('Data sudah yang terbaru');
    } catch (e) {
      S.sinkron = 'gagal'; tandaiSinkron();
      if (e.kode === 'TOKEN_SALAH') toast('Token ditolak server. Hubungkan ulang dari menu Lainnya.', 'galat');
      else if (!opsi.diam || !S.data) toast(e.message + (S.data ? ' Menampilkan data terakhir.' : ''), 'galat');
      if (!S.data) gambar();
    }
  }

  function tandaiSinkron() {
    const t = $('#tbl-segarkan');
    if (t) t.classList.toggle('berputar', S.sinkron === 'jalan');
  }

  /** Simpan (tambah/ubah) dengan tampilan langsung berubah, lalu kirim ke server. */
  async function simpanTransaksi(t, mode) {
    const daftar = S.data.transaksi;
    const lama = daftar.find((x) => x.id === t.id);
    const op = { mode, t: Object.assign({ dibuat: new Date().toISOString() }, lama, t, { _tunda: true }) };
    S.tunda.set(t.id, op);
    terapkanLokal(daftar, op);
    gambar();
    try {
      const r = await antre(() => panggil('transaksi.' + mode, t));
      S.tunda.delete(t.id);
      terapkanLokal(S.data.transaksi, { mode, t: r.transaksi });
      simpanCache();
      gambar();
      toast('Tersimpan · ' + rp(t.nominal));
    } catch (e) {
      S.tunda.delete(t.id);
      const i = S.data.transaksi.findIndex((x) => x.id === t.id);
      if (i >= 0) { if (lama) S.data.transaksi[i] = lama; else S.data.transaksi.splice(i, 1); }
      gambar();
      toast('Gagal menyimpan: ' + e.message, 'galat');
      bukaForm(t, mode);       // isian tidak hilang; tinggal tekan Simpan lagi
    }
  }

  async function hapusTransaksi(t) {
    const op = { mode: 'hapus', t };
    S.tunda.set(t.id, op);
    terapkanLokal(S.data.transaksi, op);
    gambar();
    try {
      await antre(() => panggil('transaksi.hapus', { id: t.id }));
      S.tunda.delete(t.id);
      simpanCache();
      toast('Transaksi dihapus');
    } catch (e) {
      S.tunda.delete(t.id);
      S.data.transaksi.push(t);
      gambar();
      toast('Gagal menghapus: ' + e.message, 'galat');
    }
  }

  /* ==========================================================
     5. MODE DEMO (data contoh, hanya di perangkat ini)
     ========================================================== */
  const Demo = {
    data() {
      let d = baca(LS.demo, null);
      if (d) return d;
      const kat = [
        ['makan', 'Makan', 'Pengeluaran', 'Kebutuhan', '🍚'], ['transportasi', 'Transportasi', 'Pengeluaran', 'Kebutuhan', '🚌'],
        ['kos-sewa', 'Kos/Sewa', 'Pengeluaran', 'Kebutuhan', '🏠'], ['tagihan-pulsa', 'Tagihan & Pulsa', 'Pengeluaran', 'Kebutuhan', '💡'],
        ['kesehatan', 'Kesehatan', 'Pengeluaran', 'Kebutuhan', '💊'], ['keluarga', 'Keluarga', 'Pengeluaran', 'Kebutuhan', '👪'],
        ['zakat-sosial', 'Zakat/Sosial', 'Pengeluaran', 'Kebutuhan', '🤲'], ['jajan-kopi', 'Jajan & Kopi', 'Pengeluaran', 'Keinginan', '☕'],
        ['hiburan', 'Hiburan', 'Pengeluaran', 'Keinginan', '🎬'], ['belanja', 'Belanja', 'Pengeluaran', 'Keinginan', '🛍️'],
        ['hobi', 'Hobi', 'Pengeluaran', 'Keinginan', '🎮'], ['liburan', 'Liburan', 'Pengeluaran', 'Keinginan', '✈️'],
        ['langganan', 'Langganan', 'Pengeluaran', 'Keinginan', '📺'], ['lain-lain', 'Lain-lain', 'Pengeluaran', 'Keinginan', '📦'],
        ['inv-saham', 'Saham', 'Transfer', KELOMPOK_TABUNGAN, '📈'], ['inv-emas', 'Emas', 'Transfer', KELOMPOK_TABUNGAN, '🪙'],
        ['tabungan', 'Tabungan', 'Transfer', KELOMPOK_TABUNGAN, '🐷'], ['dana-darurat', 'Dana Darurat', 'Transfer', KELOMPOK_TABUNGAN, '🛟'],
        ['pindah-dana', 'Pindah Antar Akun', 'Transfer', 'Netral', '🔁'], ['gaji', 'Gaji', 'Pemasukan', '', '💼'],
        ['bonus-thr', 'Bonus/THR', 'Pemasukan', '', '🎁'], ['sampingan', 'Sampingan', 'Pemasukan', '', '🧰'], ['pemasukan-lain', 'Pemasukan Lain', 'Pemasukan', '', '➕']
      ].map((k, i) => ({ id: k[0], nama: k[1], jenis: k[2], kelompok: k[3], ikon: k[4], urutan: i + 1, aktif: true }));
      const akun = [['bca', 'BCA', 'Bank', 300000, '🏦'], ['bni', 'BNI', 'Bank', 2300000, '🏦'], ['tunai', 'Tunai (dompet)', 'Tunai', 0, '💵']]
        .map((a, i) => ({ id: a[0], nama: a[1], tipe: a[2], saldo_awal: a[3], ikon: a[4], urutan: i + 1, aktif: true, dana_darurat: false }));
      const goals = [
        ['G-mobil', 'Mobil', '🚗', 'Tinggi', 300000000, '2030-12-31'], ['G-menikah', 'Menikah', '💍', 'Tinggi', 300000000, '2031-12-31'],
        ['G-dana-darurat', 'Dana Darurat', '🛟', 'Tinggi', 24000000, ''], ['G-rumah', 'Rumah (DP)', '🏡', 'Sedang', 400000000, '']
      ].map((g, i) => ({ id: g[0], nama: g[1], ikon: g[2], prioritas: g[3], target: g[4], target_tanggal: g[5], status: 'Aktif', urutan: i + 1 }));

      // Transaksi contoh: dua periode gajian terakhir, acak tetapi selalu sama.
      let benih = 7; const acak = () => { benih = (benih * 16807) % 2147483647; return benih / 2147483647; };
      const tx = []; const hariAkhir = hariIni();
      const p0 = H.periodeGajian(25, hariAkhir, -1).mulai;
      const tambah = (tanggal, jenis, nominal, kategori_id, akun_id, catatan, tujuan) => tx.push({
        id: 'D' + tx.length.toString(36).padStart(7, '0'), tanggal, jenis, nominal, kategori_id, akun_id, akun_tujuan_id: tujuan || '', goal_id: '', catatan: catatan || '', dibuat: tanggal + 'T12:00:' + pad(tx.length % 60), diperbarui: ''
      });
      for (let d = p0; d <= hariAkhir; d = geserHari(d, 1)) {
        const tg = dariYmd(d).getDate();
        if (tg === 25) {
          tambah(d, 'Pemasukan', 10000000, 'gaji', 'bca', 'Gaji bulanan');
          tambah(d, 'Transfer', 1000000, 'tabungan', 'bca', 'Sisihkan di awal', 'bni');
          tambah(d, 'Transfer', 500000, 'inv-emas', 'bca', 'Beli emas digital');
          tambah(d, 'Transfer', 500000, 'inv-saham', 'bca', 'Top up RDN');
          tambah(d, 'Pengeluaran', 1800000, 'kos-sewa', 'bca', 'Kos bulan ini');
          tambah(d, 'Transfer', 1500000, 'pindah-dana', 'bca', 'Tarik tunai', 'tunai');
        }
        if (tg === 27) tambah(d, 'Pengeluaran', 350000, 'tagihan-pulsa', 'bca', 'Listrik & paket data');
        if (tg === 1) tambah(d, 'Pengeluaran', 54990, 'langganan', 'bca', 'Streaming');
        tambah(d, 'Pengeluaran', 20000 + Math.round(acak() * 9) * 5000, 'makan', acak() > .5 ? 'bca' : 'tunai', ['Makan siang', 'Warteg', 'Nasi padang', 'Makan malam'][Math.floor(acak() * 4)]);
        if (acak() > .35) tambah(d, 'Pengeluaran', 8000 + Math.round(acak() * 6) * 4000, 'transportasi', 'bca', 'Ojol');
        if (acak() > .6) tambah(d, 'Pengeluaran', 18000 + Math.round(acak() * 5) * 6000, 'jajan-kopi', 'bca', 'Kopi');
        if (acak() > .9) tambah(d, 'Pengeluaran', 150000 + Math.round(acak() * 8) * 50000, 'belanja', 'bca', 'Belanja bulanan');
        if (acak() > .93) tambah(d, 'Pengeluaran', 60000 + Math.round(acak() * 4) * 25000, 'hiburan', 'bca', 'Nonton');
      }
      d = {
        versi: 'demo', spreadsheet_url: '', pengaturan: { nama_panggilan: '', tanggal_gajian: 25, gaji_bulanan: 10000000, dana_darurat_kali: 3 },
        kategori: kat, akun, goals, anggaran: [],
        setoran: [{ id: 'S1', goal_id: 'G-dana-darurat', nominal: 3000000 }, { id: 'S2', goal_id: 'G-mobil', nominal: 4500000 }, { id: 'S3', goal_id: 'G-menikah', nominal: 2000000 }],
        transaksi: tx
      };
      tulis(LS.demo, d);
      return d;
    },
    async panggil(aksi, p) {
      await new Promise((r) => setTimeout(r, 350));
      const d = this.data();
      if (aksi === 'ping') return { versi: 'demo' };
      if (aksi === 'muat') return JSON.parse(JSON.stringify(d));
      if (aksi === 'transaksi.tambah' || aksi === 'transaksi.ubah') {
        if (!(p.nominal > 0)) throw new Galat('VALIDASI', 'Nominal wajib diisi dan harus lebih dari 0.');
        const i = d.transaksi.findIndex((t) => t.id === p.id);
        const kini = new Date().toISOString().slice(0, 19);
        const t = Object.assign({ dibuat: kini }, i >= 0 ? d.transaksi[i] : {}, p, { diperbarui: kini });
        if (i >= 0) d.transaksi[i] = t; else d.transaksi.push(t);
        tulis(LS.demo, d); return { transaksi: t };
      }
      if (aksi === 'transaksi.hapus') { d.transaksi = d.transaksi.filter((t) => t.id !== p.id); tulis(LS.demo, d); return { id: p.id }; }
      if (aksi === 'pengaturan.simpan') { Object.assign(d.pengaturan, p.nilai); tulis(LS.demo, d); return { pengaturan: p.nilai }; }
      throw new Galat('AKSI', 'Aksi tidak dikenal.');
    }
  };

  /* ==========================================================
     6. KERANGKA & NAVIGASI
     ========================================================== */
  const HALAMAN = [['beranda', 'Beranda'], ['riwayat', 'Riwayat'], ['goals', 'Goals'], ['lainnya', 'Lainnya']];

  function gambar() {
    for (const g of S.grafik) { try { g.destroy(); } catch (e) { /* abaikan */ } }
    S.grafik = [];
    const akar = $('#akar');
    if (!S.cfg) { akar.innerHTML = layarHubungkan(); pasangHubungkan(); return; }

    const isi = !S.data ? rangkaMuat() : ({ beranda: halBeranda, riwayat: halRiwayat, goals: halGoals, lainnya: halLainnya }[S.halaman] || halBeranda)();
    const nav = (id, nama) => '<button class="nav-item' + (S.halaman === id ? ' aktif' : '') + '" data-hal="' + id + '"' + (S.halaman === id ? ' aria-current="page"' : '') + '>' + ikon(id) + '<span>' + nama + '</span></button>';
    const sisi = (id, nama) => '<button class="sisi-item' + (S.halaman === id ? ' aktif' : '') + '" data-hal="' + id + '">' + ikon(id) + nama + '</button>';
    const fokus = document.activeElement && document.activeElement.id;
    const posisi = fokus ? document.activeElement.selectionStart : null;

    akar.innerHTML =
      '<div class="app">' +
        '<aside class="sidebar">' +
          '<div class="merek"><div class="logo">Rp</div>Keuanganku</div>' +
          HALAMAN.map((h) => sisi(h[0], h[1])).join('') +
          '<button class="tombol utama penuh" data-aksi="tambah">' + ikon('tambah') + 'Catat transaksi</button>' +
          '<div class="sisi-bawah">' + (S.cfg.demo ? 'Mode demo' : 'Terhubung ke Google Sheets') + '<br>Versi ' + VERSI + '</div>' +
        '</aside>' +
        '<main class="main' + (S.halaman === 'beranda' ? '' : ' sempit') + '" id="utama">' + isi + '</main>' +
        '<nav class="navbawah" aria-label="Navigasi utama">' +
          nav('beranda', 'Beranda') + nav('riwayat', 'Riwayat') +
          '<button class="fab" data-aksi="tambah" aria-label="Catat transaksi baru">' + ikon('tambah') + '</button>' +
          nav('goals', 'Goals') + nav('lainnya', 'Lainnya') +
        '</nav>' +
      '</div>';

    if (fokus && $('#' + fokus)) { const el = $('#' + fokus); el.focus(); if (posisi != null && el.setSelectionRange) { try { el.setSelectionRange(posisi, posisi); } catch (e) { /* abaikan */ } } }
    if (S.data && S.halaman === 'beranda') gambarGrafik();
    tandaiSinkron();
  }

  function pindah(hal) {
    S.halaman = hal;
    if (location.hash !== '#' + hal) history.pushState(null, '', '#' + hal);
    gambar();
    window.scrollTo(0, 0);
  }

  function rangkaMuat() {
    const kotak = (t) => '<div class="kartu"><div class="rangka" style="height:' + t + 'px"></div></div>';
    return '<div class="kepala"><div><div class="rangka" style="width:120px;height:14px;margin-bottom:8px"></div><div class="rangka" style="width:200px;height:26px"></div></div></div>' +
      '<div class="kartu4">' + kotak(70).repeat(4) + '</div><div class="grid-a">' + kotak(230) + kotak(230) + '</div>';
  }

  /* ==========================================================
     7. HALAMAN: BERANDA
     ========================================================== */
  function kepala(judul, sub, sisipan) {
    return '<header class="kepala"><div>' + (sub ? '<p class="sapa">' + sub + '</p>' : '') + '<h1>' + judul + '</h1></div>' +
      '<div class="kepala-kanan">' + (sisipan || '') + '<div class="aksi-kepala">' +
      '<button class="tombol-ikon" data-aksi="mata" aria-label="' + (S.sembunyi ? 'Tampilkan nominal' : 'Sembunyikan nominal') + '" aria-pressed="' + S.sembunyi + '">' + ikon(S.sembunyi ? 'mataTutup' : 'mata') + '</button>' +
      '<button class="tombol-ikon" id="tbl-segarkan" data-aksi="segarkan" aria-label="Sinkronkan data">' + ikon('segarkan') + '</button>' +
      '</div></div></header>';
  }

  function spandukDemo() {
    return S.cfg.demo ? '<div class="spanduk"><span>Mode demo: ini data contoh dan tidak tersimpan ke Google Sheets.</span><button data-aksi="keluar-demo">Hubungkan Sheets</button></div>' : '';
  }

  function pemilihPeriode(p) {
    return '<div class="periode">' +
      '<button data-aksi="periode-lalu" aria-label="Periode sebelumnya">' + ikon('kiri') + '</button>' +
      '<div class="periode-teks"><b>' + (S.geser === 0 ? 'Periode gajian ini' : 'Periode gajian') + '</b><span>' + tglRentang(p.mulai, p.akhir) + '</span></div>' +
      '<button data-aksi="periode-depan" aria-label="Periode berikutnya"' + (S.geser >= 0 ? ' disabled' : '') + '>' + ikon('kanan') + '</button></div>';
  }

  function chipUbah(kini, lalu, naikBaik) {
    const p = H.persenUbah(kini, lalu);
    if (p === null) return '<span>belum ada pembanding</span>';
    if (Math.abs(p) < 0.5) return '<span class="delta">= 0%</span><span>vs periode lalu</span>';
    const naik = p > 0;
    const kelas = naik === naikBaik ? 'baik' : 'buruk';
    const teks = Math.abs(p) >= 1000 ? '>999' : String(Math.round(Math.abs(p)));
    return '<span class="delta ' + kelas + '">' + (naik ? '▲' : '▼') + ' ' + teks + '%</span><span>vs periode lalu</span>';
  }

  function halBeranda() {
    const d = S.data, pk = petaKategori(), pa = petaAkun();
    const p = H.periodeGajian(tglGajian(), hariIni(), S.geser);
    const lalu = H.periodeGajian(tglGajian(), hariIni(), S.geser - 1);
    const r = H.ringkasan(d.transaksi, pk, p.mulai, p.akhir);
    const rl = H.ringkasan(d.transaksi, pk, lalu.mulai, lalu.akhir);
    const nama = String(d.pengaturan.nama_panggilan || '').trim();

    const stat = (kelas, emo, label, nilai, sub) => '<div class="kartu stat ' + kelas + '"><div class="stat-label"><span class="stat-titik">' + emo + '</span>' + label + '</div>' +
      '<div class="stat-nilai nom">' + nilai + '</div><div class="stat-sub">' + sub + '</div></div>';

    // --- donut pengeluaran per kategori (5 terbesar + lainnya)
    const urut = Object.keys(r.perKategori).map((id) => ({ id, n: r.perKategori[id] })).sort((a, b) => b.n - a.n);
    const atas = urut.slice(0, 5), sisa = urut.slice(5).reduce((s, x) => s + x.n, 0);
    const iris = atas.map((x, i) => ({ nama: (pk[x.id] ? pk[x.id].nama : x.id), n: x.n, warna: 'var(--s' + (i + 1) + ')' }));
    if (sisa > 0) iris.push({ nama: 'Lainnya', n: sisa, warna: 'var(--s-lain)' });
    S._iris = iris;

    // --- saldo per akun
    const saldo = H.saldoAkun(d.akun, d.transaksi);
    const akunAktif = d.akun.filter((a) => a.aktif !== false).sort((a, b) => (a.urutan || 0) - (b.urutan || 0));
    const totalSaldo = akunAktif.reduce((s, a) => s + (saldo[a.id] || 0), 0);

    const terbaru = H.urutTerbaru(d.transaksi).slice(0, 5);
    const goals = H.progresGoal(d.goals, d.setoran).slice(0, 4);

    return kepala('Ringkasan keuangan', 'Halo' + (nama ? ', ' + esc(nama) : '') + ' 👋', pemilihPeriode(p)) +
      spandukDemo() +
      '<div class="hanya-hp">' + pemilihPeriode(p) + '</div>' +
      '<section class="kartu4" aria-label="Ringkasan periode">' +
        stat('', '📥', 'Total Pemasukan', rp(r.masuk), chipUbah(r.masuk, rl.masuk, true)) +
        stat('', '📤', 'Total Pengeluaran', rp(r.keluar), chipUbah(r.keluar, rl.keluar, false)) +
        stat('utama', '💧', 'Arus Kas Bersih', rp(r.bersih), chipUbah(r.bersih, rl.bersih, true)) +
        stat('', '🌱', 'Tabungan & Investasi', rp(r.tabungan), chipUbah(r.tabungan, rl.tabungan, true)) +
      '</section>' +
      '<section class="grid-a">' +
        '<div class="kartu"><div class="kartu-kepala"><h2>Pemasukan vs Pengeluaran<small>Akumulasi sejak awal periode</small></h2>' +
          '<div class="legenda-garis"><span><i style="background:var(--s1)"></i>Pemasukan</span><span><i style="background:var(--s2)"></i>Pengeluaran</span></div></div>' +
          (r.jumlah ? '<div class="wadah-grafik"><canvas id="grafik-garis" role="img" aria-label="Grafik garis akumulasi pemasukan dan pengeluaran"></canvas></div>'
            : kosong('📈', 'Belum ada transaksi di periode ini', 'Tekan tombol + untuk mencatat yang pertama.')) +
        '</div>' +
        '<div class="kartu"><div class="kartu-kepala"><h2>Pengeluaran per kategori</h2></div>' +
          (iris.length ? '<div class="donat"><div class="donat-kanvas"><canvas id="grafik-donat" role="img" aria-label="Diagram donat pengeluaran per kategori"></canvas>' +
            '<div class="donat-tengah"><small>Total</small><b class="nom">' + (S.sembunyi ? '•••' : H.rupiahPendek(r.keluar)) + '</b></div></div>' +
            '<ul class="legenda">' + iris.map((x) => '<li><span class="nm"><i style="background:' + x.warna + '"></i>' + esc(x.nama) + '</span><span class="vl nom">' + rp(x.n) + '<small>' + Math.round((x.n / r.keluar) * 100) + '%</small></span></li>').join('') + '</ul></div>'
            : kosong('🍩', 'Belum ada pengeluaran', 'Rincian per kategori muncul di sini.')) +
        '</div>' +
      '</section>' +
      '<section class="grid-b">' +
        '<div class="kartu"><div class="kartu-kepala"><h2>Saldo per akun</h2></div><ul class="daftar">' +
          akunAktif.map((a) => '<li class="baris"><span class="emo">' + esc(a.ikon || '💳') + '</span><div><div class="baris-judul">' + esc(a.nama) + '</div><div class="baris-sub">' + esc(a.tipe || '') + '</div></div><div class="baris-nilai nom">' + rp(saldo[a.id]) + '</div></li>').join('') +
          '</ul><div class="total-baris"><span>Total tunai</span><span class="nom">' + rp(totalSaldo) + '</span></div></div>' +
        '<div class="kartu"><div class="kartu-kepala"><h2>Transaksi terbaru</h2><button class="tautan" data-hal="riwayat">Lihat semua</button></div>' +
          (terbaru.length ? '<ul class="daftar">' + terbaru.map((t) => '<li>' + barisTransaksi(t, pk, pa, true) + '</li>').join('') + '</ul>'
            : kosong('🧾', 'Belum ada transaksi', 'Catatan terbarumu akan tampil di sini.')) +
        '</div>' +
        '<div class="kartu"><div class="kartu-kepala"><h2>Progress goals</h2><button class="tautan" data-hal="goals">Lihat semua</button></div>' +
          (goals.length ? goals.map(kartuGoal).join('') : kosong('🎯', 'Belum ada goal', 'Goal bisa dibuat di Tahap 3.')) +
        '</div>' +
      '</section>';
  }

  function kosong(emo, judul, teks) {
    return '<div class="kosong"><span class="emo-besar">' + emo + '</span><b>' + judul + '</b>' + teks + '</div>';
  }

  function barisTransaksi(t, pk, pa, denganTanggal) {
    const k = pk[t.kategori_id] || { nama: t.kategori_id || 'Tanpa kategori', ikon: '❔' };
    const a = pa[t.akun_id], tujuan = pa[t.akun_tujuan_id];
    const tanda = t.jenis === 'Pemasukan' ? '+' : t.jenis === 'Pengeluaran' ? '-' : '';
    const kelas = t.jenis === 'Pemasukan' ? ' masuk' : t.jenis === 'Transfer' ? ' pindah' : '';
    const bagian = [];
    if (denganTanggal) bagian.push(tglPendek(t.tanggal));
    bagian.push((a ? a.nama : t.akun_id || '') + (t.jenis === 'Transfer' ? ' → ' + (tujuan ? tujuan.nama : 'investasi') : ''));
    if (t.catatan) bagian.push(t.catatan);
    if (t._tunda) bagian.unshift('menyimpan…');
    return '<button class="baris' + (t._tunda ? ' tunda' : '') + '" data-tx="' + esc(t.id) + '" aria-label="Ubah transaksi ' + esc(k.nama) + ' ' + H.rupiah(t.nominal) + '">' +
      '<span class="emo">' + esc(k.ikon || '❔') + '</span>' +
      '<div><div class="baris-judul">' + esc(k.nama) + '</div><div class="baris-sub">' + esc(bagian.join(' · ')) + '</div></div>' +
      '<div class="baris-nilai nom' + kelas + '">' + (t.jenis === 'Transfer' ? '⇄ ' : tanda) + (S.sembunyi ? rp(0) : H.rupiah(t.nominal)) + '</div></button>';
  }

  function kartuGoal(g) {
    return '<div class="goal"><div class="goal-atas"><span>' + esc(g.ikon || '🎯') + ' ' + esc(g.nama) + '</span><span class="num">' + (g.persen > 0 && g.persen < 1 ? '<1' : Math.round(g.persen)) + '%</span></div>' +
      '<div class="batang" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(g.persen) + '" aria-label="Progress ' + esc(g.nama) + '"><i style="width:' + g.persen.toFixed(1) + '%"></i></div>' +
      '<div class="goal-bawah"><span class="nom">' + rp(g.terkumpul) + ' dari ' + rp(g.target) + '</span><span>' + (g.target_tanggal ? 'target ' + BULAN[dariYmd(g.target_tanggal).getMonth()] + ' ' + dariYmd(g.target_tanggal).getFullYear() : esc(g.prioritas || '')) + '</span></div></div>';
  }

  function gambarGrafik() {
    if (typeof Chart === 'undefined') {
      $$('.wadah-grafik, .donat-kanvas').forEach((el) => { el.innerHTML = '<div class="kosong" style="padding:8px">Grafik butuh internet saat pertama kali dibuka.</div>'; });
      return;
    }
    const gaya = getComputedStyle(document.documentElement);
    const v = (n) => gaya.getPropertyValue(n).trim();
    Chart.defaults.font.family = gaya.getPropertyValue('--font');
    Chart.defaults.color = v('--ink-3');
    const d = S.data, p = H.periodeGajian(tglGajian(), hariIni(), S.geser);
    const tip = { backgroundColor: v('--ink'), titleColor: v('--bg'), bodyColor: v('--bg'), padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true };

    const kGaris = $('#grafik-garis');
    if (kGaris) {
      const s = H.kumulatif(H.deretHarian(d.transaksi, p.mulai, p.akhir), hariIni());
      const seri = (label, data, warna) => ({ label, data, borderColor: warna, backgroundColor: warna, borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 14 });
      S.grafik.push(new Chart(kGaris, {
        type: 'line',
        data: { labels: s.label.map(tglPendek), datasets: [seri('Pemasukan', s.masuk, v('--s1')), seri('Pengeluaran', s.keluar, v('--s2'))] },
        options: {
          responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: Object.assign({ callbacks: { label: (c) => ' ' + c.dataset.label + ' s.d. hari itu: ' + rp(c.parsed.y) } }, tip) },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, font: { size: 11 } } },
            y: { beginAtZero: true, border: { display: false }, grid: { color: v('--line') }, ticks: { maxTicksLimit: 5, font: { size: 11 }, callback: (x) => (S.sembunyi ? '•••' : H.rupiahPendek(x)) } }
          }
        }
      }));
    }
    const kDonat = $('#grafik-donat');
    if (kDonat && S._iris && S._iris.length) {
      const warna = S._iris.map((x) => v(x.warna.slice(4, -1)));
      S.grafik.push(new Chart(kDonat, {
        type: 'doughnut',
        data: { labels: S._iris.map((x) => x.nama), datasets: [{ data: S._iris.map((x) => x.n), backgroundColor: warna, borderColor: v('--card-solid'), borderWidth: 2, hoverOffset: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: Object.assign({ callbacks: { label: (c) => ' ' + rp(c.parsed) } }, tip) } }
      }));
    }
  }

  /* ==========================================================
     8. HALAMAN: RIWAYAT, GOALS, LAINNYA
     ========================================================== */
  function halRiwayat() {
    const pk = petaKategori(), pa = petaAkun(), f = S.saring;
    const kata = f.teks.trim().toLowerCase();
    let daftar = H.urutTerbaru(S.data.transaksi).filter((t) => {
      if (f.jenis !== 'Semua' && t.jenis !== f.jenis) return false;
      if (!kata) return true;
      const k = pk[t.kategori_id], a = pa[t.akun_id];
      return [(k && k.nama) || '', (a && a.nama) || '', t.catatan || '', String(t.nominal), t.tanggal].join(' ').toLowerCase().indexOf(kata) >= 0;
    });
    const total = daftar.length;
    daftar = daftar.slice(0, f.batas);

    let html = '', tglKini = null;
    for (const t of daftar) {
      if (t.tanggal !== tglKini) {
        tglKini = t.tanggal;
        const hari = daftar.filter((x) => x.tanggal === tglKini);
        const net = hari.reduce((s, x) => s + (x.jenis === 'Pemasukan' ? x.nominal : x.jenis === 'Pengeluaran' ? -x.nominal : 0), 0);
        html += '<div class="grup-tgl"><span>' + (tglKini === hariIni() ? 'Hari ini' : tglKini === geserHari(hariIni(), -1) ? 'Kemarin' : tglPanjang(tglKini)) + '</span><span class="nom">' + (S.sembunyi ? '' : (net > 0 ? '+' : '') + H.rupiah(net)) + '</span></div>';
      }
      html += barisTransaksi(t, pk, pa, false);
    }

    return kepala('Riwayat transaksi', total + ' transaksi') +
      '<div class="cari">' + ikon('cari') + '<input id="cari-riwayat" type="search" placeholder="Cari kategori, catatan, atau nominal" value="' + esc(f.teks) + '" autocomplete="off" aria-label="Cari transaksi"></div>' +
      '<div class="chip-baris">' + ['Semua', 'Pengeluaran', 'Pemasukan', 'Transfer'].map((j) => '<button class="chip' + (f.jenis === j ? ' aktif' : '') + '" data-saring="' + j + '">' + j + '</button>').join('') + '</div>' +
      '<div class="kartu">' + (html || kosong('🔍', kata || f.jenis !== 'Semua' ? 'Tidak ada yang cocok' : 'Belum ada transaksi', kata || f.jenis !== 'Semua' ? 'Coba kata kunci atau filter lain.' : 'Tekan tombol + untuk mencatat yang pertama.')) +
      (total > daftar.length ? '<button class="tombol polos penuh" data-aksi="lebih" style="margin-top:12px">Tampilkan lebih banyak (' + (total - daftar.length) + ')</button>' : '') + '</div>';
  }

  function halGoals() {
    const goals = H.progresGoal(S.data.goals, S.data.setoran);
    return kepala('Goals', 'Tujuan keuangan') +
      '<div class="kartu">' + (goals.length ? goals.map(kartuGoal).join('') : kosong('🎯', 'Belum ada goal', 'Goal akan tampil di sini.')) + '</div>' +
      '<p class="bantuan" style="margin:14px 4px">Menambah goal, mencatat setoran, cek "Aman dibeli?", serta kalkulator DP dan cicilan hadir di Tahap 3. Untuk sementara, target bisa diubah langsung di sheet <b>Goals</b>.</p>';
  }

  function halLainnya() {
    const p = S.data.pengaturan, demo = !!S.cfg.demo;
    const waktu = S.terakhirSinkron ? new Date(S.terakhirSinkron) : null;
    return kepala('Lainnya', 'Pengaturan & koneksi') + spandukDemo() +
      '<div class="tumpuk">' +
      '<div class="kartu"><div class="kartu-kepala"><h2>Pengaturan keuangan</h2></div>' +
        '<div class="kolom"><label for="set-nama">Nama panggilan</label><input class="isian" id="set-nama" maxlength="40" value="' + esc(p.nama_panggilan || '') + '" placeholder="Untuk sapaan di beranda"></div>' +
        '<div class="dua"><div class="kolom"><label for="set-tgl">Tanggal gajian</label><input class="isian" id="set-tgl" type="number" inputmode="numeric" min="1" max="31" value="' + esc(p.tanggal_gajian || 25) + '"></div>' +
        '<div class="kolom"><label for="set-gaji">Gaji bulanan (Rp)</label><input class="isian num" id="set-gaji" inputmode="numeric" value="' + H.ribuan(Number(p.gaji_bulanan) || 0) + '" data-ribuan></div></div>' +
        '<p class="bantuan" style="margin-bottom:12px">Periode keuangan dimulai tiap tanggal gajian. Gaji bulanan menjadi dasar saran alokasi (Tahap 2) dan bisa diubah kapan saja; pemasukan yang sebenarnya tetap dicatat sebagai transaksi.</p>' +
        '<div class="galat-teks" id="set-galat"></div>' +
        '<button class="tombol utama" data-aksi="simpan-pengaturan">Simpan pengaturan</button></div>' +
      '<div class="kartu"><div class="kartu-kepala"><h2>Tampilan</h2></div>' +
        '<label class="saklar">Sembunyikan nominal<input type="checkbox" id="set-sembunyi"' + (S.sembunyi ? ' checked' : '') + '></label></div>' +
      '<div class="kartu"><div class="kartu-kepala"><h2>Koneksi</h2></div>' +
        '<div class="info-baris"><span>Status</span><span>' + (demo ? 'Mode demo' : 'Terhubung ke Google Sheets') + '</span></div>' +
        '<div class="info-baris"><span>Sinkron terakhir</span><span>' + (waktu ? tglPendek(ymd(waktu)) + ', ' + pad(waktu.getHours()) + '.' + pad(waktu.getMinutes()) : 'belum pernah') + '</span></div>' +
        '<div class="info-baris"><span>Versi aplikasi</span><span>' + VERSI + (S.data.versi ? ' · server ' + esc(S.data.versi) : '') + '</span></div>' +
        '<div class="baris-tombol" style="margin-top:12px">' +
          '<button class="tombol polos" data-aksi="segarkan-kabari">Sinkronkan sekarang</button>' +
          (S.data.spreadsheet_url && /^https:\/\/docs\.google\.com\//.test(S.data.spreadsheet_url) ? '<a class="tombol polos" href="' + esc(S.data.spreadsheet_url) + '" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Buka spreadsheet</a>' : '') +
          (demo ? '' : '<button class="tombol polos" data-aksi="salin-kode">Salin kode koneksi</button>') +
          '<button class="tombol bahaya" data-aksi="putuskan">' + (demo ? 'Keluar dari mode demo' : 'Putuskan perangkat ini') + '</button>' +
        '</div>' +
        (demo ? '' : '<p class="bantuan" style="margin-top:12px">Kode koneksi berisi URL API dan token sekaligus, untuk menghubungkan perangkatmu yang lain. Perlakukan seperti kata sandi.</p>') +
      '</div></div>';
  }

  /* ==========================================================
     9. FORM TRANSAKSI (tambah / ubah)
     ========================================================== */
  let form = null;

  function bukaForm(t, mode) {
    if (!S.data) return;
    const akhir = baca(LS.akunAkhir, {});
    form = {
      mode: mode || (t ? 'ubah' : 'tambah'),
      t: Object.assign({ id: idBaru(), jenis: 'Pengeluaran', nominal: 0, kategori_id: '', akun_id: '', akun_tujuan_id: '', goal_id: '', tanggal: hariIni(), catatan: '' }, t || {})
    };
    const akunSah = (id) => S.data.akun.some((a) => a.id === id && a.aktif !== false);
    if (!akunSah(form.t.akun_id)) form.t.akun_id = akunSah(akhir[form.t.jenis]) ? akhir[form.t.jenis] : ((S.data.akun.find((a) => a.aktif !== false) || {}).id || '');
    gambarForm(true);
  }

  function kategoriUntuk(jenis) {
    const pakai = {};
    for (const t of S.data.transaksi) pakai[t.kategori_id] = (pakai[t.kategori_id] || 0) + 1;
    return S.data.kategori.filter((k) => k.jenis === jenis && k.aktif !== false)
      .sort((a, b) => ((pakai[b.id] || 0) - (pakai[a.id] || 0)) || ((a.urutan || 0) - (b.urutan || 0)));
  }

  function gambarForm(fokusNominal) {
    const t = form.t, ubah = form.mode === 'ubah';
    const akun = S.data.akun.filter((a) => a.aktif !== false).sort((a, b) => (a.urutan || 0) - (b.urutan || 0));
    const chipAkun = (a, aktif, atribut) => '<button type="button" class="chip' + (aktif ? ' aktif' : '') + '" ' + atribut + '="' + esc(a.id) + '">' + esc((a.ikon ? a.ikon + ' ' : '') + a.nama) + '</button>';
    const kemarin = geserHari(hariIni(), -1);

    $('#lapisan').innerHTML =
      '<div class="tirai" data-tirai><form class="lembar" id="form-tx" novalidate role="dialog" aria-modal="true" aria-label="' + (ubah ? 'Ubah transaksi' : 'Transaksi baru') + '">' +
        '<div class="lembar-kepala"><h2>' + (ubah ? 'Ubah transaksi' : 'Transaksi baru') + '</h2><button type="button" class="tutup" data-tutup aria-label="Tutup">' + ikon('tutup') + '</button></div>' +
        '<div class="segmen" role="group" aria-label="Jenis transaksi">' + ['Pengeluaran', 'Pemasukan', 'Transfer'].map((j) => '<button type="button" data-jenis="' + j + '" class="' + (t.jenis === j ? 'aktif' : '') + '" aria-pressed="' + (t.jenis === j) + '">' + j + '</button>').join('') + '</div>' +
        '<label class="nominal"><span>Rp</span><input id="f-nominal" inputmode="numeric" autocomplete="off" placeholder="0" aria-label="Nominal" value="' + H.ribuan(t.nominal) + '"></label>' +
        '<div class="galat-teks" id="f-galat" role="alert"></div>' +
        '<div class="label" style="margin:6px 0 8px">' + (t.jenis === 'Transfer' ? 'Untuk apa? (tabungan & investasi)' : 'Kategori') + '</div>' +
        '<div class="kat-grid">' + kategoriUntuk(t.jenis).map((k) => '<button type="button" class="kat' + (t.kategori_id === k.id ? ' aktif' : '') + '" data-kat="' + esc(k.id) + '" aria-pressed="' + (t.kategori_id === k.id) + '"><span>' + esc(k.ikon || '•') + '</span><span>' + esc(k.nama) + '</span></button>').join('') + '</div>' +
        '<div class="label" style="margin-bottom:8px">' + (t.jenis === 'Pemasukan' ? 'Masuk ke akun' : 'Dari akun') + '</div>' +
        '<div class="chip-baris">' + akun.map((a) => chipAkun(a, t.akun_id === a.id, 'data-akun')).join('') + '</div>' +
        (t.jenis === 'Transfer' ? '<div class="label" style="margin:4px 0 8px">Tujuan</div><div class="chip-baris">' +
          '<button type="button" class="chip' + (!t.akun_tujuan_id ? ' aktif' : '') + '" data-tujuan="">📈 Investasi / luar akun</button>' +
          akun.filter((a) => a.id !== t.akun_id).map((a) => chipAkun(a, t.akun_tujuan_id === a.id, 'data-tujuan')).join('') + '</div>' : '') +
        '<div class="dua" style="margin-top:4px"><div class="kolom"><label for="f-tanggal">Tanggal</label><input class="isian" id="f-tanggal" type="date" value="' + esc(t.tanggal) + '" max="2100-12-31"></div>' +
        '<div class="kolom"><span class="label">Cepat</span><div class="chip-baris" style="padding:6px 0 0"><button type="button" class="chip' + (t.tanggal === hariIni() ? ' aktif' : '') + '" data-tgl="' + hariIni() + '">Hari ini</button><button type="button" class="chip' + (t.tanggal === kemarin ? ' aktif' : '') + '" data-tgl="' + kemarin + '">Kemarin</button></div></div></div>' +
        '<div class="kolom"><label for="f-catatan">Catatan (opsional)</label><input class="isian" id="f-catatan" maxlength="200" autocomplete="off" placeholder="mis. makan siang" value="' + esc(t.catatan) + '"></div>' +
        '<div class="baris-tombol aksi-form">' + (ubah ? '<button type="button" class="tombol bahaya" data-hapus aria-label="Hapus transaksi">' + ikon('sampah') + '</button>' : '') +
        '<button type="submit" class="tombol utama" style="flex:1">' + (ubah ? 'Simpan perubahan' : 'Simpan') + '</button></div>' +
      '</form></div>';
    document.body.style.overflow = 'hidden';
    if (fokusNominal) { const n = $('#f-nominal'); n.focus(); const p = n.value.length; try { n.setSelectionRange(p, p); } catch (e) { /* abaikan */ } }
  }

  function bacaIsianForm() {
    if (!form || !$('#f-nominal')) return;
    form.t.nominal = H.angkaDariTeks($('#f-nominal').value);
    form.t.tanggal = $('#f-tanggal').value || form.t.tanggal;
    form.t.catatan = $('#f-catatan').value.trim();
  }

  function tutupLapisan() {
    $('#lapisan').innerHTML = '';
    document.body.style.overflow = '';
    form = null;
  }

  function kirimForm() {
    bacaIsianForm();
    const t = form.t, galat = $('#f-galat');
    let pesan = '';
    if (!(t.nominal > 0)) pesan = 'Nominal wajib diisi dan harus lebih dari 0.';
    else if (!t.kategori_id) pesan = 'Pilih kategori dulu.';
    else if (!t.akun_id) pesan = 'Pilih akun dulu.';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(t.tanggal)) pesan = 'Tanggal belum diisi.';
    if (pesan) {
      galat.textContent = pesan;
      const l = $('#form-tx'); l.classList.remove('goyang'); void l.offsetWidth; l.classList.add('goyang');
      if (!(t.nominal > 0)) $('#f-nominal').focus();
      return;
    }
    if (t.jenis !== 'Transfer') t.akun_tujuan_id = '';
    const akhir = baca(LS.akunAkhir, {}); akhir[t.jenis] = t.akun_id; tulis(LS.akunAkhir, akhir);
    const kirim = { id: t.id, jenis: t.jenis, nominal: t.nominal, kategori_id: t.kategori_id, akun_id: t.akun_id, akun_tujuan_id: t.akun_tujuan_id, goal_id: t.goal_id || '', tanggal: t.tanggal, catatan: t.catatan };
    const mode = form.mode;
    tutupLapisan();
    simpanTransaksi(kirim, mode);
  }

  function konfirmasi(judul, teks, labelYa, bahaya) {
    return new Promise((selesai) => {
      const el = document.createElement('div');
      el.className = 'tirai'; el.style.zIndex = 60; el.style.alignItems = 'center';
      el.innerHTML = '<div class="lembar dialog" role="alertdialog" aria-modal="true" aria-label="' + esc(judul) + '"><h2>' + esc(judul) + '</h2><p>' + esc(teks) + '</p><div class="baris-tombol"><button class="tombol polos" data-j="0">Batal</button><button class="tombol ' + (bahaya ? 'bahaya' : 'utama') + '" data-j="1">' + esc(labelYa) + '</button></div></div>';
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-j]');
        if (b || e.target === el) { el.remove(); selesai(!!b && b.dataset.j === '1'); }
      });
      document.body.appendChild(el);
      $('[data-j="0"]', el).focus();
    });
  }

  function toast(teks, jenis) {
    const el = document.createElement('div');
    el.className = 'toast' + (jenis === 'galat' ? ' galat' : '');
    el.textContent = teks;
    $('#toast').appendChild(el);
    setTimeout(() => el.remove(), jenis === 'galat' ? 5500 : 2600);
  }

  /* ==========================================================
     10. LAYAR HUBUNGKAN
     ========================================================== */
  function layarHubungkan() {
    return '<div class="sambut"><div class="kartu">' +
      '<div class="logo">Rp</div><h1>Keuanganku</h1><p class="sub">Catat pengeluaran dalam hitungan detik. Datanya tersimpan di Google Sheets milikmu sendiri.</p>' +
      '<form id="form-hubung" novalidate>' +
      '<div class="kolom"><label for="h-url">URL API atau kode koneksi</label><input class="isian" id="h-url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="kolom"><label for="h-token">Token</label><input class="isian" id="h-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Token dari menu Keuanganku di spreadsheet"></div>' +
      '<div class="galat-teks" id="h-galat" role="alert"></div>' +
      '<button class="tombol utama penuh" type="submit" id="h-kirim">Hubungkan</button></form>' +
      '<div class="pemisah">atau</div>' +
      '<button class="tombol polos penuh" id="h-demo">Coba dulu dengan data contoh</button>' +
      '<p class="bantuan" style="margin-top:14px">URL dan token hanya disimpan di perangkat ini. Sudah terhubung di perangkat lain? Buka Lainnya, pilih "Salin kode koneksi", lalu tempel di kolom pertama.</p>' +
      '</div></div>';
  }

  function uraiKode(teks) {
    try {
      if (teks.indexOf('KK1.') !== 0) return null;
      const o = JSON.parse(decodeURIComponent(escape(atob(teks.slice(4).replace(/-/g, '+').replace(/_/g, '/')))));
      return o && o.u && o.t ? { url: String(o.u), token: String(o.t) } : null;
    } catch (e) { return null; }
  }
  const buatKode = (cfg) => 'KK1.' + btoa(unescape(encodeURIComponent(JSON.stringify({ u: cfg.url, t: cfg.token })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function pasangHubungkan() {
    const url = $('#h-url'), token = $('#h-token'), galat = $('#h-galat'), kirim = $('#h-kirim');
    url.addEventListener('input', () => {
      const k = uraiKode(url.value.trim());
      if (k) { url.value = k.url; token.value = k.token; galat.textContent = ''; }
    });
    $('#h-demo').addEventListener('click', () => { S.cfg = { demo: true }; tulis(LS.cfg, S.cfg); S.data = null; gambar(); sinkronkan(); });
    $('#form-hubung').addEventListener('submit', async (e) => {
      e.preventDefault();
      const cfg = { url: url.value.trim(), token: token.value.trim() };
      if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(cfg.url)) { galat.textContent = 'URL API harus berawalan https://script.google.com/macros/s/ dan berakhiran /exec.'; return; }
      if (cfg.token.length < 16) { galat.textContent = 'Token belum diisi atau terlalu pendek.'; return; }
      galat.textContent = ''; kirim.disabled = true; kirim.textContent = 'Menghubungkan…';
      try {
        const d = await panggil('muat', {}, cfg);
        S.cfg = cfg; tulis(LS.cfg, cfg);
        buang(LS.demo);
        terapkanData(d);
        S.halaman = 'beranda';
        gambar();
        toast('Terhubung ke Google Sheets');
      } catch (err) {
        galat.textContent = err.kode === 'TOKEN_SALAH' ? 'Token salah. Salin ulang dari menu Keuanganku di spreadsheet.' : err.message;
        kirim.disabled = false; kirim.textContent = 'Hubungkan';
      }
    });
  }

  function putuskan() {
    [LS.cfg, LS.data, LS.sinkron, LS.demo, LS.akunAkhir].forEach(buang);
    S.cfg = null; S.data = null; S.terakhirSinkron = 0; S.geser = 0; S.tunda.clear();
    gambar();
  }

  /* ==========================================================
     11. PERISTIWA
     ========================================================== */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-hal],[data-aksi],[data-tx],[data-saring],[data-jenis],[data-kat],[data-akun],[data-tujuan],[data-tgl],[data-tutup],[data-hapus],[data-tirai]');
    if (!el) return;
    const ds = el.dataset;

    if ('tirai' in ds) { if (e.target === el) tutupLapisan(); return; }
    if ('tutup' in ds) return tutupLapisan();
    if (ds.hal) return pindah(ds.hal);
    if (ds.tx) { const t = S.data.transaksi.find((x) => x.id === ds.tx); if (t && !t._tunda) bukaForm(t, 'ubah'); return; }
    if (ds.saring) { S.saring.jenis = ds.saring; S.saring.batas = 80; return gambar(); }

    // --- di dalam form transaksi
    if (form && el.closest('#form-tx')) {
      if (ds.jenis) { bacaIsianForm(); if (form.t.jenis !== ds.jenis) { form.t.jenis = ds.jenis; form.t.kategori_id = ''; form.t.akun_tujuan_id = ''; } return gambarForm(false); }
      if (ds.kat) { bacaIsianForm(); form.t.kategori_id = ds.kat; return gambarForm(false); }
      if (ds.akun) { bacaIsianForm(); form.t.akun_id = ds.akun; if (form.t.akun_tujuan_id === ds.akun) form.t.akun_tujuan_id = ''; return gambarForm(false); }
      if ('tujuan' in ds) { bacaIsianForm(); form.t.akun_tujuan_id = ds.tujuan; return gambarForm(false); }
      if (ds.tgl) { bacaIsianForm(); form.t.tanggal = ds.tgl; return gambarForm(false); }
      if ('hapus' in ds) {
        const t = S.data.transaksi.find((x) => x.id === form.t.id);
        const k = petaKategori()[form.t.kategori_id];
        const ya = await konfirmasi('Hapus transaksi ini?', (k ? k.nama : 'Transaksi') + ' ' + H.rupiah(t ? t.nominal : form.t.nominal) + ' pada ' + tglPanjang(t ? t.tanggal : form.t.tanggal) + ' akan dihapus dari spreadsheet. Tindakan ini tidak bisa dibatalkan.', 'Hapus', true);
        if (ya && t) { tutupLapisan(); hapusTransaksi(t); }
        return;
      }
    }

    switch (ds.aksi) {
      case 'tambah': return bukaForm(null, 'tambah');
      case 'mata': S.sembunyi = !S.sembunyi; tulis(LS.sembunyi, S.sembunyi); return gambar();
      case 'segarkan': return sinkronkan();
      case 'segarkan-kabari': return sinkronkan({ kabari: true });
      case 'periode-lalu': S.geser -= 1; return gambar();
      case 'periode-depan': if (S.geser < 0) { S.geser += 1; gambar(); } return;
      case 'lebih': S.saring.batas += 80; return gambar();
      case 'keluar-demo': return putuskan();
      case 'putuskan': {
        const ya = S.cfg.demo || await konfirmasi('Putuskan perangkat ini?', 'URL API, token, dan salinan data di perangkat ini akan dihapus. Data di Google Sheets tetap aman.', 'Putuskan', true);
        if (ya) putuskan();
        return;
      }
      case 'salin-kode': {
        const kode = buatKode(S.cfg);
        try { await navigator.clipboard.writeText(kode); toast('Kode koneksi disalin. Jaga kerahasiaannya.'); }
        catch (err) { window.prompt('Salin kode koneksi ini:', kode); }
        return;
      }
      case 'simpan-pengaturan': return simpanPengaturan(el);
    }
  });

  async function simpanPengaturan(tombol) {
    const galat = $('#set-galat');
    const nilai = { nama_panggilan: $('#set-nama').value.trim(), tanggal_gajian: Math.round(Number($('#set-tgl').value)), gaji_bulanan: H.angkaDariTeks($('#set-gaji').value) };
    if (!(nilai.tanggal_gajian >= 1 && nilai.tanggal_gajian <= 31)) { galat.textContent = 'Tanggal gajian harus antara 1 dan 31.'; return; }
    galat.textContent = ''; tombol.disabled = true; tombol.textContent = 'Menyimpan…';
    try {
      await antre(() => panggil('pengaturan.simpan', { nilai }));
      Object.assign(S.data.pengaturan, nilai); simpanCache();
      S.geser = 0; gambar(); toast('Pengaturan tersimpan');
    } catch (e) { galat.textContent = e.message; tombol.disabled = false; tombol.textContent = 'Simpan pengaturan'; }
  }

  document.addEventListener('submit', (e) => { if (e.target.id === 'form-tx') { e.preventDefault(); kirimForm(); } });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'f-nominal' || el.hasAttribute('data-ribuan')) {
      const n = H.angkaDariTeks(el.value.slice(0, 18));
      el.value = H.ribuan(Math.min(n, 999999999999));
      if (el.id === 'f-nominal' && $('#f-galat')) $('#f-galat').textContent = '';
    } else if (el.id === 'cari-riwayat') {
      S.saring.teks = el.value; S.saring.batas = 80; gambar();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'set-sembunyi') { S.sembunyi = e.target.checked; tulis(LS.sembunyi, S.sembunyi); gambar(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!form || $('[role="alertdialog"]')) return;
    if (e.key === 'Escape') return tutupLapisan();
    // Enter menyimpan walau fokus sedang tidak di kolom isian (mis. setelah memilih kategori).
    if (e.key === 'Enter' && !e.target.closest('#form-tx')) { e.preventDefault(); kirimForm(); }
  });

  window.addEventListener('popstate', () => {
    if (form) tutupLapisan();
    const h = location.hash.slice(1);
    S.halaman = HALAMAN.some((x) => x[0] === h) ? h : 'beranda';
    gambar();
  });

  // Kembali ke aplikasi setelah lebih dari 1 menit: ambil data terbaru diam-diam.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.cfg && Date.now() - S.terakhirSinkron > 60000 && !form) sinkronkan({ diam: true });
  });
  window.addEventListener('online', () => { if (S.cfg) sinkronkan({ diam: true }); });

  /* ==========================================================
     12. MULAI
     ========================================================== */
  (function mulai() {
    const h = location.hash.slice(1);
    if (HALAMAN.some((x) => x[0] === h)) S.halaman = h;
    gambar();                                  // tampilkan data tersimpan seketika
    if (S.cfg) sinkronkan({ diam: !!S.data }); // lalu ambil yang terbaru
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  })();
})();
