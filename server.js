const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get("/", (req, res) => res.send("WordDuel Server Çalışıyor ✅"));

// ── KELIME LİSTESİ ──
const WORDS = [
  "KALEM","TAHTA","ÇIÇEK","DENIZ","ARABA","KAPAK","BULUT","ZAMAN","YATAK",
  "ELMAS","FENER","GÜNEŞ","HAVUZ","IRMAK","KÖPRÜ","LIMON","NEHIR","PAKET",
  "RESIM","SALON","TAVAN","VATAN","ASKER","BAHÇE","DEMIR","EKRAN","ORMAN",
  "PERDE","SABUN","TABLO","VAPUR","YUMAK","FINCAN","GITAR","NEFES","MOTOR",
  "KABAN","YILAN","ÇELIK","UZMAN","ROKET","KARTAL","MEYVE","SEVGI","KITAP",
  "PENCERE".slice(0,5),"ŞEKER","TOPRAK".slice(0,5),"YILDIZ".slice(0,5),"KÖPEK",
  "ÇANTA","KANAT","FIRTINA".slice(0,5),"KUZEY","GÜNEY","DOĞAL","HAMUR",
  "KILIÇ","TAŞIT","KEMER","DALGA","DUMAN","HAYAL","KORKU","SOHBET".slice(0,5)
].filter(w => w && w.length === 5);

// ── ODA YAPISI ──
// rooms[code] = { host, guest, hostName, guestName, word, round, scores, guesses, status }
const rooms = {};

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function generateCode() {
  let code;
  do {
    code = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  } while (rooms[code]);
  return code;
}

function evaluateGuess(guess, word) {
  const result = Array(5).fill("wrong");
  const wordArr = word.split("");
  const guessArr = guess.toUpperCase().split("");
  const used = Array(5).fill(false);

  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === wordArr[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === "correct") continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && guessArr[i] === wordArr[j]) {
        result[i] = "partial";
        used[j] = true;
        break;
      }
    }
  }
  return result;
}

io.on("connection", (socket) => {
  console.log("Bağlandı:", socket.id);

  // ── ODA OLUŞTUR ──
  socket.on("create_room", ({ playerName }) => {
    const code = generateCode();
    rooms[code] = {
      host: socket.id,
      guest: null,
      hostName: playerName || "Oyuncu1",
      guestName: null,
      word: pickWord(),
      round: 1,
      maxRounds: 3,
      scores: { host: 0, guest: 0 },
      guesses: { host: [], guest: [] },
      solved: { host: false, guest: false },
      status: "waiting",
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    socket.emit("room_created", { code, playerName: rooms[code].hostName });
    console.log(`Oda oluşturuldu: ${code} — ${rooms[code].hostName}`);
  });

  // ── ODAYA KATIL ──
  socket.on("join_room", ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit("join_error", { msg: "Oda bulunamadı! Kodu kontrol et." });
      return;
    }
    if (room.guest) {
      socket.emit("join_error", { msg: "Bu oda dolu!" });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("join_error", { msg: "Oyun zaten başladı!" });
      return;
    }

    room.guest = socket.id;
    room.guestName = playerName || "Oyuncu2";
    room.status = "playing";

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "guest";

    const payload = {
      code,
      hostName: room.hostName,
      guestName: room.guestName,
      round: room.round,
      wordLength: room.word.length,
      scores: room.scores,
    };

    // İkisine de gönder
    io.to(code).emit("game_start", payload);
    console.log(`${playerName} odaya katıldı: ${code}`);
  });

  // ── TAHMİN ──
  socket.on("submit_guess", ({ guess }) => {
    const code = socket.data.roomCode;
    const role = socket.data.role;
    const room = rooms[code];
    if (!room || room.status !== "playing") return;

    const word = room.word;
    const upperGuess = guess.toUpperCase().trim();

    if (upperGuess.length !== word.length) {
      socket.emit("guess_error", { msg: `Kelime ${word.length} harf olmalı!` });
      return;
    }

    room.guesses[role].push(upperGuess);
    const result = evaluateGuess(upperGuess, word);
    const solved = result.every(r => r === "correct");

    if (solved) room.solved[role] = true;

    // Sadece tahmin eden kişiye sonucu gönder
    socket.emit("guess_result", {
      guess: upperGuess,
      result,
      solved,
      guessCount: room.guesses[role].length,
    });

    // Rakibe "rakip tahmin yaptı" bilgisi (kelimeyi gösterme)
    socket.to(code).emit("opponent_guessed", {
      guessCount: room.guesses[role].length,
      solved,
      result, // rakibin renklerini göster (kelime açıklamadan)
    });

    // Tur bitti mi?
    const hostDone = room.solved.host || room.guesses.host.length >= 6;
    const guestDone = room.solved.guest || room.guesses.guest.length >= 6;

    if (hostDone && guestDone) {
      endRound(code);
    } else if (solved) {
      // Biri buldu, diğerine haber ver; tur bitişi diğeri de bitince
      // ya da 30 saniye sonra
      setTimeout(() => {
        const r2 = rooms[code];
        if (!r2) return;
        const hd = r2.solved.host || r2.guesses.host.length >= 6;
        const gd = r2.solved.guest || r2.guesses.guest.length >= 6;
        if (hd && gd) return; // zaten bitti
        endRound(code);
      }, 20000);
    }
  });

  // ── TUR BİTİŞİ ──
  function endRound(code) {
    const room = rooms[code];
    if (!room || room.status === "ended") return;

    const word = room.word;
    const hostSolved = room.solved.host;
    const guestSolved = room.solved.guest;
    const hostGuesses = room.guesses.host.length;
    const guestGuesses = room.guesses.guest.length;

    // Puan hesapla
    let hostPts = 0, guestPts = 0;
    if (hostSolved && guestSolved) {
      if (hostGuesses < guestGuesses) hostPts = 3;
      else if (guestGuesses < hostGuesses) guestPts = 3;
      else { hostPts = 1; guestPts = 1; } // berabere
    } else if (hostSolved) {
      hostPts = 3;
    } else if (guestSolved) {
      guestPts = 3;
    }
    // Hiçbiri bulamazsa 0

    room.scores.host += hostPts;
    room.scores.guest += guestPts;

    const isLastRound = room.round >= room.maxRounds;

    io.to(code).emit("round_end", {
      word,
      hostSolved, guestSolved,
      hostGuesses, guestGuesses,
      hostPts, guestPts,
      scores: room.scores,
      isLastRound,
      round: room.round,
    });

    if (isLastRound) {
      room.status = "ended";
      const winner =
        room.scores.host > room.scores.guest ? room.hostName :
        room.scores.guest > room.scores.host ? room.guestName : "Berabere";
      setTimeout(() => {
        io.to(code).emit("game_over", { scores: room.scores, winner, hostName: room.hostName, guestName: room.guestName });
        delete rooms[code];
      }, 4000);
    } else {
      // Sonraki tura hazırlan
      room.round++;
      room.word = pickWord();
      room.guesses = { host: [], guest: [] };
      room.solved  = { host: false, guest: false };
      setTimeout(() => {
        if (!rooms[code]) return;
        io.to(code).emit("next_round", { round: room.round, wordLength: room.word.length, scores: room.scores });
      }, 4000);
    }
  }

  // ── SÜRE DOLDU (client bildirir) ──
  socket.on("time_up", () => {
    const code = socket.data.roomCode;
    const role = socket.data.role;
    const room = rooms[code];
    if (!room) return;
    // Süre dolan kişiyi "bitmedi" say
    if (!room.solved[role] && room.guesses[role].length < 6) {
      room.guesses[role].push("__TIMEOUT__");
    }
    const hostDone = room.solved.host || room.guesses.host.length >= 6;
    const guestDone = room.solved.guest || room.guesses.guest.length >= 6;
    if (hostDone && guestDone) endRound(code);
  });

  // ── BAĞLANTI KESİLDİ ──
  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.status === "waiting") {
      delete rooms[code];
    } else if (room.status === "playing") {
      io.to(code).emit("opponent_left");
      delete rooms[code];
    }
    console.log("Ayrıldı:", socket.id, code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WordDuel sunucusu port ${PORT}'de çalışıyor`));
