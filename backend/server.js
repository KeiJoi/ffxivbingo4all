const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { adminKey } = require("./admin.config");
const {
  dbPath,
  roomRetentionDays = 30,
  cleanupIntervalMinutes = 60,
} = require("./server.config");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

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
  db.run(
    `CREATE TABLE IF NOT EXISTS rooms (
      room_code TEXT PRIMARY KEY,
      room_key TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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

function dbAll(query, params) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function scheduleRoomCleanup() {
  const retentionDays = Number(roomRetentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    console.log("room_cleanup_disabled");
    return;
  }

  const intervalMinutes = Number(cleanupIntervalMinutes);
  const intervalMs =
    Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? intervalMinutes * 60 * 1000
      : 60 * 60 * 1000;
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  async function runCleanup() {
    const cutoff = Date.now() - retentionMs;
    try {
      const result = await dbRun("DELETE FROM rooms WHERE updated_at < ?", [
        cutoff,
      ]);
      if (result.changes > 0) {
        console.log("room_cleanup", {
          removed: result.changes,
          cutoff,
        });
      }
    } catch (err) {
      console.error("room_cleanup_failed", err);
    }
  }

  runCleanup();
  setInterval(runCleanup, intervalMs);
}

function touchSession(session) {
  session.updatedAt = Date.now();
}

function normalizePlayers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized = {};
  Object.entries(raw).forEach(([seed, value]) => {
    if (typeof seed !== "string" || !seed.trim()) {
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const count = Number(value.count);
    if (!Number.isInteger(count) || count < 1) {
      return;
    }
    normalized[seed.trim()] = {
      name:
        typeof value.name === "string" && value.name.trim().length > 0
          ? value.name.trim()
          : "Guest",
      count: Math.min(count, 16),
      shortCode:
        typeof value.shortCode === "string" ? value.shortCode.trim() : "",
    };
  });
  return normalized;
}

function buildAllowedCards(players, allowedCards) {
  const result = {};
  if (players && Object.keys(players).length > 0) {
    Object.entries(players).forEach(([seed, data]) => {
      if (!data || typeof data !== "object") {
        return;
      }
      const count = Number(data.count);
      if (!Number.isInteger(count) || count < 1) {
        return;
      }
      result[seed] = Math.min(count, 16);
    });
    return result;
  }

  if (allowedCards && typeof allowedCards === "object") {
    Object.entries(allowedCards).forEach(([seed, count]) => {
      if (typeof seed !== "string" || !seed.trim()) {
        return;
      }
      const parsed = Number(count);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return;
      }
      result[seed.trim()] = Math.min(parsed, 16);
    });
  }
  return result;
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

function defaultRoomState() {
  return {
    calledNumbers: [],
    allowedCards: {},
    players: {},
    daubs: {},
    lastBingo: null,
    bingoCalls: [],
    costPerCard: 0,
    startingPot: 0,
    prizePercentage: 0,
    gameType: "Single Line",
    letters: "BINGO",
    title: "FFXIV Bingo",
    colors: {
      bg: "111418",
      card: "1B2026",
      header: "2A313A",
      text: "E6EDF3",
      daub: "33D17A",
      ball: "F3F3F3",
    },
    updatedAt: Date.now(),
  };
}

function normalizeRoomState(raw) {
  const defaults = defaultRoomState();
  const state = raw && typeof raw === "object" ? { ...defaults, ...raw } : defaults;

  state.calledNumbers = Array.isArray(state.calledNumbers)
    ? state.calledNumbers.filter((value) => Number.isInteger(value))
    : [];
  state.players = normalizePlayers(state.players);
  state.allowedCards = buildAllowedCards(state.players, state.allowedCards);
  state.daubs =
    state.daubs && typeof state.daubs === "object" && !Array.isArray(state.daubs)
      ? state.daubs
      : {};
  state.bingoCalls = Array.isArray(state.bingoCalls) ? state.bingoCalls : [];
  state.lastBingo = state.lastBingo && typeof state.lastBingo === "object"
    ? state.lastBingo
    : null;

  state.costPerCard = Number.isFinite(state.costPerCard)
    ? Math.max(0, Math.floor(Number(state.costPerCard)))
    : defaults.costPerCard;
  state.startingPot = Number.isFinite(state.startingPot)
    ? Math.max(0, Math.floor(Number(state.startingPot)))
    : defaults.startingPot;
  if (Number.isFinite(state.prizePercentage)) {
    const parsed = Number(state.prizePercentage);
    state.prizePercentage = Math.min(Math.max(parsed, 0), 100);
  } else {
    state.prizePercentage = defaults.prizePercentage;
  }

  if (typeof state.gameType !== "string" || !state.gameType.trim()) {
    state.gameType = defaults.gameType;
  } else {
    state.gameType = state.gameType.trim();
  }
  if (typeof state.letters !== "string" || !state.letters.trim()) {
    state.letters = defaults.letters;
  } else {
    state.letters = state.letters.trim().toUpperCase();
  }
  if (typeof state.title !== "string") {
    state.title = defaults.title;
  } else {
    state.title = state.title.trim();
  }
  if (!state.colors || typeof state.colors !== "object") {
    state.colors = { ...defaults.colors };
  } else {
    state.colors = {
      bg: normalizeHex(state.colors.bg) || defaults.colors.bg,
      card: normalizeHex(state.colors.card) || defaults.colors.card,
      header: normalizeHex(state.colors.header) || defaults.colors.header,
      text: normalizeHex(state.colors.text) || defaults.colors.text,
      daub: normalizeHex(state.colors.daub) || defaults.colors.daub,
      ball: normalizeHex(state.colors.ball) || defaults.colors.ball,
    };
  }

  state.updatedAt = Number.isFinite(state.updatedAt)
    ? state.updatedAt
    : Date.now();
  return state;
}

function getAllowedSeeds(state) {
  if (state.allowedCards && Object.keys(state.allowedCards).length > 0) {
    return Object.keys(state.allowedCards);
  }
  return [];
}

async function loadRoom(roomCode) {
  const row = await dbGet(
    "SELECT room_key, state, updated_at FROM rooms WHERE room_code = ?",
    [roomCode]
  );
  if (!row) {
    return null;
  }
  let state = {};
  try {
    state = JSON.parse(row.state);
  } catch (err) {
    console.error("room_state_parse_failed", err);
  }
  const normalized = normalizeRoomState(state);
  normalized.roomKey = row.room_key;
  normalized.updatedAt = row.updated_at;
  return normalized;
}

async function saveRoom(roomCode, roomKey, state) {
  const now = Date.now();
  const payload = JSON.stringify({
    ...state,
    updatedAt: now,
  });
  await dbRun(
    `INSERT INTO rooms (room_code, room_key, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(room_code) DO UPDATE SET
       room_key = excluded.room_key,
       state = excluded.state,
       updated_at = excluded.updated_at`,
    [roomCode, roomKey, payload, now]
  );
  return now;
}

async function listRooms(roomKey) {
  const rows = await dbAll(
    "SELECT room_code, state, updated_at FROM rooms WHERE room_key = ?",
    [roomKey]
  );
  return rows.map((row) => {
    let state = {};
    try {
      state = JSON.parse(row.state);
    } catch (err) {
      console.error("room_state_parse_failed", err);
    }
    const normalized = normalizeRoomState(state);
    normalized.roomCode = row.room_code;
    normalized.updatedAt = row.updated_at;
    return normalized;
  });
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

function getRoomKey(req) {
  const headerKey = req.get("x-room-key");
  const queryKey = req.query?.roomKey;
  const bodyKey = req.body?.roomKey;
  const key = headerKey || queryKey || bodyKey;
  return typeof key === "string" ? key.trim() : "";
}

app.post("/api/host-sync", async (req, res) => {
  const {
    roomCode,
    calledNumbers,
    allowedCards,
    players,
    gameType,
    costPerCard,
    startingPot,
    prizePercentage,
    letters,
    title,
    bg,
    card,
    header,
    text,
    daub,
    ball,
  } = req.body || {};
  console.log("api_host_sync", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const roomKey = getRoomKey(req);
  if (!roomKey) {
    return res.status(400).json({ error: "roomKey required" });
  }

  let session = await loadRoom(roomCode);
  if (session && session.roomKey !== roomKey) {
    return res.status(403).json({ error: "roomKey mismatch" });
  }
  if (!session) {
    session = defaultRoomState();
  }

  session.calledNumbers = Array.isArray(calledNumbers)
    ? calledNumbers.filter((value) => Number.isInteger(value))
    : session.calledNumbers;
  session.players = normalizePlayers(players);
  session.allowedCards = buildAllowedCards(session.players, allowedCards);

  const allowedSet = new Set(Object.keys(session.allowedCards));
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
  if (typeof letters === "string") {
    const normalizedLetters = normalizeLetters(letters);
    if (normalizedLetters) {
      session.letters = normalizedLetters;
    }
  }
  if (typeof title === "string") {
    session.title = title.trim();
  }
  session.colors = {
    bg: normalizeHex(bg) || session.colors.bg,
    card: normalizeHex(card) || session.colors.card,
    header: normalizeHex(header) || session.colors.header,
    text: normalizeHex(text) || session.colors.text,
    daub: normalizeHex(daub) || session.colors.daub,
    ball: normalizeHex(ball) || session.colors.ball,
  };

  touchSession(session);
  await saveRoom(roomCode, roomKey, session);

  const allowedSeeds = getAllowedSeeds(session);
  io.to(roomCode).emit("room_state", {
    roomCode,
    allowedCards: session.allowedCards,
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: session.gameType,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
  });

  console.log("host_sync_updated", {
    roomCode,
    calledNumbers: session.calledNumbers,
    allowedSeedsCount: allowedSeeds.length,
  });
  return res.json({
    ok: true,
    calledNumbers: session.calledNumbers,
    allowedSeeds,
    allowedCards: session.allowedCards,
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: session.gameType,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
  });
});

app.get("/api/admin/rooms", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const rows = await dbAll("SELECT room_code, state, updated_at FROM rooms", []);
  const rooms = rows.map((row) => {
    let state = {};
    try {
      state = JSON.parse(row.state);
    } catch (err) {
      console.error("room_state_parse_failed", err);
    }
    const session = normalizeRoomState(state);
    const daubPlayers = session.daubs ? Object.keys(session.daubs).length : 0;
    return {
      roomCode: row.room_code,
      calledNumbersCount: session.calledNumbers.length,
      allowedSeedsCount: Object.keys(session.allowedCards).length,
      allowedCardsCount: Object.keys(session.allowedCards).length,
      daubPlayers,
      lastBingo: session.lastBingo,
      bingoCallsCount: Array.isArray(session.bingoCalls)
        ? session.bingoCalls.length
        : 0,
      gameType: session.gameType,
      updatedAt: row.updated_at || null,
    };
  });

  return res.json({ ok: true, rooms });
});

app.get("/api/rooms", async (req, res) => {
  const roomKey = getRoomKey(req);
  if (!roomKey) {
    return res.status(400).json({ error: "roomKey required" });
  }

  const rooms = await listRooms(roomKey);
  const response = rooms.map((room) => {
    const daubPlayers = room.daubs ? Object.keys(room.daubs).length : 0;
    return {
      roomCode: room.roomCode,
      calledNumbersCount: room.calledNumbers.length,
      allowedSeedsCount: Object.keys(room.allowedCards).length,
      allowedCardsCount: Object.keys(room.allowedCards).length,
      daubPlayers,
      lastBingo: room.lastBingo,
      bingoCallsCount: Array.isArray(room.bingoCalls)
        ? room.bingoCalls.length
        : 0,
      gameType: room.gameType,
      updatedAt: room.updatedAt || null,
    };
  });

  return res.json({ ok: true, rooms: response });
});

app.post("/api/admin/rooms/close", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { roomCode } = req.body || {};
  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  await dbRun("DELETE FROM rooms WHERE room_code = ?", [roomCode]);
  return res.json({ ok: true });
});

app.post("/api/rooms/close", async (req, res) => {
  const roomKey = getRoomKey(req);
  if (!roomKey) {
    return res.status(400).json({ error: "roomKey required" });
  }

  const { roomCode } = req.body || {};
  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const room = await loadRoom(roomCode);
  if (!room || room.roomKey !== roomKey) {
    return res.status(404).json({ error: "room not found" });
  }

  await dbRun("DELETE FROM rooms WHERE room_code = ?", [roomCode]);
  return res.json({ ok: true });
});

app.get("/api/room-state", async (req, res) => {
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
  const session = await loadRoom(roomCode);
  if (!session) {
    return res.status(404).json({ error: "room_not_found" });
  }
  return res.json({
    ok: true,
    roomCode,
    calledNumbers: session.calledNumbers,
    allowedSeeds: Object.keys(session.allowedCards),
    allowedCards: session.allowedCards,
    players: session.players,
    daubs: session.daubs,
    lastBingo: session.lastBingo,
    bingoCalls: Array.isArray(session.bingoCalls) ? session.bingoCalls : [],
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: session.gameType,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
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

app.post("/api/call-number", async (req, res) => {
  const { roomCode, number } = req.body || {};
  console.log("api_call_number", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const session = await loadRoom(roomCode);
  if (!session) {
    return res.status(404).json({ error: "room_not_found" });
  }

  const alreadyCalled = session.calledNumbers.includes(number);
  if (!alreadyCalled) {
    session.calledNumbers.push(number);
    touchSession(session);
    await saveRoom(roomCode, session.roomKey, session);
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

  socket.on("join_room", async (payload) => {
    const roomCode = typeof payload === "string" ? payload : payload?.roomCode;
    const seed = typeof payload === "object" ? payload?.seed : null;
    console.log("join_room", { socketId: socket.id, roomCode });

    if (!roomCode) {
      socket.emit("init_state", {
        roomCode,
        calledNumbers: [],
        allowedSeeds: [],
        allowedCards: {},
        daubs: {},
        bingoCalls: [],
        enforceSeeds: false,
      });
      return;
    }

    const session = await loadRoom(roomCode);
    if (!session) {
      socket.emit("init_state", {
        roomCode,
        calledNumbers: [],
        allowedSeeds: [],
        allowedCards: {},
        daubs: {},
        bingoCalls: [],
        enforceSeeds: false,
      });
      return;
    }

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
      letters: session.letters,
      title: session.title,
      colors: session.colors,
    });
  });

  socket.on("call_bingo", async (payload) => {
    const { roomCode, name, seed } = payload || {};
    console.log("call_bingo", { socketId: socket.id, roomCode, name });

    if (!roomCode) {
      return;
    }

    const session = await loadRoom(roomCode);
    if (!session) {
      return;
    }

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
    await saveRoom(roomCode, session.roomKey, session);

    io.to(roomCode).emit("bingo_called", {
      roomCode,
      name: caller,
      timestamp: Date.now(),
    });
  });

  socket.on("daub_update", async (payload) => {
    const { roomCode, seed, cardIndex, number, daubed } = payload || {};
    if (!roomCode || !seed) {
      return;
    }

    const session = await loadRoom(roomCode);
    if (!session) {
      return;
    }

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
      await saveRoom(roomCode, session.roomKey, session);
    } else if (!daubed && exists) {
      session.daubs[seed][card] = list.filter((value) => value !== num);
      touchSession(session);
      await saveRoom(roomCode, session.roomKey, session);
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

scheduleRoomCleanup();
