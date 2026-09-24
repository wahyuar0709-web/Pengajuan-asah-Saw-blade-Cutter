/**
 * PengajuanAsah_Backend.gs  —  v3
 * -------------------------------------------------------------
 * Backend form "index.html" (Pengajuan Asah). Bound ke spreadsheet
 * "Monitoring Saw blade & cutter".
 *
 * DEPLOY (wajib ulang setiap kode berubah):
 *   1. Tempel file ini di Extensions > Apps Script.
 *   2. Isi NOTIFY_EMAIL di bawah (email gudang penerima notifikasi).
 *   3. Jalankan setup() SEKALI (Run > Allow). Izin baru yang muncul:
 *      kirim email (MailApp). Ini normal.
 *   4. Jalankan ujiFormula() SEKALI: memastikan isian "=1+1" tersimpan
 *      sebagai teks. Baris uji dihapus otomatis.
 *   5. Deploy > Manage deployments > Edit (pensil) > Version: New version.
 *      Execute as: Me | Who has access: Anyone.
 *
 * PERUBAHAN v3
 *  - Batas harian pengajuan (MAX_PER_HARI) dan foto (MAX_FOTO_PER_HARI).
 *    Melewati batas -> ditolak (kode LIMIT) + email peringatan (1x/hari).
 *  - Email notifikasi setiap ada pengajuan baru.
 *  - Saklar darurat: jalankan jedaPengajuan() untuk menutup penerimaan,
 *    lanjutPengajuan() untuk membukanya lagi (tanpa deploy ulang).
 *  - Kolom sheet dipetakan berdasarkan NAMA header, bukan posisi. Kalau ada
 *    yang menyisipkan kolom, data tetap masuk ke kolom yang benar.
 *    Header yang sudah berisi tidak pernah ditimpa. Baris header diberi
 *    proteksi peringatan. JANGAN ubah nama header.
 *  - Baris baru ditulis setelah tiket terakhir (bukan getLastRow), jadi
 *    formula / catatan di kolom lain tidak menggeser posisi.
 *  - Tiket sama + isi beda = pengajuan baru dengan tiket bersufiks
 *    (bukan dianggap duplikat). Klien menampilkan tiket final dari server.
 *  - Alat yang diisi manual ditandai "[MANUAL]" di kolom Kode Alat.
 *  - Master: header wajib dicek (error jelas, bukan kosong diam-diam);
 *    kolom stok opsional -> muncul di "warnings".
 *  - Foto: akses tautan diatur lewat FOTO_AKSES.
 *
 * CATATAN KEAMANAN
 *  SHARED_TOKEN ikut tertanam di HTML (sengaja, agar operator cukup scan
 *  QR), jadi hanya "polisi tidur". Perlindungan sesungguhnya: validasi,
 *  sanitasi, batas harian, notifikasi email, dan saklar darurat.
 *  Kalau ada penyalahgunaan: jedaPengajuan(), ganti token di sini DAN di
 *  index.html, deploy versi baru, lalu lanjutPengajuan().
 */

var SHARED_TOKEN = 'VjAb48xWwzFkrtJlP0TaJUYK';

/* ---- KONFIGURASI ---- */
var NOTIFY_EMAIL = '';          // WAJIB DIISI, mis. 'gudang@perusahaan.com'. Boleh beberapa, pisah koma.
var MAX_PER_HARI = 20;          // maks pengajuan per hari (semua operator)
var MAX_FOTO_PER_HARI = 10;     // maks foto tersimpan per hari
var FOTO_AKSES = 'LINK';        // 'LINK' = siapa pun dengan tautan bisa lihat; 'PRIVATE' = hanya pemilik script
var TZ = 'Asia/Jakarta';

var SHEET_NAME = 'Pengajuan Asah';
var MAPPING_SHEET = 'Mapping Alat Mesin';
var MASTER_SHEET = 'Master Tools';
var STOCK_SHEET = 'Stock Status';
var FOTO_FOLDER_NAME = 'Foto Pengajuan Asah';

var HEADERS = [
  'Timestamp', 'Tanggal Pengajuan', 'Nama Pengaju / Operator Produksi', 'Mesin',
  'Pilih Brand/Merk', 'Pilih Spesifikasi', 'QTY', 'Kondisi',
  'Aktual Pemakaian (di mesin)', 'Catatan', 'No. Tiket', 'Foto',
  'Status', 'Kode Alat', 'Kode Mesin'
];
var FORMATS = ['yyyy-mm-dd hh:mm:ss', '@', '@', '@', '@', '@', '0', '@', '@', '@', '@', '@', '@', '@', '@'];
var C = { TS: 0, TGL: 1, NAMA: 2, MESIN: 3, BRAND: 4, SPEK: 5, QTY: 6, KOND: 7, PMK: 8,
          CAT: 9, TIKET: 10, FOTO: 11, STATUS: 12, KALAT: 13, KMESIN: 14 };
var STATUS_LIST = ['BARU', 'DIVERIFIKASI', 'DIKIRIM VENDOR', 'SELESAI', 'DITOLAK'];
var KONDISI_OK = ['Tumpul', 'Gompal', 'Patah', 'Aus / Gundul', 'Lainnya'];
var MAX_FOTO_B64 = 1500000;
var MASTER_CACHE_KEY = 'master_v3';
var MASTER_CACHE_SEC = 300;

/* ============================== POST ============================== */

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return json_({ ok: false, code: 'BUSY', error: 'Server sibuk, coba lagi sebentar.' });
  }
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 2500000) {
      return json_({ ok: false, code: 'INVALID', error: 'Payload kosong atau terlalu besar.' });
    }
    var data;
    try { data = JSON.parse(raw); }
    catch (parseErr) { return json_({ ok: false, code: 'INVALID', error: 'Format JSON tidak valid.' }); }

    if (!data || data.token !== SHARED_TOKEN) {
      return json_({ ok: false, code: 'UNAUTHORIZED', error: 'Token tidak cocok. Perbarui halaman form.' });
    }
    if (PropertiesService.getScriptProperties().getProperty('PAUSED') === '1') {
      return json_({ ok: false, code: 'PAUSED', error: 'Pengajuan sedang dijeda oleh gudang. Hubungi gudang.' });
    }

    var bad = validate_(data);
    if (bad) return json_({ ok: false, code: 'INVALID', error: bad });

    return json_(submit_(data, {}));
  } catch (err) {
    return json_({ ok: false, code: 'SERVER', error: String(err).slice(0, 200) });
  } finally {
    lock.releaseLock();
  }
}

/* Inti penyimpanan. Dipanggil di dalam lock (doPost) atau dari ujiFormula().
 * opt: { noMail:bool, skipCap:bool } */
function submit_(data, opt) {
  var sheet = getSheet_();
  if (!sheet) return { ok: false, code: 'SERVER', error: 'Sheet "' + SHEET_NAME + '" tidak ditemukan.' };
  var map = ensureHeaders_(sheet, false);

  var ticket = cleanTicket_(data.ticket);
  var scan = scanTickets_(sheet, map[C.TIKET]);

  // Idempoten: tiket sama & isi sama = sudah tercatat. Isi beda = tabrakan tiket -> tiket baru.
  var ex = scan.rows[ticket];
  if (ex) {
    if (sameSubmission_(sheet, map, ex, data)) {
      return { ok: true, duplicate: true, ticket: ticket, row: ex };
    }
    ticket = ticket + '-' + Utilities.getUuid().slice(0, 4).toUpperCase();
  }

  // Batas harian
  var use = usage_();
  if (!opt.skipCap && use.n >= MAX_PER_HARI) {
    notifyLimit_(use);
    return { ok: false, code: 'LIMIT', error: 'Batas pengajuan harian (' + MAX_PER_HARI + ') tercapai. Coba lagi besok atau hubungi gudang.' };
  }

  var fotoUrl = '', fotoError = '';
  if (data.foto) {
    if (!opt.skipCap && use.f >= MAX_FOTO_PER_HARI) {
      fotoError = 'Batas foto harian tercapai'; fotoUrl = 'FOTO DILEWATI (batas harian)';
    } else {
      try { fotoUrl = simpanFoto_(data.foto, ticket); use.f++; }
      catch (fotoErr) { fotoError = String(fotoErr).slice(0, 120); fotoUrl = 'GAGAL SIMPAN FOTO'; }
    }
  }

  var kodeAlat = clean_(data.kodeAlat, 40);
  if (data.manual === true) kodeAlat = '[MANUAL] ' + kodeAlat;

  var row = [];
  row[C.TS] = new Date();
  row[C.TGL] = clean_(data.tanggalPengajuan, 40);
  row[C.NAMA] = clean_(data.namaPengaju, 60);
  row[C.MESIN] = clean_(data.mesin, 80);
  row[C.BRAND] = clean_(data.brand, 40);
  row[C.SPEK] = clean_(data.spesifikasi, 120);
  row[C.QTY] = Number(data.qty);
  row[C.KOND] = data.kondisi;
  row[C.PMK] = clean_(data.pemakaian, 20);
  row[C.CAT] = clean_(data.catatan, 500);
  row[C.TIKET] = ticket;
  row[C.FOTO] = fotoUrl;
  row[C.STATUS] = 'BARU';
  row[C.KALAT] = kodeAlat;
  row[C.KMESIN] = clean_(data.kodeMesin, 20);

  var r = scan.last + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 200);
  writeRow_(sheet, map, r, row);

  use.n++;
  saveUsage_(use);
  if (!opt.noMail) notify_(sheet, r, row);

  return { ok: true, ticket: ticket, row: r, foto: fotoUrl, fotoError: fotoError };
}

function validate_(d) {
  var nama = clean_(d.namaPengaju, 60);
  if (nama.length < 2) return 'Nama pengaju wajib diisi (min. 2 huruf).';
  if (!clean_(d.mesin, 80)) return 'Mesin wajib diisi.';
  if (!clean_(d.spesifikasi, 120)) return 'Alat / spesifikasi wajib diisi.';
  var q = Number(d.qty);
  if (!(q >= 1 && q <= 999) || Math.floor(q) !== q) return 'Qty harus bilangan bulat 1–999.';
  if (KONDISI_OK.indexOf(d.kondisi) < 0) return 'Kondisi alat tidak valid.';
  if (d.kondisi === 'Lainnya' && !clean_(d.catatan, 500)) return 'Kondisi "Lainnya" wajib disertai catatan.';
  if (d.foto) {
    if (typeof d.foto !== 'string' || d.foto.length > MAX_FOTO_B64 || !/^[A-Za-z0-9+\/=]+$/.test(d.foto)) {
      return 'Foto tidak valid atau terlalu besar.';
    }
  }
  return '';
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function cleanTicket_(t) {
  return String(t || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || ('PA-' + Date.now());
}

/* ============================ SHEET & KOLOM ============================ */

function getSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

/* Baca kolom tiket sekali: peta tiket->baris dan baris terakhir yang berisi tiket. */
function scanTickets_(sheet, col) {
  var n = Math.max(sheet.getMaxRows() - 1, 1);
  var vals = sheet.getRange(2, col, n, 1).getValues();
  var rows = {}, last = 1;
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0]).trim();
    if (v) { rows[v] = i + 2; last = i + 2; }
  }
  return { rows: rows, last: last };
}

function sameSubmission_(sheet, map, row, d) {
  var nama = String(sheet.getRange(row, map[C.NAMA]).getValue());
  var alat = String(sheet.getRange(row, map[C.KALAT]).getValue()).replace(/^\[MANUAL\]\s*/, '');
  var qty = Number(sheet.getRange(row, map[C.QTY]).getValue());
  return nama === clean_(d.namaPengaju, 60) && alat === clean_(d.kodeAlat, 40) && qty === Number(d.qty);
}

function writeRow_(sheet, map, r, values) {
  var contiguous = true, i;
  for (i = 0; i < HEADERS.length; i++) if (map[i] !== i + 1) { contiguous = false; break; }
  if (contiguous) {
    var vals = [];
    for (i = 0; i < HEADERS.length; i++) vals.push(values[i] == null ? '' : values[i]);
    var rng = sheet.getRange(r, 1, 1, HEADERS.length);
    rng.setNumberFormats([FORMATS]);     // "@" = teks murni -> kebal formula-injection
    rng.setValues([vals]);
    return;
  }
  for (i = 0; i < HEADERS.length; i++) {   // kolom sudah tergeser: tulis per sel
    sheet.getRange(r, map[i]).setNumberFormat(FORMATS[i]).setValue(values[i] == null ? '' : values[i]);
  }
}

/* Pastikan setiap header standar ada di baris 1 dan kembalikan peta
 * indeks-standar -> nomor kolom (1-based). TIDAK menimpa sel header berisi.
 *  - Sel kosong pada posisi standar diisi header standar.
 *  - Header yang masih hilang (mis. diganti nama) ditambahkan di sel kosong berikutnya. */
function ensureHeaders_(sheet, force) {
  var need = HEADERS.length;
  if (sheet.getMaxColumns() < need) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
  }
  var width = sheet.getMaxColumns();
  var cur = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (x) { return String(x).trim(); });
  var changed = [], i, j;

  for (i = 0; i < need; i++) {
    if (cur.indexOf(HEADERS[i]) < 0 && !cur[i]) { cur[i] = HEADERS[i]; changed.push(i + 1); }
  }
  for (i = 0; i < need; i++) {
    if (cur.indexOf(HEADERS[i]) >= 0) continue;
    var slot = -1;
    for (j = 0; j < cur.length; j++) if (!cur[j]) { slot = j; break; }
    if (slot < 0) { sheet.insertColumnAfter(sheet.getMaxColumns()); cur.push(''); slot = cur.length - 1; }
    cur[slot] = HEADERS[i]; changed.push(slot + 1);
  }
  changed.forEach(function (col) {
    sheet.getRange(1, col).setValue(cur[col - 1]).setFontWeight('bold');
  });

  var map = [];
  for (i = 0; i < need; i++) map[i] = cur.indexOf(HEADERS[i]) + 1;

  if (changed.length || force) {
    sheet.setFrozenRows(1);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(STATUS_LIST, true).setAllowInvalid(false).build();
    var rows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, map[C.STATUS], rows, 1).setDataValidation(rule);
  }
  return map;
}

function protectHeader_(sheet) {
  var desc = 'Header Pengajuan Asah - jangan diubah';
  var exists = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(function (p) {
    return p.getDescription() === desc;
  });
  if (exists) return;
  var p = sheet.getRange(1, 1, 1, sheet.getMaxColumns()).protect();
  p.setDescription(desc);
  p.setWarningOnly(true);              // hanya peringatan, pemilik tidak terkunci
}

/* ============================ BATAS HARIAN ============================ */

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyyMMdd'); }

function usage_() {
  var props = PropertiesService.getScriptProperties();
  var u;
  try { u = JSON.parse(props.getProperty('USAGE') || '{}'); } catch (e) { u = {}; }
  if (u.d !== today_()) u = { d: today_(), n: 0, f: 0 };
  return u;
}

function saveUsage_(u) {
  PropertiesService.getScriptProperties().setProperty('USAGE', JSON.stringify(u));
}

/* ============================== EMAIL ============================== */

function notify_(sheet, r, row) {
  if (!NOTIFY_EMAIL) return;
  try {
    var url = SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + r;
    var body = [
      'Pengajuan asah baru masuk.', '',
      'Tiket     : ' + row[C.TIKET],
      'Pengaju   : ' + row[C.NAMA],
      'Mesin     : ' + row[C.MESIN],
      'Alat      : ' + row[C.SPEK] + '  (' + row[C.BRAND] + ')',
      'Qty       : ' + row[C.QTY],
      'Kondisi   : ' + row[C.KOND],
      'Pemakaian : ' + (row[C.PMK] || '-'),
      'Catatan   : ' + (row[C.CAT] || '-'),
      'Foto      : ' + (row[C.FOTO] || '-'),
      '', 'Buka di sheet: ' + url
    ].join('\n');
    MailApp.sendEmail(NOTIFY_EMAIL, '[Pengajuan Asah] ' + row[C.TIKET] + ' - ' + row[C.KALAT] + ' x' + row[C.QTY], body);
  } catch (err) {
    console.error('Gagal kirim email: ' + err);   // jangan gagalkan pengajuan
  }
}

function notifyLimit_(use) {
  if (!NOTIFY_EMAIL) return;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('LIMIT_MAILED') === today_()) return;   // 1x per hari
  try {
    MailApp.sendEmail(NOTIFY_EMAIL, '[Pengajuan Asah] Batas harian tercapai',
      'Sudah ' + use.n + ' pengajuan hari ini (batas ' + MAX_PER_HARI + '). Pengajuan berikutnya ditolak.\n' +
      'Jika ini tidak wajar, jalankan jedaPengajuan() di Apps Script, ganti token, lalu deploy ulang.');
    props.setProperty('LIMIT_MAILED', today_());
  } catch (err) { console.error('Gagal kirim email batas: ' + err); }
}

/* ============================== FOTO ============================== */

function simpanFoto_(base64, ticket) {
  var bytes = Utilities.base64Decode(base64);
  if (bytes.length < 4 || bytes[0] !== -1 || bytes[1] !== -40) {   // 0xFF 0xD8 = JPEG
    throw new Error('Bukan file JPEG.');
  }
  var blob = Utilities.newBlob(bytes, 'image/jpeg', ticket + '.jpg');
  var file = getOrCreateFotoFolder_().createFile(blob);
  if (FOTO_AKSES === 'LINK') file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/* Folder dibuat & dimiliki script; ID disimpan di Script Properties.
 * CATATAN: DriveApp meminta izin Drive penuh pada akun pemilik script. Jalankan
 * script dari akun khusus gudang (bukan akun pribadi) untuk membatasi dampaknya. */
function getOrCreateFotoFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (gone) { /* dibuat ulang di bawah */ }
  }
  var folder = DriveApp.createFolder(FOTO_FOLDER_NAME);
  props.setProperty('FOTO_FOLDER_ID', folder.getId());
  return folder;
}

/* ============================== GET ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'master') {
    if (p.token !== SHARED_TOKEN) return json_({ ok: false, code: 'UNAUTHORIZED', error: 'Token tidak cocok.' });
    try { return json_({ ok: true, master: getMaster_() }); }
    catch (err) { return json_({ ok: false, code: 'SERVER', error: String(err.message || err).slice(0, 200) }); }
  }
  return json_({ ok: true, message: 'PengajuanAsah backend v3 aktif. POST untuk kirim data.' });
}

function getMaster_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(MASTER_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var warnings = [];
  var mt = readTable_(ss, MASTER_SHEET, true);
  var mp = readTable_(ss, MAPPING_SHEET, true);
  var st = readTable_(ss, STOCK_SHEET, false);
  if (!st) warnings.push('Sheet "' + STOCK_SHEET + '" tidak ada: stok tidak ditampilkan.');

  // Stok per kode alat (opsional)
  var stok = {};
  if (st) {
    var sK = col_(st, 'kode alat'), sReady = col_(st, 'siap pakai'), sWait = col_(st, 'menunggu diasah'), sStat = col_(st, 'status kondisi');
    if (sK < 0 || sReady < 0) {
      warnings.push('Sheet "' + STOCK_SHEET + '": kolom "Kode Alat" / "Siap Pakai" tidak ditemukan; stok tidak ditampilkan.');
    } else {
      st.rows.forEach(function (r) {
        var k = String(r[sK] || '').trim().toUpperCase();
        if (!k) return;
        stok[k] = { siap: parseInt(r[sReady], 10) || 0, menunggu: sWait < 0 ? 0 : (parseInt(r[sWait], 10) || 0),
                    status: sStat < 0 ? '' : String(r[sStat] || '').trim() };
      });
    }
  }

  // Master alat (brand, spek, nama) - kolom kode wajib
  var info = {}, allTools = [];
  var mK = need_(mt, 'kode alat', MASTER_SHEET);
  var mN = col_(mt, 'nama alat'), mB = col_(mt, 'brand'), mS = col_(mt, 'specification');
  mt.rows.forEach(function (r) {
    var kode = String(r[mK] || '').trim();
    if (!kode) return;
    var s = stok[kode.toUpperCase()] || {};
    var t = { kode: kode, nama: mN < 0 ? '' : String(r[mN] || '').trim(), brand: (mB < 0 ? '' : String(r[mB] || '').trim()) || '-',
              spek: mS < 0 ? '' : String(r[mS] || '').trim(), siap: s.siap, menunggu: s.menunggu, status: s.status || '' };
    info[kode.toUpperCase()] = t;
    allTools.push(t);
  });

  // Mesin -> alat (Mapping Alat Mesin), abaikan BELUM DISET
  var pK = need_(mp, 'kode alat', MAPPING_SHEET), pM = need_(mp, 'kode mesin', MAPPING_SHEET);
  var pN = col_(mp, 'nama alat'), pS = col_(mp, 'spesifikasi'), pMn = col_(mp, 'mesin');
  var machines = {};
  mp.rows.forEach(function (r) {
    var kode = String(r[pK] || '').trim();
    var mesin = String(r[pM] || '').trim().toUpperCase();
    if (!kode || !/^RDS\d{3}$/.test(mesin)) return;
    var m = machines[mesin] || (machines[mesin] = { code: mesin, names: {}, tools: [], seen: {} });
    var nm = pMn < 0 ? '' : String(r[pMn] || '').trim();
    if (nm) m.names[nm] = (m.names[nm] || 0) + 1;
    if (m.seen[kode.toUpperCase()]) return;
    m.seen[kode.toUpperCase()] = true;
    var i = info[kode.toUpperCase()] || {};
    m.tools.push({
      kode: kode, nama: i.nama || (pN < 0 ? '' : String(r[pN] || '').trim()), brand: i.brand || '-',
      spek: (pS < 0 ? '' : String(r[pS] || '').trim()) || i.spek || '', siap: i.siap, menunggu: i.menunggu, status: i.status || ''
    });
  });

  var list = Object.keys(machines).sort().map(function (code) {
    var m = machines[code];
    var best = '', n = 0;
    Object.keys(m.names).forEach(function (k) { if (m.names[k] > n) { n = m.names[k]; best = k; } });
    m.tools.sort(function (a, b) { return a.kode < b.kode ? -1 : a.kode > b.kode ? 1 : 0; });
    return { code: code, name: best || code, tools: m.tools };
  });

  if (!list.length) throw new Error('Tidak ada mesin valid (kode RDSnnn) di sheet "' + MAPPING_SHEET + '".');

  var out = { machines: list, allTools: allTools, warnings: warnings, generatedAt: new Date().toISOString() };
  var json = JSON.stringify(out);
  if (json.length < 95000) cache.put(MASTER_CACHE_KEY, json, MASTER_CACHE_SEC);
  return out;
}

/* required=true -> lempar error jelas bila sheet tidak ada; false -> null. */
function readTable_(ss, name, required) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    if (required) throw new Error('Sheet "' + name + '" tidak ditemukan.');
    return null;
  }
  var v = sh.getDataRange().getDisplayValues();
  if (v.length < 2) {
    if (required) throw new Error('Sheet "' + name + '" kosong.');
    return null;
  }
  return { h: v[0].map(function (x) { return String(x).toLowerCase().trim(); }), rows: v.slice(1) };
}

function col_(t, prefix) {
  for (var i = 0; i < t.h.length; i++) if (t.h[i].indexOf(prefix) === 0) return i;
  return -1;
}

function need_(t, prefix, sheetName) {
  var i = col_(t, prefix);
  if (i < 0) throw new Error('Sheet "' + sheetName + '": kolom "' + prefix + '" tidak ditemukan (header diubah?).');
  return i;
}

/* ============================== UTIL ============================== */

/** Jalankan sekali setelah tempel kode. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  ensureHeaders_(sheet, true);
  protectHeader_(sheet);
  getOrCreateFotoFolder_();
  Logger.log('Setup OK. Header, dropdown Status, proteksi header, dan folder foto siap.' +
             (NOTIFY_EMAIL ? '' : ' PERINGATAN: NOTIFY_EMAIL belum diisi -> tidak ada email notifikasi.'));
}

/** Uji cepat dari editor: cek daftar mesin/alat terbaca. */
function selfTest() {
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY);
  var m = getMaster_();
  Logger.log(m.machines.length + ' mesin, ' + m.allTools.length + ' alat, ' + JSON.stringify(m).length + ' bytes' +
             (m.warnings.length ? ' | PERINGATAN: ' + m.warnings.join(' ; ') : ''));
}

/** Uji formula-injection: tulis baris uji berisi "=1+1", cek tersimpan sebagai teks, lalu hapus baris. */
function ujiFormula() {
  var data = {
    ticket: 'TEST-' + Date.now(), tanggalPengajuan: 'uji', namaPengaju: '=1+1', mesin: 'RDS000 - uji',
    brand: '=1+1', kodeAlat: 'UJI-01', spesifikasi: '=1+1', qty: 1, kondisi: 'Tumpul',
    pemakaian: '', catatan: '=1+1', kodeMesin: 'RDS000'
  };
  var res = submit_(data, { noMail: true, skipCap: true });
  if (!res.ok) { Logger.log('GAGAL uji: ' + JSON.stringify(res)); return; }
  var sheet = getSheet_(), map = ensureHeaders_(sheet, false);
  var cell = sheet.getRange(res.row, map[C.CAT]);
  var formula = cell.getFormula(), shown = cell.getDisplayValue();
  sheet.deleteRow(res.row);
  Logger.log((formula === '' && shown === '=1+1')
    ? 'LULUS: "=1+1" tersimpan sebagai teks. Baris uji sudah dihapus.'
    : 'GAGAL: sel dianggap formula! formula="' + formula + '" tampil="' + shown + '"');
}

/** SAKLAR DARURAT: tutup / buka penerimaan pengajuan tanpa deploy ulang. */
function jedaPengajuan()   { PropertiesService.getScriptProperties().setProperty('PAUSED', '1'); Logger.log('Pengajuan DIJEDA.'); }
function lanjutPengajuan() { PropertiesService.getScriptProperties().deleteProperty('PAUSED'); Logger.log('Pengajuan DIBUKA kembali.'); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
