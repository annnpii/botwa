const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const creds = require("./credentials.json");
const cron = require("node-cron");

// =====================================================
// KONFIGURASI GOOGLE SHEETS + ISTIRAHAT
// =====================================================
const SPREADSHEET_ID = "1DXAllY9P26_593w-fcY0-qiI5Kg2hZrNwVV98Q4W9_E";
const TIMEZONE = "Asia/Kuala_Lumpur";
const SHEET_LOG = "Log_Laporan";
const SHEET_ISTIRAHAT = "Data_Istirahat";

// =====================================================
// KONSTANTA REMOTE ACCESS
// =====================================================
const SHEET_REMOTE = "Data_Remote";
const GRUP_REMOTE = "bss maintenance manado"; // nama grup lowercase, tanpa trailing space

let cacheRemote = new Map(); // key: lokasi lowercase, value: { anydesk, rustdesk, lokasiAsli }
let lastLoadRemote = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // refresh cache tiap 5 menit

// =====================================================
// KONSTANTA P3
// =====================================================
const SHEET_P3 = "Data_P3";
const ZONA_P3_VALID = ["B", "C", "D", "E", "F"];
// Jam batas tepat waktu: 03:07 (jam 3 pagi 7 menit)
const P3_BATAS_JAM = 3;
const P3_BATAS_MENIT = 7;

// dataP3HariIni: Map key=nomorPengirim, value={ nama, zona, jamTrigger, timestampTrigger, grup }
const dataP3HariIni = new Map();

// =====================================================

const GRUP_ISTIRAHAT_RAW = ['PBM "BSS MANADO"', "BSS MAINTENANCE MANADO"];
const GRUP_ISTIRAHAT = GRUP_ISTIRAHAT_RAW.map((nama) =>
  nama.trim().toLowerCase(),
);

const ADMIN_ISTIRAHAT = [
  "62895803663572", //aan
  "6289618665936", //christa
  "6282217379868",
  "6281347736124", //irvan
  "6282123073317", //yuyun
  "6285824046645",
  "6283131036921",
  "6288245360567", //arthur
  "62895415672111", //riski
  "6283131036981", //olive
  "6285757637390", //pingkan
  "6285824046645", //firly
];

const SPL = [
  "Yusuf",
  "Rio",
  "Aldi",
  "Hanok",
  "Christian",
  "Reinal",
  "Aprianto",
  "Valen",
  "Christna",
  "Aldo",
  "Billy",
  "Sisko",
  "Alfa",
  "Kifly",
  "Naldy",
  "Michael",
  "Rommy",
  "Calvin",
  "Immanuel",
  "Kristian",
].map((n) => n.toUpperCase());

const sedangIstirahat = new Map();
const historyIstirahatHariIni = {
  shift1: [],
  shift2: [],
};

const tiketOpenPerGrup = new Map();

const reminderTiketAktif = new Map();

const teknisiIgnore = [
  "62895383373518",
  "6283135866920",
  "6285656682827",
  "6289618934448",
  "6289698316056",
  "62895803663572",
];

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
// HELPER: CEK APAKAH MASIH HARI YANG SAMA
// =====================================================
function isSameDateInTZ(timestampMs) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
  );
  const tglTarget = new Date(
    new Date(timestampMs).toLocaleString("en-US", { timeZone: TIMEZONE }),
  );

  return (
    now.getFullYear() === tglTarget.getFullYear() &&
    now.getMonth() === tglTarget.getMonth() &&
    now.getDate() === tglTarget.getDate()
  );
}

// =====================================================
// LOAD & RESTORE ISTIRAHAT DARI SHEET
// =====================================================
async function loadDanRestoreIstirahat() {
  try {
    await doc.loadInfo();
    let sheetIstirahat = doc.sheetsByTitle[SHEET_ISTIRAHAT];

    if (!sheetIstirahat) {
      sheetIstirahat = await doc.addSheet({
        title: SHEET_ISTIRAHAT,
        headerValues: [
          "Nomor",
          "Nama",
          "JamMulai",
          "JamSelesai",
          "TimestampSelesai",
          "DurasiMenit",
          "Grup",
          "Status",
        ],
      });
      console.log("📋 Sheet Data_Istirahat dibuat");
      return;
    }

    const rows = await sheetIstirahat.getRows();
    sedangIstirahat.clear();
    const now = new Date().getTime();

    for (const row of rows) {
      if (row.get("Status") !== "Aktif") continue;

      const nomor = row.get("Nomor");
      const nama = row.get("Nama");
      const timestampSelesai = parseInt(row.get("TimestampSelesai"));
      const sisaMs = timestampSelesai - now;

      if (!isSameDateInTZ(timestampSelesai)) {
        await row.delete();
        console.log(`[RESTORE] ${nama} dari hari berbeda, dihapus otomatis`);
        continue;
      }

      if (sisaMs > 0) {
        const timeoutId = setTimeout(async () => {
          try {
            const semuaChat = await client.getChats();
            const grupChat = semuaChat.find((c) => c.name === row.get("Grup"));
            if (grupChat) {
              await client.sendMessage(
                grupChat.id._serialized,
                `🔔 *ISTIRAHAT SELESAI* 🔔\n\n` +
                  `@${nama}, waktu istirahat untuk *${nama}* telah berakhir.\n\n` +
                  `🕒 Berakhir pada: *${row.get("JamSelesai")}*\n\n\n` +
                  `Silahkan kembali ke Plotingan \nTetap Semangat 😁.`,
                { mentions: [nomor] },
              );
            }
            await hapusIstirahatDariSheet(nomor);
          } catch (e) {
            await hapusIstirahatDariSheet(nomor);
          }
        }, sisaMs);

        sedangIstirahat.set(nomor, {
          nama: nama,
          jamMulai: row.get("JamMulai"),
          jamSelesai: row.get("JamSelesai"),
          timestampSelesai: timestampSelesai,
          durasiMenit: parseInt(row.get("DurasiMenit")),
          timeoutId: timeoutId,
          grup: row.get("Grup"),
        });
        console.log(
          `[RESTORE] ${nama} dilanjut, sisa ${Math.round(sisaMs / 1000 / 60)} menit`,
        );
      } else {
        await row.delete();
        sedangIstirahat.delete(nomor);
        console.log(`[RESTORE] ${nama} udah lewat, dihapus`);
      }
    }
    console.log(`📋 Istirahat aktif dimuat: ${sedangIstirahat.size} orang`);
  } catch (err) {
    console.error("❌ Gagal restore istirahat:", err.message);
  }
}

// =====================================================
// SIMPAN ISTIRAHAT KE SHEET
// =====================================================
async function simpanIstirahatKeSheet(data) {
  try {
    await doc.loadInfo();
    let sheetIstirahat = doc.sheetsByTitle[SHEET_ISTIRAHAT];
    if (!sheetIstirahat) {
      sheetIstirahat = await doc.addSheet({
        title: SHEET_ISTIRAHAT,
        headerValues: [
          "Nomor",
          "Nama",
          "JamMulai",
          "JamSelesai",
          "TimestampSelesai",
          "DurasiMenit",
          "Grup",
          "Status",
        ],
      });
    }
    await sheetIstirahat.addRow({
      Nomor: data.nomor,
      Nama: data.nama,
      JamMulai: data.jamMulai,
      JamSelesai: data.jamSelesai,
      TimestampSelesai: data.timestampSelesai,
      DurasiMenit: data.durasiMenit,
      Grup: data.grup,
      Status: "Aktif",
    });
  } catch (err) {
    console.error("❌ Gagal simpan istirahat:", err.message);
  }
}

// =====================================================
// HAPUS ISTIRAHAT DARI SHEET
// =====================================================
async function hapusIstirahatDariSheet(nomor) {
  try {
    const sheetIstirahat = doc.sheetsByTitle[SHEET_ISTIRAHAT];
    if (!sheetIstirahat) return;

    const rows = await sheetIstirahat.getRows();
    const row = rows.find((r) => r.get("Nomor") === nomor);
    if (row) await row.delete();

    sedangIstirahat.delete(nomor);
  } catch (err) {
    console.error("❌ Gagal hapus istirahat:", err.message);
  }
}

// =====================================================
// RESET SEMUA ISTIRAHAT (CRON TENGAH MALAM)
// =====================================================
async function resetSemuaIstirahat() {
  console.log("[RESET] Membersihkan semua istirahat aktif (pergantian hari)");
  try {
    for (const [nomor, data] of sedangIstirahat.entries()) {
      if (data.timeoutId) clearTimeout(data.timeoutId);
    }
    sedangIstirahat.clear();

    const sheetIstirahat = doc.sheetsByTitle[SHEET_ISTIRAHAT];
    if (sheetIstirahat) {
      const rows = await sheetIstirahat.getRows();
      for (const row of rows) {
        if (row.get("Status") === "Aktif") await row.delete();
      }
    }

    historyIstirahatHariIni.shift1 = [];
    historyIstirahatHariIni.shift2 = [];

    console.log("[RESET] Semua istirahat berhasil dibersihkan");
  } catch (err) {
    console.error("[RESET] Gagal reset istirahat:", err.message);
  }
}

// =====================================================
// LOAD TIKET OPEN SAAT BOT START
// =====================================================
async function loadTiketOpenDariSheet() {
  try {
    await doc.loadInfo();
    const sheetLog = doc.sheetsByTitle[SHEET_LOG];
    if (!sheetLog) {
      console.log("📋 Sheet log belum ada, skip load cache");
      return;
    }

    const rows = await sheetLog.getRows();
    tiketOpenPerGrup.clear();

    rows.forEach((r) => {
      if (r.get("Status") === "Open") {
        const grup = String(r.get("Grup") || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        if (grup && grup !== "chat pribadi" && !tiketOpenPerGrup.has(grup)) {
          tiketOpenPerGrup.set(grup, {
            idTiket: r.get("ID_Tiket"),
            pelapor: r.get("Pelapor"),
            timestamp: r.get("Timestamp"),
            teknisi: r.get("Teknisi") || "",
          });
        }
      }
    });
    console.log(`📋 Cache tiket open dimuat: ${tiketOpenPerGrup.size} grup`);
    if (tiketOpenPerGrup.size > 0) {
      console.log(" Grup yg lagi ada tiket open:");
      tiketOpenPerGrup.forEach((v, k) => console.log(` - ${k}: ${v.idTiket}`));
    }
  } catch (err) {
    console.error("❌ Gagal load tiket open:", err.message);
  }
}

// =====================================================
// SET REMINDER TIKET BELUM SELESAI
// =====================================================
function setReminderTiket(idTiket, teknisiList, namaGrup, isiLaporan) {
  if (reminderTiketAktif.has(idTiket)) {
    clearTimeout(reminderTiketAktif.get(idTiket).timeoutId);
  }

  const timeoutId = setTimeout(
    async () => {
      await kirimReminderTiket(idTiket, teknisiList, namaGrup, isiLaporan, 1);
    },
    5 * 60 * 1000,
  );

  reminderTiketAktif.set(idTiket, {
    timeoutId,
    teknisiList,
    namaGrup,
    isiLaporan,
    reminderKe: 1,
  });

  console.log(`[REMINDER] Set reminder tiket ${idTiket} dalam 5 menit`);
}

async function kirimReminderTiket(
  idTiket,
  teknisiList,
  namaGrup,
  isiLaporan,
  reminderKe,
) {
  try {
    await doc.loadInfo();
    const sheetLog = doc.sheetsByTitle[SHEET_LOG];
    if (!sheetLog) return;

    const rows = await sheetLog.getRows();
    const row = rows.find((r) => r.get("ID_Tiket") === idTiket);

    if (!row || row.get("Status") !== "Open") {
      reminderTiketAktif.delete(idTiket);
      console.log(
        `[REMINDER] Tiket ${idTiket} sudah selesai, reminder dibatalkan`,
      );
      return;
    }

    const nomorTiketPendek = idTiket.split("-")[1];
    for (const teknisi of teknisiList) {
      try {
        await client.sendMessage(
          `${teknisi.nomor}@c.us`,
          `🔴 *REMINDER #${reminderKe} - TIKET BELUM SELESAI!*\n\n` +
            `🎫 ID Tiket: *${idTiket}*\n` +
            `📍 Grup: ${namaGrup}\n\n` +
            `📋 Laporan:\n"${isiLaporan}"\n\n` +
            `⚠️ Tiket ini belum kamu selesaikan!\n\n` +
            `*Jika sudah ditangani, bales:*\n` +
            `SELESAI ${nomorTiketPendek}\n` +
            `[deskripsi solusi]`,
        );
        console.log(
          `[REMINDER] Reminder #${reminderKe} terkirim ke ${teknisi.nama}`,
        );
      } catch (err) {
        console.error(
          `[REMINDER] Gagal kirim ke ${teknisi.nama}:`,
          err.message,
        );
      }
    }

    const intervalMs = 10 * 60 * 1000;
    const nextTimeoutId = setTimeout(async () => {
      await kirimReminderTiket(
        idTiket,
        teknisiList,
        namaGrup,
        isiLaporan,
        reminderKe + 1,
      );
    }, intervalMs);

    reminderTiketAktif.set(idTiket, {
      timeoutId: nextTimeoutId,
      teknisiList,
      namaGrup,
      isiLaporan,
      reminderKe: reminderKe + 1,
    });
    console.log(
      `[REMINDER] Set reminder #${reminderKe + 1} untuk tiket ${idTiket}`,
    );
  } catch (err) {
    console.error("[REMINDER] Error kirim reminder:", err.message);
  }
}

// =====================================================
// LOAD DATA REMOTE DARI SHEET
// =====================================================
async function loadDataRemote(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    now - lastLoadRemote < CACHE_TTL_MS &&
    cacheRemote.size > 0
  ) {
    return; // cache masih fresh, skip
  }

  try {
    await doc.loadInfo();
    let sheetRemote = doc.sheetsByTitle[SHEET_REMOTE];

    if (!sheetRemote) {
      sheetRemote = await doc.addSheet({
        title: SHEET_REMOTE,
        headerValues: ["Lokasi", "Anydesk", "Rustdesk", "Password"],
      });
      console.log(
        `📋 Sheet ${SHEET_REMOTE} dibuat. Isi datanya di spreadsheet.`,
      );
      return;
    }

    const rows = await sheetRemote.getRows();
    cacheRemote.clear();

    for (const row of rows) {
      const lokasi = String(row.get("Lokasi") || "").trim();
      const anydesk = String(row.get("Anydesk") || "").trim();
      const rustdesk = String(row.get("Rustdesk") || "").trim();

      if (!lokasi) continue;

      const password = String(row.get("Password") || "").trim();
      cacheRemote.set(lokasi.toLowerCase(), {
        lokasiAsli: lokasi,
        anydesk: anydesk || null,
        rustdesk: rustdesk || null,
        password: password || null,
      });
    }

    lastLoadRemote = now;
    console.log(`📡 Cache remote dimuat: ${cacheRemote.size} lokasi`);
  } catch (err) {
    console.error("❌ Gagal load data remote:", err.message);
  }
}

// =====================================================
// P3 - SIMPAN KE SHEET Data_P3
// =====================================================
async function simpanP3KeSheet(data) {
  try {
    await doc.loadInfo();
    let sheetP3 = doc.sheetsByTitle[SHEET_P3];
    if (!sheetP3) {
      sheetP3 = await doc.addSheet({
        title: SHEET_P3,
        headerValues: [
          "Tanggal",
          "Nomor",
          "Nama",
          "Zona",
          "JamTrigger",
          "TimestampTrigger",
          "Status",
          "Grup",
        ],
      });
      console.log(`📋 Sheet ${SHEET_P3} dibuat`);
    }
    await sheetP3.addRow({
      Tanggal: data.tanggal,
      Nomor: data.nomor,
      Nama: data.nama,
      Zona: data.zona,
      JamTrigger: data.jamTrigger,
      TimestampTrigger: data.timestampTrigger,
      Status: data.status,
      Grup: data.grup,
    });
    console.log(`[P3] Data ${data.nama} Zona ${data.zona} disimpan ke sheet`);
  } catch (err) {
    console.error("❌ Gagal simpan P3 ke sheet:", err.message);
  }
}

// =====================================================
// P3 - LOAD DATA HARI INI DARI SHEET (saat bot restart)
// =====================================================
async function loadDataP3HariIni() {
  try {
    await doc.loadInfo();
    let sheetP3 = doc.sheetsByTitle[SHEET_P3];

    if (!sheetP3) {
      sheetP3 = await doc.addSheet({
        title: SHEET_P3,
        headerValues: [
          "Tanggal",
          "Nomor",
          "Nama",
          "Zona",
          "JamTrigger",
          "TimestampTrigger",
          "Status",
          "Grup",
        ],
      });
      console.log(`📋 Sheet ${SHEET_P3} dibuat`);
      return;
    }

    const rows = await sheetP3.getRows();
    dataP3HariIni.clear();

    const nowTZ = new Date(
      new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
    );
    const tglHariIni = nowTZ.toLocaleDateString("id-ID");

    for (const row of rows) {
      const tglRow = row.get("Tanggal");
      if (tglRow !== tglHariIni) continue;

      const nomor = row.get("Nomor");
      dataP3HariIni.set(nomor, {
        nama: row.get("Nama"),
        zona: row.get("Zona"),
        jamTrigger: row.get("JamTrigger"),
        timestampTrigger: parseInt(row.get("TimestampTrigger")),
        status: row.get("Status"),
        grup: row.get("Grup"),
      });
    }

    console.log(`📋 Data P3 hari ini dimuat: ${dataP3HariIni.size} orang`);
  } catch (err) {
    console.error("❌ Gagal load data P3:", err.message);
  }
}

// =====================================================
// P3 - HELPER: CEK STATUS TEPAT WAKTU / TERLAMBAT
// =====================================================
function cekStatusP3(timestampTrigger) {
  // Ambil jam & menit dari timestamp dalam timezone
  const tgl = new Date(
    new Date(timestampTrigger).toLocaleString("en-US", { timeZone: TIMEZONE }),
  );
  const jam = tgl.getHours();
  const menit = tgl.getMinutes();

  // Tepat waktu jika <= 03:07
  const totalMenitTrigger = jam * 60 + menit;
  const totalMenitBatas = P3_BATAS_JAM * 60 + P3_BATAS_MENIT;

  if (totalMenitTrigger <= totalMenitBatas) {
    return "Tepat Waktu";
  } else {
    return "Terlambat";
  }
}

// =====================================================
// P3 - KIRIM REKAP JAM 11:00
// =====================================================
async function kirimRekapP3(targetChatId = null) {
  try {
    const nowTZ = new Date(
      new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
    );
    const tglHariIni = nowTZ.toLocaleDateString("id-ID", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    });

    // Jam rekap selesai (11:00)
    const jamRekap = "11:00";

    let teks = `📊 *REKAP P3 HARIAN*\n`;
    teks += `📅 ${tglHariIni}\n`;
    teks += `⏰ Rekap per jam ${jamRekap}\n`;
    teks += `================================\n\n`;

    if (dataP3HariIni.size === 0) {
      teks += `_Tidak ada yang melakukan P3 hari ini._`;
    } else {
      // Urutkan berdasarkan timestamp
      const sorted = [...dataP3HariIni.entries()].sort(
        (a, b) => a[1].timestampTrigger - b[1].timestampTrigger,
      );

      teks += `*Total: ${sorted.length} orang*\n\n`;

      // Kelompokkan per zona
      const zonaMap = {};
      for (const [nomor, data] of sorted) {
        if (!zonaMap[data.zona]) zonaMap[data.zona] = [];
        zonaMap[data.zona].push({ nomor, ...data });
      }

      // Zona urut A-Z
      const zonaUrut = Object.keys(zonaMap).sort();

      for (const zona of zonaUrut) {
        teks += `*📍 Zona ${zona}*\n`;
        zonaMap[zona].forEach((d, i) => {
          const statusEmoji = d.status === "Tepat Waktu" ? "✅" : "⚠️";
          const statusLabel =
            d.status === "Tepat Waktu"
              ? "Tepat Waktu"
              : "Terlambat berada di zona kerja";
          teks += `${i + 1}. *${d.nama}* : ${d.jamTrigger} - ${jamRekap} | ${statusEmoji} ${statusLabel}\n`;
        });
        teks += `\n`;
      }

      teks += `================================\n`;
      teks += `_Laporan otomatis setiap jam 11:00_`;
    }

    // Kirim ke semua grup istirahat (atau targetChatId kalau manual)
    if (targetChatId) {
      await client.sendMessage(targetChatId, teks);
      console.log(`[P3] Rekap manual terkirim ke ${targetChatId}`);
    } else {
      for (const namaGrup of GRUP_ISTIRAHAT_RAW) {
        try {
          const semuaChat = await client.getChats();
          const grupChat = semuaChat.find((c) => c.name === namaGrup);
          if (grupChat) {
            await client.sendMessage(grupChat.id._serialized, teks);
            console.log(`[P3] Rekap P3 terkirim ke ${namaGrup}`);
          }
        } catch (err) {
          console.error(`[P3] Gagal kirim rekap ke ${namaGrup}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("[P3] Error kirim rekap:", err.message);
  }
}

// =====================================================
// P3 - RESET DATA (CRON TENGAH MALAM)
// =====================================================
async function resetDataP3() {
  dataP3HariIni.clear();
  console.log("[RESET] Data P3 hari ini direset");
}

client.on("ready", async () => {
  try {
    await serviceAccountAuth.authorize();
    await doc.loadInfo();
    await loadTiketOpenDariSheet();
    await loadDanRestoreIstirahat();
    await loadDataRemote(); // load data remote saat bot start
    await loadDataP3HariIni(); // load data P3 hari ini saat bot start

    // CRON REKAP SHIFT 1 - JAM 13:00
    cron.schedule(
      "0 13 * * *",
      async () => {
        console.log("[CRON] Kirim rekap Shift 1...");
        const dataShift1 = historyIstirahatHariIni.shift1;
        const tglHariIni = new Date().toLocaleDateString("id-ID", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        });

        let teksRekap = `📊 *REKAP ISTIRAHAT SHIFT 1*\n`;
        teksRekap += `📅 ${tglHariIni}\n`;
        teksRekap += `⏰ Periode: 05:00 - 12:59\n`;
        teksRekap += `================================\n\n`;

        if (dataShift1.length === 0) {
          teksRekap += `_Tidak ada yang istirahat di Shift 1 hari ini._`;
        } else {
          teksRekap += `*Total: ${dataShift1.length} orang*\n\n`;
          const mentionList = [];
          dataShift1.forEach((d, i) => {
            mentionList.push(d.nomor);
            teksRekap += `${i + 1}. *${d.nama}* - ${d.jamMulai} s/d ${d.jamSelesai} (${d.durasiMenit}m)\n`;
          });
          teksRekap += `\n================================\n`;
          teksRekap += `_Laporan otomatis setiap jam 13:00_`;

          for (const namaGrup of GRUP_ISTIRAHAT_RAW) {
            try {
              const semuaChat = await client.getChats();
              const grupChat = semuaChat.find((c) => c.name === namaGrup);
              if (grupChat) {
                await client.sendMessage(grupChat.id._serialized, teksRekap, {
                  mentions: mentionList,
                });
                console.log(`[CRON] Rekap Shift 1 terkirim ke ${namaGrup}`);
              }
            } catch (err) {
              console.error(`[CRON] Gagal kirim ke ${namaGrup}:`, err.message);
            }
          }
        }
        historyIstirahatHariIni.shift1 = [];
        console.log("[CRON] History Shift 1 direset");
      },
      { timezone: "Asia/Kuala_Lumpur" },
    );

    // CRON REKAP SHIFT 2 - JAM 21:00
    cron.schedule(
      "0 21 * * *",
      async () => {
        console.log("[CRON] Kirim rekap Shift 2...");
        const dataShift2 = historyIstirahatHariIni.shift2;
        const tglHariIni = new Date().toLocaleDateString("id-ID", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          year: "numeric",
        });

        let teksRekap = `📊 *REKAP ISTIRAHAT SHIFT 2*\n`;
        teksRekap += `📅 ${tglHariIni}\n`;
        teksRekap += `⏰ Periode: 13:00 - 20:59\n`;
        teksRekap += `================================\n\n`;

        if (dataShift2.length === 0) {
          teksRekap += `_Tidak ada yang istirahat di Shift 2 hari ini._`;
        } else {
          teksRekap += `*Total: ${dataShift2.length} orang*\n\n`;
          const mentionList = [];
          dataShift2.forEach((d, i) => {
            mentionList.push(d.nomor);
            teksRekap += `${i + 1}. *${d.nama}* - ${d.jamMulai} s/d ${d.jamSelesai} (${d.durasiMenit}m)\n`;
          });
          teksRekap += `\n================================\n`;
          teksRekap += `_Laporan otomatis setiap jam 21:00_`;

          for (const namaGrup of GRUP_ISTIRAHAT_RAW) {
            try {
              const semuaChat = await client.getChats();
              const grupChat = semuaChat.find((c) => c.name === namaGrup);
              if (grupChat) {
                await client.sendMessage(grupChat.id._serialized, teksRekap, {
                  mentions: mentionList,
                });
                console.log(`[CRON] Rekap Shift 2 terkirim ke ${namaGrup}`);
              }
            } catch (err) {
              console.error(`[CRON] Gagal kirim ke ${namaGrup}:`, err.message);
            }
          }
        }
        historyIstirahatHariIni.shift2 = [];
        console.log("[CRON] History Shift 2 direset");
      },
      { timezone: "Asia/Kuala_Lumpur" },
    );

    // CRON RESET ISTIRAHAT SETIAP TENGAH MALAM (00:01)
    cron.schedule(
      "1 0 * * *",
      async () => {
        console.log("[CRON] Reset istirahat tengah malam...");
        await resetSemuaIstirahat();
        await resetDataP3(); // reset P3 juga
      },
      { timezone: "Asia/Kuala_Lumpur" },
    );

    // =====================================================
    // CRON REKAP P3 - JAM 11:00
    // =====================================================
    cron.schedule(
      "0 11 * * *",
      async () => {
        console.log("[CRON] Kirim rekap P3...");
        await kirimRekapP3();
        // Setelah rekap terkirim, data tetap ada untuk referensi,
        // baru reset saat tengah malam
      },
      { timezone: "Asia/Kuala_Lumpur" },
    );

    console.log("======================================");
    console.log("✅ BOT WHATSAPP ONLINE");
    console.log(`✅ Spreadsheet : ${doc.title}`);
    console.log(`🌏 Timezone : ${TIMEZONE}`);
    console.log(`📋 Grup Istirahat : ${GRUP_ISTIRAHAT_RAW.join(", ")}`);
    console.log(`👑 Admin Istirahat : ${ADMIN_ISTIRAHAT.join(", ")}`);
    console.log(`🎫 Tiket Open Aktif : ${tiketOpenPerGrup.size} grup`);
    console.log(`👥 SPL Terdaftar : ${SPL.length} orang`);
    console.log(`📡 Remote Cache : ${cacheRemote.size} lokasi`);
    console.log(`📍 P3 Hari Ini : ${dataP3HariIni.size} orang`);
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
// HELPER: HITUNG DURASI ISTIRAHAT
// =====================================================
function hitungDurasiIstirahat(namaUser) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
  );
  const hari = now.getDay();
  const jam = now.getHours();
  const isWeekend = hari === 0 || hari === 6;
  const isSPL = SPL.includes(String(namaUser || "").toUpperCase());

  let durasiMenit = 60;
  let namaShift = "Shift 2";
  let aturanDipake = "";

  if (jam >= 5 && jam < 13) {
    namaShift = "Shift 1";
    if (isWeekend) {
      durasiMenit = isSPL ? 60 : 90;
      aturanDipake = isSPL ? "SPL Weekend" : "Non-SPL Weekend";
    } else {
      durasiMenit = 50;
      aturanDipake = "Weekday";
    }
  } else if (jam >= 13 && jam < 21) {
    namaShift = "Shift 2";
    durasiMenit = 60;
    aturanDipake = "Shift 2";
  }

  console.log(
    `[ISTIRAHAT] ${namaUser} | ${aturanDipake} | ${durasiMenit} menit`,
  );

  return {
    durasiMs: durasiMenit * 60 * 1000,
    durasiMenit: durasiMenit,
    namaShift: namaShift,
    isWeekend: isWeekend,
    isSPL: isSPL,
  };
}

// =====================================================
// HELPER: GENERATE ID TIKET
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
  const tglFilter = now.toLocaleDateString("id-ID");

  await doc.loadInfo();
  let sheetLog =
    doc.sheetsByTitle[SHEET_LOG] ||
    (await doc.addSheet({
      title: SHEET_LOG,
      headerValues: [
        "ID_Tiket",
        "Timestamp",
        "Pelapor",
        "Isi_Laporan",
        "Grup",
        "Teknisi",
        "Status",
        "Solusi",
      ],
    }));

  if (!sheetLog.headerValues.includes("Solusi")) {
    await sheetLog.setHeaderRow([
      "ID_Tiket",
      "Timestamp",
      "Pelapor",
      "Isi_Laporan",
      "Grup",
      "Teknisi",
      "Status",
      "Solusi",
    ]);
    await sheetLog.loadHeaderRow();
  }

  const rows = await sheetLog.getRows();
  const tiketHariIni = rows.filter((r) => {
    const timestamp = r.get("Timestamp") || "";
    return timestamp.startsWith(tglFilter);
  });

  const nomorUrut = (tiketHariIni.length + 1).toString().padStart(3, "0");
  return `TKT${tglKode}-${nomorUrut}`;
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
        "Solusi",
      ],
    });
  }
  await sheetLog.addRow(data);

  const grupNormal = String(data.Grup || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (grupNormal && grupNormal !== "chat pribadi") {
    tiketOpenPerGrup.set(grupNormal, {
      idTiket: data.ID_Tiket,
      pelapor: data.Pelapor,
      timestamp: data.Timestamp,
      teknisi: data.Teknisi || "",
    });
    console.log(`[CACHE] Tiket baru ${data.ID_Tiket} untuk grup ${data.Grup}`);
  }
}

// =====================================================
// HELPER: UPDATE STATUS TIKET
// =====================================================
async function updateStatusTiket(idTiket, status, namaTeknisi, Solusi = "") {
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

  const namaGrup = row.get("Grup");
  const isiLaporan = row.get("Isi_Laporan");
  row.set("Status", status);
  row.set("Teknisi", namaTeknisi);
  if (Solusi) row.set("Solusi", Solusi);
  await row.save();

  if (status === "Selesai") {
    const grupNormal = String(namaGrup || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    tiketOpenPerGrup.delete(grupNormal);

    if (reminderTiketAktif.has(idTiket)) {
      clearTimeout(reminderTiketAktif.get(idTiket).timeoutId);
      reminderTiketAktif.delete(idTiket);
      console.log(`[REMINDER] Reminder tiket ${idTiket} dibatalkan (selesai)`);
    }

    console.log(
      `[CACHE] Tiket ${idTiket} selesai, grup ${namaGrup} bisa lapor lagi`,
    );
  }

  return {
    success: true,
    grup: namaGrup,
    isiLaporan: isiLaporan,
    Solusi: Solusi,
  };
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
      if (tglSheet === tglHariIni)
        sedangShift = jamSekarang >= mulai && jamSekarang < selesai;
    } else {
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
    const pesan = String(message.body || "");
    const pesanLower = pesan.toLowerCase().trim();
    const pengirim = message.author || message.from;
    const contact = await client.getContactById(pengirim);
    const nomorPengirim = contact.number || pengirim.split("@")[0];
    const chat = await message.getChat();
    const namaGrupAsli = chat.isGroup ? chat.name : "Chat Pribadi";

    // FIX: Normalisasi nama grup — trim + lowercase + hapus spasi ganda
    const namaGrupNormal = namaGrupAsli
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

    console.log(
      `[DEBUG] Dari: ${nomorPengirim} | LID: ${pengirim.split("@")[0]} | Pesan: "${pesan}" | Grup: "${namaGrupAsli}" | GrupNormal: "${namaGrupNormal}"`,
    );

    // =====================================================
    // 0A. FITUR: CEK_ISTIRAHAT - KHUSUS ADMIN VIA PM
    // =====================================================
    if (pesanLower === "cek_istirahat") {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) return;

      let teksBalasan = `📋 *LIST ISTIRAHAT AKTIF*\n`;
      teksBalasan += `⏰ ${new Date().toLocaleString("id-ID", { timeZone: TIMEZONE })}\n`;
      teksBalasan += `================================\n\n`;

      if (sedangIstirahat.size === 0) {
        teksBalasan += `_Tidak ada yang sedang istirahat saat ini._`;
      } else {
        let no = 1;
        const mentionList = [];
        for (const [nomor, data] of sedangIstirahat.entries()) {
          const nomorAsli = nomor.split("@")[0];
          mentionList.push(nomor);
          teksBalasan += `*${no}. ${data.nama}*\n`;
          teksBalasan += ` 📱 @${nomorAsli}\n`;
          teksBalasan += ` 🕒 Mulai: ${data.jamMulai}\n`;
          teksBalasan += ` 🔔 Selesai: ${data.jamSelesai}\n`;
          teksBalasan += ` 📍 Grup: ${data.grup}\n`;
          teksBalasan += ` ⏱️ Durasi: ${data.durasiMenit} menit\n\n`;
          no++;
        }
        teksBalasan += `_Total: ${sedangIstirahat.size} orang sedang istirahat_\n\n`;
        teksBalasan += `_Command admin:_\n`;
        teksBalasan += `• hapus_istirahat [nomor/nama]\n`;
        teksBalasan += `• edit_istirahat [nomor/nama] [menit]\n`;
      }

      try {
        await client.sendMessage(`${nomorPengirim}@c.us`, teksBalasan, {
          mentions: Array.from(sedangIstirahat.keys()),
        });
      } catch (err) {
        await message.reply(`⚠️ Gagal kirim PM. Save nomor Bot`);
        return;
      }

      if (chat.isGroup) {
        await message.reply(`✅ List istirahat sudah dikirim ke chat pribadi`);
      }
      return;
    }

    // =====================================================
    // 0B. FITUR: HAPUS_ISTIRAHAT - KHUSUS ADMIN
    // =====================================================
    if (pesanLower.startsWith("hapus_istirahat")) {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      const bagian = pesan.trim().split(/\s+/);
      if (bagian.length < 2) {
        return message.reply(
          "❌ Format salah.\n\nGunakan:\nhapus_istirahat [nama atau nomor]\n\nContoh:\nhapus_istirahat yusuf\nhapus_istirahat 6281234567890",
        );
      }

      const keyword = bagian.slice(1).join(" ").toLowerCase();
      let targetNomor = null;
      let targetNama = null;

      for (const [nomor, data] of sedangIstirahat.entries()) {
        const nomorAsli = nomor.split("@")[0];
        if (
          data.nama.toLowerCase() === keyword ||
          nomorAsli === keyword.replace(/\D/g, "")
        ) {
          targetNomor = nomor;
          targetNama = data.nama;
          break;
        }
      }

      if (!targetNomor) {
        return message.reply(
          `❌ Tidak ada istirahat aktif dengan nama/nomor: *${keyword}*\n\nKetik cek_istirahat untuk melihat list.`,
        );
      }

      const dataLama = sedangIstirahat.get(targetNomor);
      if (dataLama && dataLama.timeoutId) clearTimeout(dataLama.timeoutId);

      await hapusIstirahatDariSheet(targetNomor);

      await message.reply(
        `✅ *Istirahat ${targetNama} berhasil dihapus*\n\nOleh admin: ${nomorPengirim}`,
      );

      try {
        const semuaChat = await client.getChats();
        for (const namaGrup of GRUP_ISTIRAHAT_RAW) {
          const grupChat = semuaChat.find((c) => c.name === namaGrup);
          if (grupChat) {
            await client.sendMessage(
              grupChat.id._serialized,
              `🗑️ *ISTIRAHAT DIHAPUS ADMIN*\n\n` +
                `Istirahat *${targetNama}* telah dihapus oleh admin.\n` +
                `@${targetNomor.split("@")[0]} silahkan kembali ke tugas.`,
              { mentions: [targetNomor] },
            );
          }
        }
      } catch (e) {
        console.error("[HAPUS_ISTIRAHAT] Gagal kirim notif grup:", e.message);
      }
      return;
    }

    // =====================================================
    // 0C. FITUR: EDIT_ISTIRAHAT - KHUSUS ADMIN
    // =====================================================
    if (pesanLower.startsWith("edit_istirahat")) {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      const bagian = pesan.trim().split(/\s+/);
      if (bagian.length < 3) {
        return message.reply(
          "❌ Format salah.\n\nGunakan:\nedit_istirahat [nama/nomor] [+/-menit]\n\nContoh:\nedit_istirahat yusuf +10\nedit_istirahat yusuf -5\nedit_istirahat 6281234 30",
        );
      }

      const menitStr = bagian[bagian.length - 1];
      const keyword = bagian
        .slice(1, bagian.length - 1)
        .join(" ")
        .toLowerCase();

      const menitMatch = menitStr.match(/^([+-]?)(\d+)$/);
      if (!menitMatch) {
        return message.reply(
          "❌ Format menit salah. Gunakan: +10, -5, atau 30",
        );
      }
      const isRelative = menitStr.startsWith("+") || menitStr.startsWith("-");
      const nilaiMenit = parseInt(menitStr);

      let targetNomor = null;
      let targetNama = null;

      for (const [nomor, data] of sedangIstirahat.entries()) {
        const nomorAsli = nomor.split("@")[0];
        if (
          data.nama.toLowerCase() === keyword ||
          nomorAsli === keyword.replace(/\D/g, "")
        ) {
          targetNomor = nomor;
          targetNama = data.nama;
          break;
        }
      }

      if (!targetNomor) {
        return message.reply(
          `❌ Tidak ada istirahat aktif dengan nama/nomor: *${keyword}*\n\nKetik cek_istirahat untuk melihat list.`,
        );
      }

      const dataLama = sedangIstirahat.get(targetNomor);

      if (dataLama.timeoutId) clearTimeout(dataLama.timeoutId);

      const nowMs = new Date().getTime();
      let timestampSelesaiBaru;

      if (isRelative) {
        timestampSelesaiBaru =
          dataLama.timestampSelesai + nilaiMenit * 60 * 1000;
      } else {
        timestampSelesaiBaru = nowMs + nilaiMenit * 60 * 1000;
      }

      if (timestampSelesaiBaru <= nowMs) {
        return message.reply(
          `❌ Waktu selesai tidak valid (sudah lewat). Gunakan nilai lebih besar.`,
        );
      }

      const sisaMsBaru = timestampSelesaiBaru - nowMs;
      const jamSelesaiBaru = new Date(timestampSelesaiBaru).toLocaleTimeString(
        "id-ID",
        {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: TIMEZONE,
        },
      );

      const timeoutIdBaru = setTimeout(async () => {
        try {
          const semuaChat = await client.getChats();
          const grupChat = semuaChat.find((c) => c.name === dataLama.grup);
          if (grupChat) {
            await client.sendMessage(
              grupChat.id._serialized,
              `🔔 *ISTIRAHAT SELESAI* 🔔\n\n` +
                `Waktu istirahat *${targetNama}* telah berakhir.\n\n` +
                `🕒 Berakhir pada: *${jamSelesaiBaru}*\n\n` +
                `Silahkan kembali ke Plotingan \nTetap Semangat 😁.`,
              { mentions: [targetNomor] },
            );
          }
          await hapusIstirahatDariSheet(targetNomor);
        } catch (e) {
          await hapusIstirahatDariSheet(targetNomor);
        }
      }, sisaMsBaru);

      const dataUpdate = {
        ...dataLama,
        jamSelesai: jamSelesaiBaru,
        timestampSelesai: timestampSelesaiBaru,
        timeoutId: timeoutIdBaru,
      };
      sedangIstirahat.set(targetNomor, dataUpdate);

      try {
        const sheetIstirahat = doc.sheetsByTitle[SHEET_ISTIRAHAT];
        if (sheetIstirahat) {
          const rows = await sheetIstirahat.getRows();
          const row = rows.find((r) => r.get("Nomor") === targetNomor);
          if (row) {
            row.set("JamSelesai", jamSelesaiBaru);
            row.set("TimestampSelesai", timestampSelesaiBaru);
            await row.save();
          }
        }
      } catch (err) {
        console.error("[EDIT_ISTIRAHAT] Gagal update sheet:", err.message);
      }

      const sisaMenitBaru = Math.ceil(sisaMsBaru / 60000);
      await message.reply(
        `✅ *Istirahat ${targetNama} berhasil diupdate*\n\n` +
          `🕒 Mulai: ${dataLama.jamMulai}\n` +
          `🔔 Selesai baru: *${jamSelesaiBaru}*\n` +
          `⏱️ Sisa: *${sisaMenitBaru} menit*`,
      );
      return;
    }

    // =====================================================
    // 0D. FITUR: CEK_TIKET
    // =====================================================
    if (pesanLower === "cek_tiket") {
      try {
        await doc.loadInfo();
        const sheetLog = doc.sheetsByTitle[SHEET_LOG];

        if (!sheetLog) {
          return message.reply("📋 Belum ada data tiket.");
        }

        const rows = await sheetLog.getRows();
        const tiketOpen = rows.filter((r) => r.get("Status") === "Open");

        if (tiketOpen.length === 0) {
          return message.reply(
            `✅ *CEK TIKET*\n\n` +
              `⏰ ${new Date().toLocaleString("id-ID", { timeZone: TIMEZONE })}\n\n` +
              `_Tidak ada tiket yang masih open saat ini. Semua sudah selesai! 🎉_`,
          );
        }

        let teks = `📋 *TIKET MASIH OPEN*\n`;
        teks += `⏰ ${new Date().toLocaleString("id-ID", { timeZone: TIMEZONE })}\n`;
        teks += `================================\n\n`;
        teks += `*Total: ${tiketOpen.length} tiket open*\n\n`;

        tiketOpen.forEach((r, i) => {
          const isiPendek =
            String(r.get("Isi_Laporan") || "").substring(0, 60) +
            (String(r.get("Isi_Laporan") || "").length > 60 ? "..." : "");
          teks += `*${i + 1}. ${r.get("ID_Tiket")}*\n`;
          teks += `   📍 Grup: ${r.get("Grup")}\n`;
          teks += `   🕒 Waktu: ${r.get("Timestamp")}\n`;
          teks += `   👤 Pelapor: ${r.get("Pelapor")}\n`;
          teks += `   🔧 Teknisi: ${r.get("Teknisi") || "Belum ada"}\n`;
          teks += `   📝 Laporan: ${isiPendek}\n\n`;
        });

        teks += `================================\n`;

        if (ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
          teks += `\n_Admin: gunakan_ *force_close [ID_Tiket]* _untuk paksa tutup tiket_`;
        }

        return message.reply(teks);
      } catch (err) {
        console.error("[CEK_TIKET] Error:", err.message);
        return message.reply("⚠️ Gagal mengambil data tiket.");
      }
    }

    // =====================================================
    // 0E. FITUR: FORCE_CLOSE - Tutup paksa tiket (ADMIN)
    // =====================================================
    if (pesanLower.startsWith("force_close ")) {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      const bagian = pesan.trim().split(/\s+/);
      if (bagian.length < 2) {
        return message.reply(
          "❌ Format: force_close [ID_Tiket]\nContoh: force_close TKT070526-001",
        );
      }

      const idTiket = bagian[1].toUpperCase();
      const hasil = await updateStatusTiket(
        idTiket,
        "Selesai",
        `Admin-${nomorPengirim}`,
        "Ditutup paksa oleh admin",
      );

      if (hasil.success) {
        await message.reply(
          `✅ *Tiket ${idTiket} berhasil ditutup paksa*\n\n` +
            `Grup: ${hasil.grup}\n` +
            `Ditutup oleh: Admin ${nomorPengirim}`,
        );

        const semuaChat = await client.getChats();
        const grupChat = semuaChat.find((c) => c.name === hasil.grup);
        if (grupChat) {
          await client.sendMessage(
            grupChat.id._serialized,
            `✅ *INFO TIKET ${idTiket}*\n\n` +
              `Tiket ini telah *ditutup oleh admin*.\n\n` +
              `📋 *Laporan Awal:*\n"${hasil.isiLaporan}"\n\n` +
              `Silakan buat laporan baru jika masalah belum terselesaikan.`,
          );
        }
      } else {
        await message.reply(`⚠️ Gagal tutup tiket: ${hasil.reason}`);
      }
      return;
    }

    // =====================================================
    // 0F. FITUR: CEK_P3 - Lihat data P3 hari ini (ADMIN)
    // =====================================================
    if (pesanLower === "cek_p3") {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      const nowTZ = new Date(
        new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
      );
      const tglHariIni = nowTZ.toLocaleDateString("id-ID", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      });

      let teks = `📋 *DATA P3 HARI INI*\n`;
      teks += `📅 ${tglHariIni}\n`;
      teks += `================================\n\n`;

      if (dataP3HariIni.size === 0) {
        teks += `_Belum ada yang trigger P3 hari ini._`;
      } else {
        const sorted = [...dataP3HariIni.entries()].sort(
          (a, b) => a[1].timestampTrigger - b[1].timestampTrigger,
        );
        teks += `*Total: ${sorted.length} orang*\n\n`;
        sorted.forEach(([nomor, data], i) => {
          const statusEmoji = data.status === "Tepat Waktu" ? "✅" : "⚠️";
          teks += `${i + 1}. *${data.nama}* - Zona ${data.zona} | ${data.jamTrigger} | ${statusEmoji} ${data.status}\n`;
        });
        teks += `\n_Gunakan_ *rekap_p3* _untuk trigger rekap manual_`;
      }

      await message.reply(teks);
      return;
    }

    // =====================================================
    // 0G. FITUR: REKAP_P3 - Trigger rekap P3 manual (ADMIN)
    // =====================================================
    if (pesanLower === "rekap_p3") {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      await message.reply("📊 Membuat rekap P3, sebentar...");
      await kirimRekapP3(chat.id._serialized);
      return;
    }

    // =====================================================
    // 0H. FITUR: HAPUS_P3 - Hapus data P3 per orang (ADMIN)
    // =====================================================
    if (pesanLower.startsWith("hapus_p3")) {
      if (!ADMIN_ISTIRAHAT.includes(nomorPengirim)) {
        return message.reply("⚠️ Kamu tidak punya akses command ini.");
      }

      const bagian = pesan.trim().split(/\s+/);
      if (bagian.length < 2) {
        return message.reply(
          "❌ Format salah.\n\nGunakan:\nhapus_p3 [nama]\n\nContoh:\nhapus_p3 Farhan",
        );
      }

      const keyword = bagian.slice(1).join(" ").toLowerCase();
      let targetNomor = null;
      let targetNama = null;

      for (const [nomor, data] of dataP3HariIni.entries()) {
        if (data.nama.toLowerCase() === keyword) {
          targetNomor = nomor;
          targetNama = data.nama;
          break;
        }
      }

      if (!targetNomor) {
        return message.reply(
          `❌ Tidak ada data P3 hari ini dengan nama: *${keyword}*\n\nKetik cek_p3 untuk melihat list.`,
        );
      }

      // Hapus dari memory
      dataP3HariIni.delete(targetNomor);

      // Hapus dari sheet
      try {
        await doc.loadInfo();
        const sheetP3 = doc.sheetsByTitle[SHEET_P3];
        if (sheetP3) {
          const rows = await sheetP3.getRows();
          const nowTZ = new Date(
            new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
          );
          const tglHariIni = nowTZ.toLocaleDateString("id-ID");
          const row = rows.find(
            (r) =>
              r.get("Nomor") === targetNomor && r.get("Tanggal") === tglHariIni,
          );
          if (row) await row.delete();
        }
      } catch (err) {
        console.error("[HAPUS_P3] Gagal hapus dari sheet:", err.message);
      }

      await message.reply(
        `✅ *Data P3 ${targetNama} berhasil dihapus*\n\n` +
          `Dihapus oleh admin: ${nomorPengirim}\n\n` +
          `_${targetNama} sekarang bisa trigger P3 lagi hari ini._`,
      );

      console.log(
        `[HAPUS_P3] Data ${targetNama} dihapus oleh ${nomorPengirim}`,
      );
      return;
    }

    // =====================================================
    // 1. FITUR: TEKNISI SELESAIKAN TIKET
    // =====================================================
    if (pesanLower.startsWith("selesai ") || pesanLower.startsWith("done ")) {
      try {
        const barisPesan = pesan
          .split("\n")
          .map((b) => b.trim())
          .filter((b) => b);
        const barisPertama = barisPesan[0];
        const nomorTiket = barisPertama.split(" ")[1];

        if (!nomorTiket) {
          return message.reply(
            "Isi format sesuai ini.\n\nContoh:\nSELESAI 001\nSolusi : ",
          );
        }

        let SolusiText = "";
        if (barisPesan.length > 1) {
          SolusiText = barisPesan.slice(1).join("\n").trim();
          SolusiText = SolusiText.replace(
            /^(Solusi|solusi|reason)\s*:\s*/i,
            "",
          ).trim();
        }

        if (!SolusiText || SolusiText.length < 5) {
          return message.reply(
            "❌ *TIKET GAGAL DI-ACC*\n\n" +
              "⚠️ *Wajib tulis deskripsi solusi minimal 5 karakter*\n\n" +
              "Format yang benar:\n" +
              "SELESAI 001\n" +
              "printer error, udah cabut pasang kabel + restart spooler\n\n" +
              "_Tanpa solusi, tiket ga bisa ditutup_",
          );
        }

        const tglKode = new Date(
          new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
        )
          .toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "2-digit",
            year: "2-digit",
          })
          .replace(/\//g, "");
        const idTiket = `TKT${tglKode}-${nomorTiket.padStart(3, "0")}`;

        const semuaTeknisiRows = await doc.sheetsByIndex[0].getRows();
        const semuaNomorTeknisi = semuaTeknisiRows.map((r) =>
          formatNomor(r.get("Nomor")),
        );

        if (!semuaNomorTeknisi.includes(nomorPengirim)) {
          return message.reply("⚠️ Kamu bukan teknisi.");
        }

        const teknisiRow = semuaTeknisiRows.find(
          (r) => formatNomor(r.get("Nomor")) === nomorPengirim,
        );
        const namaTeknisi = teknisiRow.get("Nama") || "Teknisi";

        const hasil = await updateStatusTiket(
          idTiket,
          "Selesai",
          namaTeknisi,
          SolusiText,
        );

        if (hasil.success) {
          await message.reply(
            `*${idTiket} closed* ✅\nThanks ${namaTeknisi}, mantap!\n\nSolusi: ${SolusiText}`,
          );

          const semuaChat = await client.getChats();
          const grupChat = semuaChat.find((c) => c.name === hasil.grup);
          if (grupChat) {
            await client.sendMessage(
              grupChat.id._serialized,
              `✅ *INFO TIKET ${idTiket}*\n\n` +
                `Laporan error sudah ditangani dan saat ini *sudah normal kembali*.\n\n` +
                `📋 *Laporan Awal:*\n"${hasil.isiLaporan}"\n\n` +
                `🔧 *Solusi:*\n${SolusiText}\n\n` +
                `Ditangani oleh: *${namaTeknisi}*\n` +
                `Terima kasih atas laporannya.`,
            );
          }
        } else {
          await message.reply(`⚠️ Gagal: ${hasil.reason}`);
        }
      } catch (err) {
        console.error("ERROR BESAR DI BLOK SELESAI:", err);
        await message.reply("⚠️ Error bro, cek console.");
      }
      return;
    }

    // =====================================================
    // 2. FITUR: ISTIRAHAT
    // =====================================================
    const patternIstirahat = /^(\w+)_istirahat(?:\s+(\d{1,2}[:.]\d{2}))?$/i;
    const matchIstirahat = pesanLower.match(patternIstirahat);

    if (matchIstirahat) {
      if (!GRUP_ISTIRAHAT.includes(namaGrupNormal)) {
        await message.reply(
          "⚠️ Fitur istirahat cuma bisa dipake di grup yang diizinin.",
        );
        return;
      }

      const namaUser = matchIstirahat[1].toUpperCase();
      const jamMulaiManual = matchIstirahat[2];

      if (sedangIstirahat.has(pengirim)) {
        const dataLama = sedangIstirahat.get(pengirim);
        await message.reply(
          `⚠️ ${dataLama.nama} masih istirahat sampe jam ${dataLama.jamSelesai}`,
        );
        return;
      }

      const { durasiMs, durasiMenit, namaShift, isWeekend, isSPL } =
        hitungDurasiIstirahat(namaUser);

      let now = new Date(
        new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
      );
      let jamMulaiDate = now;

      if (jamMulaiManual) {
        const [jam, menit] = jamMulaiManual
          .replace(".", ":")
          .split(":")
          .map(Number);
        jamMulaiDate = new Date(now);
        jamMulaiDate.setHours(jam, menit, 0, 0);

        if (jamMulaiDate > now) {
          await message.reply(
            `⚠️ Jam mulai ${jamMulaiManual} belum lewat, Pake jam sekarang atau tunggu.`,
          );
          return;
        }

        const selisihMs = now.getTime() - jamMulaiDate.getTime();
        if (selisihMs > durasiMs) {
          await message.reply(
            `⚠️ Istirahat ${namaUser} dari jam ${jamMulaiManual} Sudah selesai ${Math.round(selisihMs / 60000)} menit yang lalu .`,
          );
          return;
        }
      }

      const jamMulai = jamMulaiDate.toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const timestampSelesai = jamMulaiDate.getTime() + durasiMs;
      const jamSelesai = new Date(timestampSelesai).toLocaleTimeString(
        "id-ID",
        {
          hour: "2-digit",
          minute: "2-digit",
        },
      );

      const sisaMs = timestampSelesai - now.getTime();

      const timeoutId = setTimeout(async () => {
        try {
          await client.sendMessage(
            chat.id._serialized,
            `🔔 *ISTIRAHAT SELESAI* 🔔\n\n` +
              `@${namaUser}, waktu istirahat untuk *${namaUser}* telah berakhir.\n\n` +
              `🕒 Berakhir pada: *${jamSelesai}*\n\n\n` +
              `Silahkan kembali ke Plotingan \nTetap Semangat 😁.`,
            { mentions: [pengirim] },
          );
          await hapusIstirahatDariSheet(pengirim);
        } catch (e) {
          await hapusIstirahatDariSheet(pengirim);
        }
      }, sisaMs);

      const dataIstirahat = {
        nomor: pengirim,
        nama: namaUser,
        jamMulai: jamMulai,
        jamSelesai: jamSelesai,
        timestampSelesai: timestampSelesai,
        durasiMenit: durasiMenit,
        grup: namaGrupAsli,
      };

      sedangIstirahat.set(pengirim, { ...dataIstirahat, timeoutId });
      await simpanIstirahatKeSheet(dataIstirahat);

      const dataHistory = {
        nama: namaUser,
        jamMulai,
        jamSelesai,
        durasiMenit,
        nomor: pengirim,
      };
      if (namaShift === "Shift 1")
        historyIstirahatHariIni.shift1.push(dataHistory);
      else historyIstirahatHariIni.shift2.push(dataHistory);

      const sisaMenit = Math.ceil(sisaMs / 60000);

      let teksBalasan = `✅ *ISTIRAHAT DIMULAI* ✅\n\n`;
      teksBalasan += `👤 *${namaUser}* ${isSPL ? "(SPL)" : ""}\n`;
      teksBalasan += `🕒 Mulai: *${jamMulai}* ${jamMulaiManual ? "(Manual)" : ""}\n`;
      teksBalasan += `🔔 Selesai: *${jamSelesai}*\n`;
      teksBalasan += `⏱️ Sisa: *${sisaMenit} menit*\n`;
      teksBalasan += `📍 Shift: *${namaShift}* ${isWeekend ? "(Weekend)" : ""}\n\n`;
      teksBalasan += `_Istirahat akan otomatis selesai & ada notif_`;

      await message.reply(teksBalasan, undefined, { mentions: [pengirim] });
      return;
    }

    // =====================================================
    // 2B. FITUR: P3 ZONA
    // Format: NAMA_P3 Zona B  (case insensitive)
    // Contoh: Farhan_P3 Zona B
    // =====================================================
    // Pattern: [nama]_P3 Zona [B/C/D/E/F]
    const patternP3 = /^(\w+)_p3\s+zona\s+([a-f])$/i;
    const matchP3 = pesan.trim().match(patternP3);

    if (matchP3) {
      const namaUser = matchP3[1]; // nama asli sesuai ketikan (tidak di-uppercase paksa)
      const zonaInput = matchP3[2].toUpperCase();

      // Validasi zona
      if (!ZONA_P3_VALID.includes(zonaInput)) {
        await message.reply(
          `❌ Zona *${zonaInput}* tidak valid.\n\nZona yang tersedia: *${ZONA_P3_VALID.join(", ")}*\n\nContoh: Farhan_P3 Zona B`,
        );
        return;
      }

      // Cek apakah sudah trigger hari ini
      if (dataP3HariIni.has(pengirim)) {
        const dataLama = dataP3HariIni.get(pengirim);
        await message.reply(
          `⚠️ *${namaUser}* sudah tercatat di P3 hari ini.\n\n` +
            `📍 Zona: *${dataLama.zona}*\n` +
            `🕒 Jam: *${dataLama.jamTrigger}*\n` +
            `Status: ${dataLama.status === "Tepat Waktu" ? "✅ Tepat Waktu" : "⚠️ Terlambat"}\n\n` +
            `_Setiap orang hanya bisa trigger P3 satu kali per hari._`,
        );
        return;
      }

      // Ambil waktu sekarang
      const nowTZ = new Date(
        new Date().toLocaleString("en-US", { timeZone: TIMEZONE }),
      );
      const jamTrigger = nowTZ.toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const timestampTrigger = new Date().getTime();
      const tanggal = nowTZ.toLocaleDateString("id-ID");

      // Tentukan status tepat waktu / terlambat
      const statusP3 = cekStatusP3(timestampTrigger);

      // Simpan ke memory
      dataP3HariIni.set(pengirim, {
        nama: namaUser,
        zona: zonaInput,
        jamTrigger: jamTrigger,
        timestampTrigger: timestampTrigger,
        status: statusP3,
        grup: namaGrupAsli,
      });

      // Simpan ke Google Sheet
      await simpanP3KeSheet({
        tanggal: tanggal,
        nomor: pengirim,
        nama: namaUser,
        zona: zonaInput,
        jamTrigger: jamTrigger,
        timestampTrigger: timestampTrigger,
        status: statusP3,
        grup: namaGrupAsli,
      });

      // Balas konfirmasi
      const statusEmoji = statusP3 === "Tepat Waktu" ? "✅" : "⚠️";
      const statusLabel =
        statusP3 === "Tepat Waktu"
          ? "✅ *Tepat Waktu*"
          : "⚠️ *Terlambat berada di zona kerja*";

      let teksBalasan = `📍 *P3 TERCATAT* 📍\n\n`;
      teksBalasan += `👤 *${namaUser}* berada di Zona *${zonaInput}*\n`;
      teksBalasan += `🕒 Jam masuk: *${jamTrigger}*\n`;
      teksBalasan += `${statusLabel}\n\n`;
      teksBalasan += `_Data tercatat. Rekap akan dikirim jam 11:00_`;

      await message.reply(teksBalasan, undefined, { mentions: [pengirim] });

      console.log(
        `[P3] ${namaUser} Zona ${zonaInput} jam ${jamTrigger} | ${statusP3}`,
      );
      return;
    }

    // =====================================================
    // 2C. FITUR: REMOTE ACCESS (ANYDESK / RUSTDESK)
    // Hanya aktif di grup: BSS MAINTENANCE MANADO
    // Format: NAMALOKASI_Anydesk atau NAMALOKASI_Rustdesk
    // Contoh: MGLG_Anydesk, KNTBSS_Rustdesk
    // =====================================================
    const patternRemote = /^([a-z0-9]+)_(anydesk|rustdesk)$/i;
    const matchRemote = pesanLower.trim().match(patternRemote);

    if (matchRemote) {
      // Hanya berlaku di grup BSS MAINTENANCE MANADO
      if (namaGrupNormal !== GRUP_REMOTE) {
        // Bukan di grup yang tepat, lanjut ke blok berikutnya (jangan return)
        // tapi kita skip dulu supaya tidak masuk trigger error
      } else {
        const lokasiKey = matchRemote[1].toLowerCase();
        const tipeRemote = matchRemote[2].toLowerCase(); // "anydesk" atau "rustdesk"

        // FIX: Definisikan labelTipe sebelum dipakai
        const labelTipe = tipeRemote === "anydesk" ? "AnyDesk" : "RustDesk";

        // Refresh cache kalau sudah lebih dari 5 menit
        await loadDataRemote();

        const data = cacheRemote.get(lokasiKey);

        if (!data) {
          await message.reply(
            `❌ *Lokasi tidak ditemukan*\n\n` +
              `Lokasi *"${matchRemote[1].toUpperCase()}"* belum ada di database.\n\n` +
              `Pastikan nama lokasi sudah benar, atau minta admin tambahkan ke spreadsheet.\n\n` +
              `_Sheet: ${SHEET_REMOTE}_`,
          );
          return;
        }

        const credential = data[tipeRemote];

        if (!credential) {
          await message.reply(
            `⚠️ *Data ${labelTipe} kosong*\n\n` +
              `Lokasi: *${data.lokasiAsli}*\n\n` +
              `Kolom ${labelTipe} belum diisi di spreadsheet.\n` +
              `_Minta admin isi kolom ${labelTipe} di sheet ${SHEET_REMOTE}_`,
          );
          return;
        }

        await message.reply(
          `🖥️ *${labelTipe} - ${data.lokasiAsli}*\n\n` +
            `📋 ID:\n` +
            `*${credential}*\n` +
            `🔑 Password: ${data.password ? `*${data.password}*` : "_tidak ada_"}`,
        );

        console.log(
          `[REMOTE] ${nomorPengirim} akses ${labelTipe} lokasi ${data.lokasiAsli}`,
        );
        return;
      }
    }

    // =====================================================
    // 3. TRIGGER ERROR / LAPORAN TEKNISI
    // =====================================================
    if (teknisiIgnore.includes(nomorPengirim)) return;

    const adaTrigger =
      pesanLower.includes("error") ||
      pesanLower.includes("eror") ||
      pesanLower.includes("teknisi");

    if (!adaTrigger) return;

    if (chat.isGroup && tiketOpenPerGrup.has(namaGrupNormal)) {
      const tiketLama = tiketOpenPerGrup.get(namaGrupNormal);
      await message.reply(
        `⚠️ *Laporan Ditolak*\n\n` +
          `Grup ini masih ada tiket yang belum diselesaikan:\n` +
          `🎫 ID: *${tiketLama.idTiket}*\n` +
          `🕒 Dilaporkan: ${tiketLama.timestamp}\n\n` +
          `_Tunggu tiket tersebut diselesaikan teknisi dulu ya_`,
        undefined,
        { mentions: [`${tiketLama.pelapor}@c.us`] },
      );
      return;
    }

    const { teknisiBertugas, jamSekarang, menitSekarang, tglHariIni } =
      await getTeknisiStandby();
    const namaGrup = chat.isGroup ? chat.name : "Chat Pribadi";

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
      Solusi: "",
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

      setReminderTiket(idTiket, [], namaGrup, message.body);
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

    setReminderTiket(idTiket, teknisiBertugas, namaGrup, message.body);

    for (const teknisi of teknisiBertugas) {
      try {
        const chatId = `${teknisi.nomor}@c.us`;
        const nomorTiketPendek = idTiket.split("-")[1];
        await client.sendMessage(
          chatId,
          `🚨 *Bro ada Laporan ini* 🚨\n` +
            `ID Tiket: *${idTiket}*\n\n` +
            `Dari grup : ${namaGrup}\n\n` +
            `Isi Laporan:\n"${message.body}"\n\n` +
            `🕒 Waktu: ${String(jamSekarang).padStart(2, "0")}:${String(menitSekarang).padStart(2, "0")} | 📅 ${tglHariIni}\n\n` +
            `*Kalo udah kelar, bales:*\n` +
            `SELESAI ${nomorTiketPendek}\n` +
            `cabut pasang kabel`,
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
