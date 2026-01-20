const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { adminKey } = require("./admin.config");
const { dbPath } = require("./server.config");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const games = {};

const resolvedDbPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.resolve(__dirname, dbPath);
const db = new sqlite3.Database(resolvedDbPath);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS short_links (
      code TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
  );
});

function dbGet(query, params) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row || null);
    });
  });
}

function dbRun(query, params) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function touchSession(session) {
  session.updatedAt = Date.now();
}

function normalizeAllowedCards(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const result = {};
  Object.entries(raw).forEach(([seed, count]) => {
    if (typeof seed !== "string") {
      return;
    }
    const trimmed = seed.trim();
    if (!trimmed) {
      return;
    }
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return;
    }
    result[trimmed] = Math.min(parsed, 16);
  });

  return result;
}

function getAllowedSeeds(session) {
  if (session.allowedCards && Object.keys(session.allowedCards).length > 0) {
    return Object.keys(session.allowedCards);
  }
  return Array.isArray(session.allowedSeeds) ? session.allowedSeeds : [];
}

function normalizeHex(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace("#", "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return cleaned
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  return null;
}

function normalizeLetters(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join("")
    .toUpperCase();
  if (cleaned.length < 1 || cleaned.length > 5) {
    return null;
  }
  return cleaned;
}

function generateCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * alphabet.length);
    result += alphabet[index];
  }
  return result;
}

async function createShortCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode(6);
    const existing = await dbGet(
      "SELECT code FROM short_links WHERE code = ?",
      [code]
    );
    if (!existing) {
      return code;
    }
  }
  return null;
}

function buildRedirectQuery(payload) {
  const params = new URLSearchParams();
  params.set("seed", payload.seed);
  params.set("count", String(payload.count));
  if (payload.letters) {
    params.set("letters", payload.letters);
  }
  if (payload.player) {
    params.set("player", payload.player);
  }
  if (payload.title) {
    params.set("title", payload.title);
  }
  if (payload.room) {
    params.set("room", payload.room);
  }
  if (payload.game) {
    params.set("game", payload.game);
  }
  if (payload.bg) {
    params.set("bg", payload.bg);
  }
  if (payload.card) {
    params.set("card", payload.card);
  }
  if (payload.header) {
    params.set("header", payload.header);
  }
  if (payload.text) {
    params.set("text", payload.text);
  }
  if (payload.daub) {
    params.set("daub", payload.daub);
  }
  if (payload.ball) {
    params.set("ball", payload.ball);
  }
  if (payload.server) {
    params.set("server", payload.server);
  }
  return params.toString();
}

function isAdminRequest(req) {
  const headerKey = req.get("x-admin-key");
  const queryKey = req.query?.key;
  const key = headerKey || queryKey;
  return typeof key === "string" && key === adminKey;
}

function getSession(roomCode) {
  if (!games[roomCode]) {
    games[roomCode] = {
      calledNumbers: [],
      allowedSeeds: [],
      allowedCards: {},
      daubs: {},
      lastBingo: null,
      bingoCalls: [],
      costPerCard: 0,
      startingPot: 0,
      prizePercentage: 0,
      gameType: "Single Line",
      updatedAt: Date.now(),
    };
  }
  return games[roomCode];
}

app.post("/api/host-sync", (req, res) => {
  const {
    roomCode,
    calledNumbers,
    allowedSeeds,
    allowedCards,
    gameType,
    costPerCard,
    startingPot,
    prizePercentage,
  } = req.body || {};
  console.log("api_host_sync", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const session = getSession(roomCode);
  session.calledNumbers = Array.isArray(calledNumbers)
    ? calledNumbers.slice()
    : [];
  const normalizedCards = normalizeAllowedCards(allowedCards);
  if (normalizedCards !== null) {
    session.allowedCards = normalizedCards;
    session.allowedSeeds = Object.keys(normalizedCards);
  } else if (Array.isArray(allowedSeeds)) {
    const cleaned = allowedSeeds
      .filter((seed) => typeof seed === "string")
      .map((seed) => seed.trim())
      .filter((seed) => seed.length > 0);
    session.allowedSeeds = Array.from(new Set(cleaned));
    session.allowedCards = {};
  }

  const allowedSet = new Set(session.allowedSeeds);
  Object.keys(session.daubs).forEach((seed) => {
    if (!allowedSet.has(seed)) {
      delete session.daubs[seed];
    }
  });
  if (typeof gameType === "string" && gameType.trim().length > 0) {
    session.gameType = gameType.trim();
  }
  if (Number.isFinite(costPerCard)) {
    session.costPerCard = Math.max(0, Math.floor(Number(costPerCard)));
  }
  if (Number.isFinite(startingPot)) {
    session.startingPot = Math.max(0, Math.floor(Number(startingPot)));
  }
  if (Number.isFinite(prizePercentage)) {
    const parsed = Number(prizePercentage);
    session.prizePercentage = Math.min(Math.max(parsed, 0), 100);
  }
  touchSession(session);

  console.log("host_sync_updated", {
    roomCode,
    calledNumbers: session.calledNumbers,
    allowedSeedsCount: session.allowedSeeds.length,
  });
  return res.json({
    ok: true,
    calledNumbers: session.calledNumbers,
    allowedSeeds: session.allowedSeeds,
    allowedCards: session.allowedCards,
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: session.gameType,
  });
});

app.get("/api/admin/rooms", (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const rooms = Object.keys(games).map((roomCode) => {
    const session = games[roomCode];
    const daubPlayers = session.daubs ? Object.keys(session.daubs).length : 0;
    return {
      roomCode,
      calledNumbersCount: session.calledNumbers.length,
      allowedSeedsCount: session.allowedSeeds.length,
      allowedCardsCount: session.allowedCards
        ? Object.keys(session.allowedCards).length
        : 0,
      daubPlayers,
      lastBingo: session.lastBingo,
      bingoCallsCount: Array.isArray(session.bingoCalls)
        ? session.bingoCalls.length
        : 0,
      gameType: session.gameType,
      updatedAt: session.updatedAt || null,
    };
  });

  return res.json({ ok: true, rooms });
});

app.post("/api/admin/rooms/close", (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { roomCode } = req.body || {};
  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  if (games[roomCode]) {
    delete games[roomCode];
  }

  return res.json({ ok: true });
});

app.get("/api/room-state", (req, res) => {
  const roomCode = req.query?.roomCode;
  console.log("api_room_state", { roomCode });

  if (!roomCode || typeof roomCode !== "string") {
    return res.status(400).json({ error: "roomCode required" });
  }

  const requireExisting = String(req.query?.requireExisting || "")
    .trim()
    .toLowerCase();
  const mustExist =
    requireExisting === "1" ||
    requireExisting === "true" ||
    requireExisting === "yes";
  if (mustExist && !games[roomCode]) {
    return res.status(404).json({ error: "room_not_found" });
  }

  const session = games[roomCode] || getSession(roomCode);
  return res.json({
    ok: true,
    roomCode,
    calledNumbers: session.calledNumbers,
    allowedSeeds: session.allowedSeeds,
    allowedCards: session.allowedCards,
    daubs: session.daubs,
    lastBingo: session.lastBingo,
    bingoCalls: Array.isArray(session.bingoCalls) ? session.bingoCalls : [],
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: session.gameType,
  });
});

app.post("/api/links", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const {
    seed,
    count,
    letters,
    player,
    title,
    room,
    game,
    bg,
    card,
    header,
    text,
    daub,
    ball,
    server,
  } = req.body || {};

  if (typeof seed !== "string" || seed.trim().length === 0) {
    return res.status(400).json({ error: "seed required" });
  }

  const parsedCount = Number(count);
  if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 16) {
    return res.status(400).json({ error: "count must be 1-16" });
  }

  const normalizedLetters = letters ? normalizeLetters(letters) : null;
  if (letters && !normalizedLetters) {
    return res.status(400).json({ error: "letters must be 1-5 characters" });
  }

  const payload = {
    seed: seed.trim(),
    count: parsedCount,
    letters: normalizedLetters || undefined,
    player: typeof player === "string" ? player.trim() : undefined,
    title: typeof title === "string" ? title.trim() : undefined,
    room: typeof room === "string" ? room.trim() : undefined,
    game: typeof game === "string" ? game.trim() : undefined,
    bg: bg ? normalizeHex(bg) : undefined,
    card: card ? normalizeHex(card) : undefined,
    header: header ? normalizeHex(header) : undefined,
    text: text ? normalizeHex(text) : undefined,
    daub: daub ? normalizeHex(daub) : undefined,
    ball: ball ? normalizeHex(ball) : undefined,
    server: typeof server === "string" ? server.trim() : undefined,
  };

  const colorsValid =
    (!bg || payload.bg) &&
    (!card || payload.card) &&
    (!header || payload.header) &&
    (!text || payload.text) &&
    (!daub || payload.daub) &&
    (!ball || payload.ball);
  if (!colorsValid) {
    return res.status(400).json({ error: "invalid color value" });
  }

  const code = await createShortCode();
  if (!code) {
    return res.status(500).json({ error: "code generation failed" });
  }

  try {
    await dbRun(
      "INSERT INTO short_links (code, payload, created_at) VALUES (?, ?, ?)",
      [code, JSON.stringify(payload), Date.now()]
    );
  } catch (err) {
    console.error("short_link_insert_failed", err);
    return res.status(500).json({ error: "link storage failed" });
  }

  return res.json({ ok: true, code });
});

app.get("/l/:code", async (req, res) => {
  const code = String(req.params.code || "").trim().toUpperCase();
  if (!code) {
    return res.status(404).send("Not found");
  }

  try {
    const row = await dbGet("SELECT payload FROM short_links WHERE code = ?", [
      code,
    ]);
    if (!row) {
      return res.status(404).send("Not found");
    }

    let payload = null;
    try {
      payload = JSON.parse(row.payload);
    } catch (err) {
      console.error("short_link_payload_invalid", err);
      return res.status(500).send("Invalid link data");
    }

    const query = buildRedirectQuery(payload);
    const target = query.length > 0 ? `/index.html?${query}` : "/index.html";
    return res.redirect(target);
  } catch (err) {
    console.error("short_link_lookup_failed", err);
    return res.status(500).send("Link lookup failed");
  }
});

app.post("/api/call-number", (req, res) => {
  const { roomCode, number } = req.body || {};
  console.log("api_call_number", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const session = getSession(roomCode);
  const alreadyCalled = session.calledNumbers.includes(number);
  if (!alreadyCalled) {
    session.calledNumbers.push(number);
    touchSession(session);
    console.log("number_called", { roomCode, number });
    io.to(roomCode).emit("number_called", {
      roomCode,
      number,
      calledNumbers: session.calledNumbers,
    });
  } else {
    console.log("number_already_called", { roomCode, number });
  }

  return res.json({
    ok: true,
    added: !alreadyCalled,
    calledNumbers: session.calledNumbers,
  });
});

io.on("connection", (socket) => {
  console.log("socket_connected", { socketId: socket.id });

  socket.on("join_room", (payload) => {
    const roomCode = typeof payload === "string" ? payload : payload?.roomCode;
    const seed = typeof payload === "object" ? payload?.seed : null;
    console.log("join_room", { socketId: socket.id, roomCode });

    if (!roomCode) {
      socket.emit("init_state", {
        roomCode,
        calledNumbers: [],
        allowedSeeds: [],
        allowedCards: {},
        bingoCalls: [],
        enforceSeeds: false,
      });
      return;
    }

    const session = getSession(roomCode);
    const allowedSeeds = getAllowedSeeds(session);
    const enforceSeeds = allowedSeeds.length > 0;

    if (enforceSeeds) {
      if (typeof seed !== "string" || !allowedSeeds.includes(seed)) {
        console.log("cheat_detected", { socketId: socket.id, roomCode, seed });
        socket.emit("cheat_detected", { reason: "invalid_seed" });
        return;
      }
    }

    socket.join(roomCode);
    console.log("emit_init_state", {
      socketId: socket.id,
      roomCode,
      calledNumbers: session.calledNumbers,
      allowedSeedsCount: allowedSeeds.length,
    });
    socket.emit("init_state", {
      roomCode,
      calledNumbers: session.calledNumbers,
      allowedSeeds,
      allowedCards: session.allowedCards,
      daubs: session.daubs,
      bingoCalls: Array.isArray(session.bingoCalls) ? session.bingoCalls : [],
      enforceSeeds,
      costPerCard: session.costPerCard,
      startingPot: session.startingPot,
      prizePercentage: session.prizePercentage,
      gameType: session.gameType,
    });
  });

  socket.on("call_bingo", (payload) => {
    const { roomCode, name, seed } = payload || {};
    console.log("call_bingo", { socketId: socket.id, roomCode, name });

    if (!roomCode) {
      return;
    }

    const session = getSession(roomCode);
    const allowedSeeds = getAllowedSeeds(session);
    if (
      allowedSeeds.length > 0 &&
      (typeof seed !== "string" || !allowedSeeds.includes(seed))
    ) {
      console.log("bingo_blocked_invalid_seed", {
        socketId: socket.id,
        roomCode,
        seed,
      });
      socket.emit("cheat_detected", { reason: "invalid_seed" });
      return;
    }

    const caller =
      typeof name === "string" && name.trim().length > 0
        ? name.trim().slice(0, 32)
        : "Unknown";

    session.lastBingo = {
      name: caller,
      seed: typeof seed === "string" ? seed : null,
      timestamp: Date.now(),
    };
    if (!Array.isArray(session.bingoCalls)) {
      session.bingoCalls = [];
    }
    session.bingoCalls.push({
      name: caller,
      seed: typeof seed === "string" ? seed : null,
      timestamp: Date.now(),
    });
    touchSession(session);

    io.to(roomCode).emit("bingo_called", {
      roomCode,
      name: caller,
      timestamp: Date.now(),
    });
  });

  socket.on("daub_update", (payload) => {
    const { roomCode, seed, cardIndex, number, daubed } = payload || {};
    if (!roomCode || !seed) {
      return;
    }

    const session = getSession(roomCode);
    const allowedSeeds = getAllowedSeeds(session);
    if (
      allowedSeeds.length > 0 &&
      (typeof seed !== "string" || !allowedSeeds.includes(seed))
    ) {
      console.log("daub_blocked_invalid_seed", {
        socketId: socket.id,
        roomCode,
        seed,
      });
      socket.emit("cheat_detected", { reason: "invalid_seed" });
      return;
    }

    const card = Number(cardIndex);
    const num = Number(number);
    if (!Number.isFinite(card) || !Number.isFinite(num)) {
      return;
    }

    if (!session.daubs[seed]) {
      session.daubs[seed] = {};
    }
    if (!session.daubs[seed][card]) {
      session.daubs[seed][card] = [];
    }

    const list = session.daubs[seed][card];
    const exists = list.includes(num);
    if (daubed && !exists) {
      list.push(num);
      touchSession(session);
    } else if (!daubed && exists) {
      session.daubs[seed][card] = list.filter((value) => value !== num);
      touchSession(session);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("socket_disconnected", { socketId: socket.id, reason });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`server_listening ${PORT}`);
});
