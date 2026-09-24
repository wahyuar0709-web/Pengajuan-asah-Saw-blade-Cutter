# Pengajuan Asah — RDI Tools (v3)

Form pengajuan asah saw blade & cutter. Operator scan QR → langsung ke form → data masuk ke Google Sheet "Pengajuan Asah".

## Isi
| File | Fungsi |
|---|---|
| `index.html` | Aplikasi form (klien) |
| `sw.js` | Service worker (cache agar bisa dibuka offline) |
| `manifest.webmanifest`, `icon-*.png`, `logo.svg` | Instalasi PWA |
| `PengajuanAsah_Backend.gs` | Backend Google Apps Script (tempel di Apps Script, **bukan** diunggah ke GitHub Pages) |

## Deploy klien (GitHub Pages)
1. Unggah `index.html`, `sw.js`, `manifest.webmanifest`, `logo.svg`, dan semua `icon-*.png` ke repo.
2. Aktifkan GitHub Pages. Buat QR dari URL halaman tersebut (satu QR untuk semua operator).
3. Setiap `index.html` / `sw.js` berubah, naikkan `VERSION` di `sw.js` (mis. `pa-v4`).

## Deploy backend
1. Buka spreadsheet "Monitoring Saw blade & cutter" → Extensions → Apps Script → tempel `PengajuanAsah_Backend.gs`.
2. Isi `NOTIFY_EMAIL`.
3. Jalankan `setup()` lalu `ujiFormula()` (harus LULUS) lalu `selfTest()`.
4. Deploy → Manage deployments → Edit → New version. Execute as **Me**, access **Anyone**.
5. Jika URL `/exec` berubah, ubah `DEFAULT_API_URL` di `index.html`.

## Operasional
- **Ada spam / lonjakan tidak wajar:** jalankan `jedaPengajuan()`. Ganti token di `.gs` **dan** `index.html`, deploy versi baru, lalu `lanjutPengajuan()`. QR tidak berubah, operator tidak perlu berbuat apa-apa.
- **Batas harian** diatur `MAX_PER_HARI` dan `MAX_FOTO_PER_HARI` di `.gs`.
- **Jangan mengubah nama header** sheet "Pengajuan Asah" (kolom dipetakan berdasarkan nama header). Menyisipkan kolom aman.
- Alat yang diisi manual oleh operator ditandai `[MANUAL]` di kolom Kode Alat.
- Pengajuan tanpa sinyal tersimpan di perangkat dan baru terkirim saat aplikasi dibuka lagi. Layar hasil menampilkan cap "Belum Terkirim" dalam kasus ini.

## Catatan keamanan
Token tertanam di `index.html` (sengaja, supaya cukup scan QR) sehingga hanya berfungsi sebagai polisi tidur. Perlindungan utama ada di server: validasi, batas harian, email notifikasi, saklar jeda.
Script berjalan sebagai pemilik dan meminta izin Drive penuh; gunakan akun khusus gudang.
