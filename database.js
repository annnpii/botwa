const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

async function setupDb() {
  const db = await open({
    filename: "./jadwal_teknisi.db",
    driver: sqlite3.Database,
  });

  // Buat tabel jika belum ada
  await db.exec(`
        CREATE TABLE IF NOT EXISTS jadwal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama_teknisi TEXT,
            jam_mulai INTEGER,
            jam_selesai INTEGER
        )
    `);

  // Isi data contoh (Cek dulu agar tidak duplikat)
  const data = await db.all("SELECT * FROM jadwal");
  if (data.length === 0) {
    await db.run(
      "INSERT INTO jadwal (nama_teknisi, jam_mulai, jam_selesai) VALUES ('Budi', 7, 15)",
    );
    await db.run(
      "INSERT INTO jadwal (nama_teknisi, jam_mulai, jam_selesai) VALUES ('Andi', 15, 23)",
    );
    await db.run(
      "INSERT INTO jadwal (nama_teknisi, jam_mulai, jam_selesai) VALUES ('Citra', 23, 7)",
    );
    console.log("Data jadwal awal berhasil dibuat!");
  }

  return db;
}

module.exports = { setupDb };
