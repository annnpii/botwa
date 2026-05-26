const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const creds = require("./credentials.json");

// =====================================================
// KONFIGURASI GOOGLE SHEETS
// =====================================================
const SPREADSHEET_ID = "1DXAllY9P26_593w-fcY0-qiI5Kg2hZrNwVV98Q4W9_E";
const TIMEZONE = "Asia/Kuala_Lumpur";
const SHEET_LOG = "Log_Laporan"; // Nama sheet buat log tiket

// =====================================================
// GOOGLE AUTH
// =====================================================
const serviceAccountAuth = new JWT({
  email: creds.client_email,
  key: creds.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// =====================================================
// WHATSAPP CLIENT
// =====================================================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    handleSIGINT: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// =====================================================
// QR LOGIN
// =====================================================
client.on("qr", (qr) => {
  console.log("📱 Scan QR Code berikut:");
  qrcode.generate(qr, { small: true });
});

// =====================================================
// BOT READY
// =====================================================
client.on("ready", async () => {
  try {
    await serviceAccountAuth.authorize();
    await doc.loadInfo();

    console.log("======================================");
    console.log("✅ BOT WHATSAPP ONLINE");
    console.log(`✅ Spreadsheet : ${doc.title}`);
    console.log(`🌏 Timezone : ${TIMEZONE}`);
    console.log("======================================");
  } catch (err) {
    console.error("❌ Gagal konek ke Google Sheets:", err.message);
    console.log(
      "Pastikan email service account di credentials.json sudah di-share ke spreadsheet.",
    );
  }
});

// =====================================================
// HELPER: FORMAT NOMOR
// =====================================================
function formatNomor(nomor) {
  nomor = String(nomor || "").replace(/\D/g, "");
  if (nomor.startsWith("0")) nomor = "62" + nomor.substring(1);
  if (nomor.startsWith("62")) return nomor;
  return null;
}

// =====================================================
// HELPER: KONVERSI JAM KE 24 JAM
// =====================================================
function convertJamKe24(jamString) {
  if (!jamString) return 0;
  const raw = String(jamString).trim().toUpperCase();
  if (/^\d+$/.test(raw)) return parseInt(raw);
  if (/^\d{1,2}:\d{2}$/.test(raw)) return parseInt(raw.split(":")[0]);
  const match = raw.match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)/);
  if (!match) return 0;
  let hour = parseInt(match[1]);
  const period = match[3];
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return hour;
}

// =====================================================
// HELPER: GENERATE ID TIKET - VERSI TANGGAL + URUT
// =====================================================
async function generateTiketID() {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
  );
  const tglKode = now
    .toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    })
    .replace(/\//g, "");
  const tglFilter = now.toLocaleDateString("id-ID"); // Format: 19/04/2025

  await doc.loadInfo();
  let sheetLog = doc.sheetsByTitle[SHEET_LOG];

  // Kalau sheet log belum ada, bikin dulu biar nggak error
  if (!sheetLog) {
    sheetLog = await doc.addSheet({
      title: SHEET_LOG,
      headerValues: [
        "ID_Tiket",
        "Timestamp",
        "Pelapor",
        "Isi_Laporan",
        "Grup",
        "Teknisi",
        "Status",
      ],
    });
    return `TKT${tglKode}-001`; // Langsung tiket pertama
  }

  const rows = await sheetLog.getRows();
  // Filter tiket yg dibuat hari ini berdasarkan kolom Timestamp
  const tiketHariIni = rows.filter((r) => {
    const timestamp = r.get("Timestamp") || "";
    return timestamp.startsWith(tglFilter);
  });

  const nomorUrut = (tiketHariIni.length + 1).toString().padStart(3, "0");

  return `TKT${tglKode}-${nomorUrut}`; // Hasil: TKT190425-001
}

// =====================================================
// HELPER: TULIS LOG TIKET BARU
// =====================================================
async function tulisLogTiket(data) {
  await doc.loadInfo();
  let sheetLog = doc.sheetsByTitle[SHEET_LOG];
  if (!sheetLog) {
    sheetLog = await doc.addSheet({
      title: SHEET_LOG,
      headerValues: [
        "ID_Tiket",
        "Timestamp",
        "Pelapor",
        "Isi_Laporan",
        "Grup",
        "Teknisi",
        "Status",
      ],
    });
  }
  await sheetLog.addRow(data);
}

// =====================================================
// HELPER: UPDATE STATUS TIKET
// =====================================================
async function updateStatusTiket(idTiket, status, namaTeknisi) {
  await doc.loadInfo();
  const sheetLog = doc.sheetsByTitle[SHEET_LOG];
  if (!sheetLog) return { success: false, reason: "Sheet log tidak ditemukan" };

  const rows = await sheetLog.getRows();
  const row = rows.find((r) => r.get("ID_Tiket") === idTiket);

  if (!row) return { success: false, reason: "Tiket tidak ditemukan" };
  if (row.get("Status") === "Selesai")
    return {
      success: false,
      reason: `Tiket sudah diselesaikan oleh ${row.get("Teknisi")}`,
    };

  row.set("Status", status);
  row.set("Teknisi", namaTeknisi);
  await row.save();
  return { success: true, grup: row.get("Grup") };
}

// =====================================================
// AMBIL TEKNISI YANG STANDBY
// =====================================================
async function getTeknisiStandby() {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  const now = new Date();
  const nowTZ = new Date(now.toLocaleString("en-US", { timeZone: TIMEZONE }));
  const jamSekarang = nowTZ.getHours();
  const menitSekarang = nowTZ.getMinutes();
  const tglHariIni = nowTZ.toLocaleDateString("en-GB");
  const kemarin = new Date(nowTZ);
  kemarin.setDate(kemarin.getDate() - 1);
  const tglKemarin = kemarin.toLocaleDateString("en-GB");
  const teknisiBertugas = [];

  rows.forEach((row) => {
    let tglSheetRaw = row.get("Tanggal");
    let tglSheet = "";
    if (tglSheetRaw instanceof Date) {
      tglSheet = tglSheetRaw.toLocaleDateString("en-GB");
    } else {
      tglSheet = String(tglSheetRaw || "").trim();
      const split = tglSheet.split("/");
      if (split.length === 3) {
        tglSheet = `${split[0].padStart(2, "0")}/${split[1].padStart(2, "0")}/${split[2]}`;
      }
    }

    const nama = String(row.get("Nama") || "").trim();
    const nomor = formatNomor(row.get("Nomor") || "");
    const mulai = convertJamKe24(row.get("Jam_Mulai"));
    const selesai = convertJamKe24(row.get("Jam_Selesai"));
    if (!nama || !nomor) return;

    let sedangShift = false;
    if (mulai < selesai) {
      // SHIFT NORMAL
      if (tglSheet === tglHariIni)
        sedangShift = jamSekarang >= mulai && jamSekarang < selesai;
    } else {
      // SHIFT MALAM
      if (tglSheet === tglHariIni && jamSekarang >= mulai) sedangShift = true;
      if (tglSheet === tglKemarin && jamSekarang < selesai) sedangShift = true;
    }

    if (sedangShift) {
      console.log(
        `✅ SHIFT AKTIF -> ${nama} | ${tglSheet} | ${mulai}:00-${selesai}:00 | sekarang ${jamSekarang}:${String(menitSekarang).padStart(2, "0")}`,
      );
      teknisiBertugas.push({ nama, nomor });
    }
  });

  return { teknisiBertugas, jamSekarang, menitSekarang, tglHariIni };
}

// =====================================================
// EVENT PESAN MASUK
// =====================================================
client.on("message", async (message) => {
  try {
    const pesan = String(message.body || "").toLowerCase();
    if (message.fromMe) return;
    const chat = await message.getChat();
    const namaGrup = chat.isGroup ? chat.name : "Chat Pribadi";
    const pengirim = message.author || message.from;

    // ==================== FITUR: ISTIRAHAT (KHUSUS GRUP PBM "BSS MANADO") ====================
    // Regex untuk mendeteksi pola: apa_saja_istirahat
    const patternIstirahat = /^(\w+)_istirahat$/;
    const matchIstirahat = pesan.match(patternIstirahat);

    if (
      (matchIstirahat && namaGrup === 'PBM "BSS MANADO"',
      "BSS MAINTENANCE MANADO")
    ) {
      const namaUser = matchIstirahat[1];
      const durasi = 60 * 60 * 1000; // 1 Jam dalam milidetik

      // Hitung waktu selesai
      const waktuSekarang = new Date(
        new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
      );
      const waktuSelesai = new Date(waktuSekarang.getTime() + durasi);

      const jamSelesai = String(waktuSelesai.getHours()).padStart(2, "0");
      const menitSelesai = String(waktuSelesai.getMinutes()).padStart(2, "0");

      // Balasan awal
      await message.reply(
        `✅ Laporan istirahat diterima untuk *${namaUser}*.\n\n` +
          `🕒 Dimulai: ${String(waktuSekarang.getHours()).padStart(2, "0")}:${String(waktuSekarang.getMinutes()).padStart(2, "0")}\n` +
          `🔔 Alarm Selesai: *${jamSelesai}:${menitSelesai}* (1 Jam kemudian)`,
      );

      // Set Timer Alert
      setTimeout(async () => {
        try {
          await client.sendMessage(
            chat.id._serialized,
            `🔔 *ALERT ISTIRAHAT SELESAI* 🔔\n\n` +
              `Halo @${pengirim.split("@")[0]}, waktu istirahat untuk *${namaUser}* sudah habis (1 jam).\n\n` +
              `Waktu menunjukkan pukul: *${jamSelesai}:${menitSelesai}*`,
            { mentions: [pengirim] },
          );
        } catch (e) {
          console.error("Gagal mengirim alert istirahat:", e);
        }
      }, durasi);

      return; // Stop eksekusi agar tidak masuk ke trigger error/teknisi
    }

    // ==================== FITUR: TEKNISI SELESAIKAN TIKET ====================
    if (pesan.startsWith("selesai ") || pesan.startsWith("done ")) {
      // ... (Kode fitur selesai Anda yang sudah ada tetap di sini)
      // Pastikan fungsi ini tetap utuh seperti kode asli Anda
    }

    // ==================== LOGIKA TRIGGER ERROR / TEKNISI ====================
    // Abaikan jika pengirim adalah teknisi
    const teknisiIgnore = [
      "62895383373518",
      "6283135866920",
      "6285656682827",
      "6289618934448",
      "6289698316056",
    ];
    if (teknisiIgnore.includes(pengirim.split("@")[0])) return;

    const adaTrigger =
      pesan.includes("error") ||
      pesan.includes("eror") ||
      pesan.includes("delay") ||
      pesan.includes("kendala") ||
      (pesan.includes("bantuan") && !pesan.includes("perbantuan")) ||
      pesan.includes("masalah") ||
      pesan.includes("teknisi");

    if (!adaTrigger) return;

    // ... (Sisa kode log tiket dan notifikasi teknisi Anda)
    // Lanjutkan dengan kode asli Anda mulai dari "const { teknisiBertugas ... }"

    console.log(`📩 Trigger diterima dari ${message.from}`);
    console.log(`Pesan: ${message.body}`);

    const { teknisiBertugas, jamSekarang, menitSekarang, tglHariIni } =
      await getTeknisiStandby();
    const chat = await message.getChat();
    const namaGrup = chat.isGroup ? chat.name : "Chat Pribadi";

    // BIKIN TIKET BARU - UDAH PAKE AWAIT
    const idTiket = await generateTiketID();
    const timestamp = new Date().toLocaleString("id-ID", {
      timeZone: TIMEZONE,
    });

    await tulisLogTiket({
      ID_Tiket: idTiket,
      Timestamp: timestamp,
      Pelapor: pengirim.split("@")[0],
      Isi_Laporan: message.body,
      Grup: namaGrup,
      Teknisi: teknisiBertugas.map((t) => t.nama).join(", ") || "Belum ada",
      Status: "Open",
    });

    if (teknisiBertugas.length === 0) {
      const sheet = doc.sheetsByIndex[0];
      const rows = await sheet.getRows();
      const namaPrioritas = ["Alesandro", "Raldy", "Junifer", "Ryan", "Ragil"];
      const mentions = [];
      const mentionText = [];
      const sudahDitambahkan = new Set();

      for (const row of rows) {
        const nama = String(row.get("Nama") || "").trim();
        const nomor = formatNomor(row.get("Nomor") || "");
        if (
          !nama ||
          !nomor ||
          !namaPrioritas.includes(nama) ||
          sudahDitambahkan.has(nama)
        )
          continue;
        sudahDitambahkan.add(nama);
        mentionText.push(`@${nomor}`);
        mentions.push(`${nomor}@c.us`);
      }

      await message.reply(
        `⚠️ *Saat ini tidak ada teknisi yang standby* ⚠️\n` +
          `ID Tiket: *${idTiket}*\n\n` +
          `${mentionText.join(" ")}\n\n` +
          `🕒 ${String(jamSekarang).padStart(2, "0")}:${String(menitSekarang).padStart(2, "0")}\n` +
          `📅 ${tglHariIni}\n\n` +
          `Silahkan menghubungi teknisi untuk dibantu kendalanya!`,
        undefined,
        { mentions },
      );
      return;
    }

    const mentions = [];
    const daftarTeknisi = teknisiBertugas
      .map((t) => {
        mentions.push(`${t.nomor}@c.us`);
        return `${t.nama}\n- @${t.nomor}`;
      })
      .join("\n\n");

    await message.reply(
      `🚨 *Terimakasih Laporannya!* 🚨\n` +
        `ID Tiket: *${idTiket}*\n\n` +
        `*Teknisi Standby Saat Ini:*\n${daftarTeknisi}\n\n` +
        `🕒 ${String(jamSekarang).padStart(2, "0")}:${String(menitSekarang).padStart(2, "0")}\n` +
        `📅 ${tglHariIni}\n\n` +
        `Kendalanya sudah di infokan ke teknisi, mohon tunggu sebentar.\n\n` +
        `Jika tidak ada respon selama 2 menit,\n` +
        `silakan lakukan panggilan telepon.`,
      undefined,
      { mentions },
    );

    for (const teknisi of teknisiBertugas) {
      try {
        const chatId = `${teknisi.nomor}@c.us`;
        const nomorTiketPendek = idTiket.split("-")[1]; // Ambil 001 dari TKT190425-001
        await client.sendMessage(
          chatId,
          `🚨 *Bro ada Laporan ini* 🚨\n` +
            `ID Tiket: *${idTiket}*\n\n` +
            `Dari grup : ${namaGrup}\n\n` +
            `Isi Laporan:\n"${message.body}"\n\n` +
            `🕒 Waktu: ${String(jamSekarang).padStart(2, "0")}:${String(menitSekarang).padStart(2, "0")} | 📅 ${tglHariIni}\n\n` +
            `*Kalo udah kelar, bales:*\n` +
            `SELESAI ${nomorTiketPendek}`,
        );
        console.log(`✅ Berhasil kirim ke ${teknisi.nama} (${teknisi.nomor})`);
      } catch (err) {
        console.error(`❌ Gagal kirim ke ${teknisi.nama} (${teknisi.nomor})`);
        console.error(err.message);
      }
    }
  } catch (error) {
    console.error("❌ Error utama:", error);
    try {
      await message.reply("⚠️ Terjadi kesalahan saat memproses laporan.");
    } catch {}
  }
});

// =====================================================
// AUTH FAILURE
// =====================================================
client.on("auth_failure", (msg) => {
  console.error("❌ Auth Failure:", msg);
});

// =====================================================
// DISCONNECTED
// =====================================================
client.on("disconnected", (reason) => {
  console.log("⚠️ Bot disconnected:", reason);
});

// =====================================================
// START BOT
// =====================================================
client.initialize();
