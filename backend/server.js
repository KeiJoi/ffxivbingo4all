const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const { adminKey } = require("./admin.config");
const {
  dbPath,
  roomRetentionDays = 30,
  cleanupIntervalMinutes = 60,
} = require("./server.config");
const cardgen = require("./lib/cardgen");

const app = express();
const publicDir = path.join(__dirname, "public");
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(publicDir));
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

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
  // --- Additive v2 tables (docs/BINGO_V2_PROTOCOL.md). Legacy tables/columns above are untouched. ---
  db.run(
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS payout_obligations (
      payout_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      winner_seed TEXT NOT NULL,
      winner_name TEXT NOT NULL,
      total_owed INTEGER NOT NULL,
      confirmed_paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS payout_attempts (
      attempt_id TEXT PRIMARY KEY,
      payout_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at INTEGER NOT NULL,
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

// --- v2 idempotency helper (docs/BINGO_V2_PROTOCOL.md §2) ---------------------------------
// Wraps a v2 mutating handler: if `idempotencyKey` has already been used for this endpoint,
// the previously-computed {status, body} is replayed verbatim instead of re-running `run`.
// This is what makes a retried/duplicated request (network retry, double-click, two hosts
// racing) safe by construction rather than by relying on client discipline.
async function withIdempotency(req, res, endpoint, roomCode, run) {
  const idempotencyKey =
    typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return res.status(400).json({ error: "idempotencyKey required" });
  }

  const existing = await dbGet(
    "SELECT response_json FROM idempotency_keys WHERE key = ? AND endpoint = ?",
    [idempotencyKey, endpoint]
  );
  if (existing) {
    try {
      const replay = JSON.parse(existing.response_json);
      return res.status(replay.status).json(replay.body);
    } catch (err) {
      console.error("idempotency_replay_parse_failed", err);
    }
  }

  const result = await run();
  try {
    await dbRun(
      "INSERT INTO idempotency_keys (key, room_code, endpoint, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        idempotencyKey,
        roomCode,
        endpoint,
        JSON.stringify({ status: result.status, body: result.body }),
        Date.now(),
      ]
    );
  } catch (err) {
    // Two racing requests with the same key can both reach here; the loser's INSERT fails on
    // the PRIMARY KEY — that's fine, the winner's row is what future replays will read.
    console.error("idempotency_store_failed", err);
  }
  return res.status(result.status).json(result.body);
}

function newId() {
  return crypto.randomUUID();
}

const PROGRESSIVE_GAME_TYPE = "Progressive Bingo";

function isProgressiveGameType(value) {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() === PROGRESSIVE_GAME_TYPE.toLowerCase()
  );
}

function clampPercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(Math.max(parsed, 0), 100);
}

function defaultProgressiveState() {
  return {
    enabled: false,
    currentPhase: 1,
    phaseStartPrizePool: 0,
    phaseOneSplit: 34,
    phaseTwoSplit: 33,
    phaseThreeSplit: 33,
    remainingPhaseTwoSplit: 50,
    remainingPhaseThreeSplit: 50,
    lockedPhaseOnePayout: 0,
    lockedPhaseTwoPayout: 0,
    lockedPhaseThreePayout: 0,
  };
}

function deriveRemainingProgressiveSplits(progressive) {
  const phaseTwo = clampPercentage(progressive.phaseTwoSplit);
  const phaseThree = clampPercentage(progressive.phaseThreeSplit);
  const total = phaseTwo + phaseThree;
  if (total <= 0) {
    return {
      remainingPhaseTwoSplit: 50,
      remainingPhaseThreeSplit: 50,
    };
  }

  const phaseTwoShare = (phaseTwo / total) * 100;
  return {
    remainingPhaseTwoSplit: phaseTwoShare,
    remainingPhaseThreeSplit: 100 - phaseTwoShare,
  };
}

function normalizeProgressiveState(raw, gameType) {
  const defaults = defaultProgressiveState();
  const state =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...defaults, ...raw }
      : { ...defaults };

  state.enabled = Boolean(state.enabled) || isProgressiveGameType(gameType);
  state.currentPhase = Math.min(
    3,
    Math.max(1, Math.floor(Number(state.currentPhase) || defaults.currentPhase))
  );
  state.phaseStartPrizePool = Math.max(
    0,
    Math.floor(Number(state.phaseStartPrizePool) || 0)
  );
  state.phaseOneSplit = clampPercentage(state.phaseOneSplit);
  state.phaseTwoSplit = clampPercentage(state.phaseTwoSplit);
  state.phaseThreeSplit = clampPercentage(state.phaseThreeSplit);

  const derivedRemaining = deriveRemainingProgressiveSplits(state);
  if (state.currentPhase <= 1) {
    state.remainingPhaseTwoSplit = derivedRemaining.remainingPhaseTwoSplit;
    state.remainingPhaseThreeSplit = derivedRemaining.remainingPhaseThreeSplit;
  } else {
    state.remainingPhaseTwoSplit = clampPercentage(
      state.remainingPhaseTwoSplit ?? derivedRemaining.remainingPhaseTwoSplit
    );
    state.remainingPhaseThreeSplit = clampPercentage(
      state.remainingPhaseThreeSplit ?? derivedRemaining.remainingPhaseThreeSplit
    );

    const remainingTotal =
      state.remainingPhaseTwoSplit + state.remainingPhaseThreeSplit;
    if (remainingTotal > 0) {
      state.remainingPhaseTwoSplit =
        (state.remainingPhaseTwoSplit / remainingTotal) * 100;
      state.remainingPhaseThreeSplit = 100 - state.remainingPhaseTwoSplit;
    } else {
      state.remainingPhaseTwoSplit = derivedRemaining.remainingPhaseTwoSplit;
      state.remainingPhaseThreeSplit = derivedRemaining.remainingPhaseThreeSplit;
    }
  }

  state.lockedPhaseOnePayout = Math.max(
    0,
    Math.floor(Number(state.lockedPhaseOnePayout) || 0)
  );
  state.lockedPhaseTwoPayout = Math.max(
    0,
    Math.floor(Number(state.lockedPhaseTwoPayout) || 0)
  );
  state.lockedPhaseThreePayout = Math.max(
    0,
    Math.floor(Number(state.lockedPhaseThreePayout) || 0)
  );

  return state;
}

function getProgressivePhaseLabel(progressive) {
  const phase = Math.min(3, Math.max(1, Number(progressive?.currentPhase) || 1));
  if (phase === 1) {
    return "Progressive Phase 1 - Single Line";
  }
  if (phase === 2) {
    return "Progressive Phase 2 - Double Line";
  }
  return "Progressive Phase 3 - Blackout";
}

function getRoomGameTypeLabel(state) {
  if (isProgressiveGameType(state?.gameType) && state?.progressive?.enabled) {
    return getProgressivePhaseLabel(state.progressive);
  }
  return typeof state?.gameType === "string" && state.gameType.trim()
    ? state.gameType.trim()
    : "Single Line";
}

function getRoomRuleGameType(state) {
  if (isProgressiveGameType(state?.gameType) && state?.progressive?.enabled) {
    const phase = Number(state.progressive.currentPhase) || 1;
    if (phase === 1) {
      return "Single Line";
    }
    if (phase === 2) {
      return "Two Lines";
    }
    return "Blackout";
  }
  return typeof state?.gameType === "string" && state.gameType.trim()
    ? state.gameType.trim()
    : "Single Line";
}

// --- Paid vs. complimentary cards (docs/BINGO_V2_PROTOCOL.md §3) --------------------------
// `count` is preserved as a computed mirror of paidCount+compCount so every legacy reader
// (which only ever looks at `count`) keeps seeing the correct total card count.
function normalizePlayerRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const hasExplicitPaidComp =
    Number.isFinite(Number(value.paidCount)) || Number.isFinite(Number(value.compCount));

  let paidCount;
  let compCount;
  if (hasExplicitPaidComp) {
    paidCount = Math.max(0, Math.floor(Number(value.paidCount) || 0));
    compCount = Math.max(0, Math.floor(Number(value.compCount) || 0));
  } else {
    const count = Number(value.count);
    if (!Number.isInteger(count) || count < 1) {
      return null;
    }
    paidCount = Math.min(count, 16);
    compCount = 0;
  }

  if (paidCount + compCount > 16) {
    // Comp cards are reduced first to fit the 1-16 cap — paid cards represent money already
    // collected and are never silently trimmed by a cap violation.
    compCount = Math.max(0, 16 - paidCount);
  }
  if (paidCount + compCount < 1) {
    return null;
  }

  return {
    name:
      typeof value.name === "string" && value.name.trim().length > 0
        ? value.name.trim()
        : "Guest",
    shortCode: typeof value.shortCode === "string" ? value.shortCode.trim() : "",
    paidCount,
    compCount,
    count: paidCount + compCount,
  };
}

// Normalizes a raw players map with no reference to prior state — used when loading a room's
// already-persisted `players` (every stored record was already merged correctly when written)
// and as a building block inside mergePlayers below.
function normalizePlayers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized = {};
  Object.entries(raw).forEach(([seed, value]) => {
    if (typeof seed !== "string" || !seed.trim()) {
      return;
    }
    const record = normalizePlayerRecord(value);
    if (record) {
      normalized[seed.trim()] = record;
    }
  });
  return normalized;
}

// Merges an incoming players write (from legacy host-sync OR the new v2 card-grant endpoint)
// into the existing stored players map. A legacy-shaped incoming entry (bare `count`, which is
// all the standalone plugin ever sends) preserves the seed's existing compCount and attributes
// the entire count delta to paidCount, so a comp-card grant survives being re-synced by a
// client that doesn't know comp cards exist. An incoming entry that explicitly carries
// paidCount/compCount (only ever sent by the v2 card-grant endpoint) is trusted directly.
function mergePlayers(existingPlayers, incomingRaw) {
  if (!incomingRaw || typeof incomingRaw !== "object" || Array.isArray(incomingRaw)) {
    return {};
  }
  const merged = {};
  Object.entries(incomingRaw).forEach(([rawSeed, value]) => {
    if (typeof rawSeed !== "string" || !rawSeed.trim()) {
      return;
    }
    const seed = rawSeed.trim();
    const record = normalizePlayerRecord(value);
    if (!record) {
      return;
    }

    const explicitPaidComp =
      value && typeof value === "object" &&
      (Number.isFinite(Number(value.paidCount)) || Number.isFinite(Number(value.compCount)));
    const existing = existingPlayers ? existingPlayers[seed] : null;

    if (explicitPaidComp || !existing) {
      merged[seed] = record;
      return;
    }

    const newTotal = record.count;
    const preservedComp = Math.min(existing.compCount || 0, newTotal);
    merged[seed] = {
      name: record.name,
      shortCode: record.shortCode,
      paidCount: newTotal - preservedComp,
      compCount: preservedComp,
      count: newTotal,
    };
  });
  return merged;
}

// paidCards/compCards/currentPot/prizePool are always derived fresh from the authoritative
// players map — clients display this object, they never invent an independent total
// (docs/BINGO_V2_PROTOCOL.md §4). Complimentary cards never appear in currentPot/prizePool.
function computePot(session) {
  let paidCards = 0;
  let compCards = 0;
  Object.values(session.players || {}).forEach((player) => {
    paidCards += Number(player.paidCount) || 0;
    compCards += Number(player.compCount) || 0;
  });
  const currentPot = session.startingPot + paidCards * session.costPerCard;
  const prizePool = Math.round(currentPot * (session.prizePercentage / 100));
  return {
    paidCards,
    compCards,
    totalCards: paidCards + compCards,
    currentPot,
    prizePool,
  };
}

const LIFECYCLE_STATES = new Set(["Legacy", "Draft", "Active", "Closed"]);
function normalizeLifecycle(value) {
  return typeof value === "string" && LIFECYCLE_STATES.has(value) ? value : "Legacy";
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
    progressive: defaultProgressiveState(),
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
    lifecycle: "Legacy",
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
  state.progressive = normalizeProgressiveState(state.progressive, state.gameType);
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

  state.lifecycle = normalizeLifecycle(state.lifecycle);

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
    progressive,
    clearBingoState,
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

  // Economics lock (docs/BINGO_V2_PROTOCOL.md §5): only a room created via POST /api/v2/rooms
  // and then explicitly started can ever be locked, so this can never reject the standalone
  // plugin's own rooms. Even for a locked room, resending the SAME value (which is what the
  // plugin always does — it re-pushes its full local state every sync) is a no-op, not a
  // rejection; only a genuine attempted change is rejected, and the whole request is rejected
  // atomically rather than partially applied.
  if (session.lifecycle === "Active") {
    const nextCost = Number.isFinite(costPerCard)
      ? Math.max(0, Math.floor(Number(costPerCard)))
      : session.costPerCard;
    const nextStarting = Number.isFinite(startingPot)
      ? Math.max(0, Math.floor(Number(startingPot)))
      : session.startingPot;
    const nextPercentage = Number.isFinite(prizePercentage)
      ? Math.min(Math.max(Number(prizePercentage), 0), 100)
      : session.prizePercentage;
    if (
      nextCost !== session.costPerCard ||
      nextStarting !== session.startingPot ||
      nextPercentage !== session.prizePercentage
    ) {
      return res.status(409).json({ error: "economics_locked" });
    }
  }

  session.calledNumbers = Array.isArray(calledNumbers)
    ? calledNumbers.filter((value) => Number.isInteger(value))
    : session.calledNumbers;
  session.players = mergePlayers(session.players, players);
  session.allowedCards = buildAllowedCards(session.players, allowedCards);
  if (clearBingoState) {
    session.lastBingo = null;
    session.bingoCalls = [];
  }

  const allowedSet = new Set(Object.keys(session.allowedCards));
  Object.keys(session.daubs).forEach((seed) => {
    if (!allowedSet.has(seed)) {
      delete session.daubs[seed];
    }
  });

  if (typeof gameType === "string" && gameType.trim().length > 0) {
    session.gameType = gameType.trim();
  }
  session.progressive = normalizeProgressiveState(progressive, session.gameType);
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
  const pot = computePot(session);
  io.to(roomCode).emit("room_state", {
    roomCode,
    allowedCards: session.allowedCards,
    costPerCard: session.costPerCard,
    startingPot: session.startingPot,
    prizePercentage: session.prizePercentage,
    gameType: getRoomRuleGameType(session),
    gameTypeBase: session.gameType,
    displayGameType: getRoomGameTypeLabel(session),
    progressive: session.progressive,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
    // Additive (docs/BINGO_V2_PROTOCOL.md §4-5) — the legacy browser client ignores unknown fields.
    pot,
    lifecycle: session.lifecycle,
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
    gameType: getRoomRuleGameType(session),
    gameTypeBase: session.gameType,
    displayGameType: getRoomGameTypeLabel(session),
    progressive: session.progressive,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
    // Additive (docs/BINGO_V2_PROTOCOL.md §4-5) — old plugin/browser deserializers ignore unknown fields.
    players: session.players,
    pot,
    lifecycle: session.lifecycle,
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
      gameType: getRoomGameTypeLabel(session),
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
      gameType: getRoomGameTypeLabel(room),
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
    gameType: getRoomRuleGameType(session),
    gameTypeBase: session.gameType,
    displayGameType: getRoomGameTypeLabel(session),
    progressive: session.progressive,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
    // Additive (docs/BINGO_V2_PROTOCOL.md §4-5).
    pot: computePot(session),
    lifecycle: session.lifecycle,
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
  const { roomCode, number: rawNumber } = req.body || {};
  console.log("api_call_number", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  // Hardening only (docs/BINGO_V2_PROTOCOL.md §1): a legitimate caller always sends an
  // in-range integer already — this newly rejects only a malformed/malicious call that used to
  // be silently accepted into calledNumbers and filtered out on the *next* load instead.
  const parsedNumber = Number(rawNumber);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 1 || parsedNumber > 75) {
    return res.status(400).json({ error: "number must be an integer from 1 to 75" });
  }

  const session = await loadRoom(roomCode);
  if (!session) {
    return res.status(404).json({ error: "room_not_found" });
  }

  const number = parsedNumber;
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

// =====================================================================================
// v2 — additive, VenueOS-facing endpoints. See docs/BINGO_V2_PROTOCOL.md for the full
// design rationale. None of these are called by the standalone plugin/browser client, and
// none of them change any legacy route/table/response shape above this line.
// =====================================================================================

async function buildRoomSnapshot(roomCode) {
  const session = await loadRoom(roomCode);
  if (!session) {
    return null;
  }
  const obligations = await dbAll(
    "SELECT * FROM payout_obligations WHERE room_code = ? ORDER BY created_at ASC",
    [roomCode]
  );
  const payouts = [];
  for (const obligation of obligations) {
    const attempts = await dbAll(
      "SELECT * FROM payout_attempts WHERE payout_id = ? ORDER BY created_at ASC",
      [obligation.payout_id]
    );
    payouts.push({
      payoutId: obligation.payout_id,
      winnerSeed: obligation.winner_seed,
      winnerName: obligation.winner_name,
      totalOwed: obligation.total_owed,
      confirmedPaid: obligation.confirmed_paid,
      outstanding: Math.max(0, obligation.total_owed - obligation.confirmed_paid),
      status: obligation.status,
      attempts: attempts.map((attempt) => ({
        attemptId: attempt.attempt_id,
        amount: attempt.amount,
        status: attempt.status,
        note: attempt.note || null,
        createdAt: attempt.created_at,
        updatedAt: attempt.updated_at,
      })),
    });
  }

  return {
    ok: true,
    roomCode,
    lifecycle: session.lifecycle,
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
    gameType: getRoomRuleGameType(session),
    gameTypeBase: session.gameType,
    displayGameType: getRoomGameTypeLabel(session),
    progressive: session.progressive,
    letters: session.letters,
    title: session.title,
    colors: session.colors,
    pot: computePot(session),
    payouts,
  };
}

// POST /api/v2/rooms — create a room with a full settings snapshot. Starts in "Draft":
// economics remain mutable until an explicit /start call locks them.
app.post("/api/v2/rooms", async (req, res) => {
  const {
    roomCode,
    roomKey,
    venueName,
    costPerCard,
    startingPot,
    prizePercentage,
    gameType,
    progressive,
    letters,
    title,
    bg,
    card,
    header,
    text,
    daub,
    ball,
  } = req.body || {};

  if (typeof roomCode !== "string" || !roomCode.trim()) {
    return res.status(400).json({ error: "roomCode required" });
  }
  if (typeof roomKey !== "string" || !roomKey.trim()) {
    return res.status(400).json({ error: "roomKey required" });
  }

  const existing = await loadRoom(roomCode);
  if (existing) {
    return res.status(409).json({ error: "room_already_exists" });
  }

  const session = defaultRoomState();
  session.lifecycle = "Draft";
  if (typeof gameType === "string" && gameType.trim()) {
    session.gameType = gameType.trim();
  }
  session.progressive = normalizeProgressiveState(progressive, session.gameType);
  if (Number.isFinite(costPerCard)) {
    session.costPerCard = Math.max(0, Math.floor(Number(costPerCard)));
  }
  if (Number.isFinite(startingPot)) {
    session.startingPot = Math.max(0, Math.floor(Number(startingPot)));
  }
  if (Number.isFinite(prizePercentage)) {
    session.prizePercentage = Math.min(Math.max(Number(prizePercentage), 0), 100);
  }
  if (typeof letters === "string") {
    const normalizedLetters = normalizeLetters(letters);
    if (normalizedLetters) session.letters = normalizedLetters;
  }
  // Venue/Event: transmitted by VenueOS from the active Venue Profile name, persisted here
  // exactly like the legacy `title` field — never a Bingo-local venue-name setting.
  session.title = typeof title === "string" && title.trim() ? title.trim() : (typeof venueName === "string" ? venueName.trim() : session.title);
  session.colors = {
    bg: normalizeHex(bg) || session.colors.bg,
    card: normalizeHex(card) || session.colors.card,
    header: normalizeHex(header) || session.colors.header,
    text: normalizeHex(text) || session.colors.text,
    daub: normalizeHex(daub) || session.colors.daub,
    ball: normalizeHex(ball) || session.colors.ball,
  };

  touchSession(session);
  await saveRoom(roomCode, roomKey.trim(), session);
  const snapshot = await buildRoomSnapshot(roomCode);
  return res.status(201).json(snapshot);
});

// POST /api/v2/rooms/:roomCode/start — Draft -> Active. Idempotent.
app.post("/api/v2/rooms/:roomCode/start", async (req, res) => {
  const { roomCode } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const session = await loadRoom(roomCode);
  if (!session || session.roomKey !== roomKey) {
    return res.status(404).json({ error: "room not found" });
  }
  if (session.lifecycle === "Draft") {
    session.lifecycle = "Active";
    touchSession(session);
    await saveRoom(roomCode, roomKey, session);
  } else if (session.lifecycle === "Legacy") {
    return res.status(409).json({ error: "legacy_room_cannot_be_locked" });
  }
  const snapshot = await buildRoomSnapshot(roomCode);
  return res.json(snapshot);
});

// POST /api/v2/rooms/:roomCode/close — soft-close (Closed), does not delete the row.
app.post("/api/v2/rooms/:roomCode/close", async (req, res) => {
  const { roomCode } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const session = await loadRoom(roomCode);
  if (!session || session.roomKey !== roomKey) {
    return res.status(404).json({ error: "room not found" });
  }
  session.lifecycle = "Closed";
  touchSession(session);
  await saveRoom(roomCode, roomKey, session);
  const snapshot = await buildRoomSnapshot(roomCode);
  return res.json(snapshot);
});

// GET /api/v2/rooms/:roomCode — full authoritative snapshot, including the payout ledger.
// This is what a second host reads to resume after a crash/handoff.
app.get("/api/v2/rooms/:roomCode", async (req, res) => {
  const snapshot = await buildRoomSnapshot(req.params.roomCode);
  if (!snapshot) {
    return res.status(404).json({ error: "room_not_found" });
  }
  return res.json(snapshot);
});

// POST /api/v2/rooms/:roomCode/cards — grant/set a seed's paid/comp card counts.
app.post("/api/v2/rooms/:roomCode/cards", async (req, res) => {
  const { roomCode } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const { seed, name, shortCode, paidCount, compCount } = req.body || {};
  if (typeof seed !== "string" || !seed.trim()) {
    return res.status(400).json({ error: "seed required" });
  }

  return withIdempotency(req, res, "cards", roomCode, async () => {
    const session = await loadRoom(roomCode);
    if (!session || session.roomKey !== roomKey) {
      return { status: 404, body: { error: "room not found" } };
    }
    if (session.lifecycle === "Closed") {
      return { status: 409, body: { error: "room_closed" } };
    }

    const incoming = {
      [seed.trim()]: {
        name,
        shortCode,
        paidCount: Number.isFinite(Number(paidCount)) ? Number(paidCount) : undefined,
        compCount: Number.isFinite(Number(compCount)) ? Number(compCount) : undefined,
      },
    };
    session.players = mergePlayers(session.players, incoming);
    // An explicit v2 grant always carries paidCount/compCount, so mergePlayers already trusted
    // it directly rather than applying the legacy delta-preservation rule.
    session.allowedCards = buildAllowedCards(session.players, session.allowedCards);
    touchSession(session);
    await saveRoom(roomCode, roomKey, session);

    io.to(roomCode).emit("room_state", {
      roomCode,
      allowedCards: session.allowedCards,
      costPerCard: session.costPerCard,
      startingPot: session.startingPot,
      prizePercentage: session.prizePercentage,
      gameType: getRoomRuleGameType(session),
      gameTypeBase: session.gameType,
      displayGameType: getRoomGameTypeLabel(session),
      progressive: session.progressive,
      letters: session.letters,
      title: session.title,
      colors: session.colors,
      pot: computePot(session),
      lifecycle: session.lifecycle,
    });

    const snapshot = await buildRoomSnapshot(roomCode);
    return { status: 200, body: snapshot };
  });
});

// POST /api/v2/rooms/:roomCode/payouts — create (or return the existing open) obligation.
app.post("/api/v2/rooms/:roomCode/payouts", async (req, res) => {
  const { roomCode } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const { winnerSeed, winnerName, totalOwed } = req.body || {};
  const owed = Number(totalOwed);
  if (typeof winnerSeed !== "string" || !winnerSeed.trim()) {
    return res.status(400).json({ error: "winnerSeed required" });
  }
  if (!Number.isInteger(owed) || owed < 1) {
    return res.status(400).json({ error: "totalOwed must be a positive integer" });
  }

  return withIdempotency(req, res, "payouts", roomCode, async () => {
    const session = await loadRoom(roomCode);
    if (!session || session.roomKey !== roomKey) {
      return { status: 404, body: { error: "room not found" } };
    }

    const existingOpen = await dbGet(
      "SELECT * FROM payout_obligations WHERE room_code = ? AND winner_seed = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1",
      [roomCode, winnerSeed.trim()]
    );
    if (existingOpen) {
      return {
        status: 200,
        body: {
          payoutId: existingOpen.payout_id,
          winnerSeed: existingOpen.winner_seed,
          winnerName: existingOpen.winner_name,
          totalOwed: existingOpen.total_owed,
          confirmedPaid: existingOpen.confirmed_paid,
          outstanding: Math.max(0, existingOpen.total_owed - existingOpen.confirmed_paid),
          status: existingOpen.status,
        },
      };
    }

    const payoutId = newId();
    const now = Date.now();
    const name = typeof winnerName === "string" && winnerName.trim() ? winnerName.trim() : "Unknown";
    await dbRun(
      "INSERT INTO payout_obligations (payout_id, room_code, winner_seed, winner_name, total_owed, confirmed_paid, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 'open', ?, ?)",
      [payoutId, roomCode, winnerSeed.trim(), name, owed, now, now]
    );
    return {
      status: 201,
      body: {
        payoutId,
        winnerSeed: winnerSeed.trim(),
        winnerName: name,
        totalOwed: owed,
        confirmedPaid: 0,
        outstanding: owed,
        status: "open",
      },
    };
  });
});

// POST /api/v2/rooms/:roomCode/payouts/:payoutId/attempts — start a new attempt (chunk).
app.post("/api/v2/rooms/:roomCode/payouts/:payoutId/attempts", async (req, res) => {
  const { roomCode, payoutId } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const amount = Number(req.body?.amount);
  if (!Number.isInteger(amount) || amount < 1) {
    return res.status(400).json({ error: "amount must be a positive integer" });
  }

  return withIdempotency(req, res, "payout_attempt_create", roomCode, async () => {
    const session = await loadRoom(roomCode);
    if (!session || session.roomKey !== roomKey) {
      return { status: 404, body: { error: "room not found" } };
    }
    const obligation = await dbGet(
      "SELECT * FROM payout_obligations WHERE payout_id = ? AND room_code = ?",
      [payoutId, roomCode]
    );
    if (!obligation) {
      return { status: 404, body: { error: "payout not found" } };
    }
    if (obligation.status !== "open") {
      return { status: 409, body: { error: "obligation_not_open" } };
    }
    const outstanding = obligation.total_owed - obligation.confirmed_paid;
    if (amount > outstanding) {
      return { status: 409, body: { error: "amount_exceeds_outstanding", outstanding } };
    }

    const attemptId = newId();
    const now = Date.now();
    await dbRun(
      "INSERT INTO payout_attempts (attempt_id, payout_id, amount, status, note, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, ?, ?)",
      [attemptId, payoutId, amount, now, now]
    );
    return { status: 201, body: { attemptId, payoutId, amount, status: "pending" } };
  });
});

// PATCH /api/v2/rooms/:roomCode/payouts/:payoutId/attempts/:attemptId — transition an attempt.
// Confirming is the only transition that changes confirmed_paid, applied via a guarded UPDATE
// (WHERE status='pending') so a duplicate/retried confirm can never double-apply — see
// docs/BINGO_V2_PROTOCOL.md §7 ("a completed attempt must never be applied twice").
app.patch("/api/v2/rooms/:roomCode/payouts/:payoutId/attempts/:attemptId", async (req, res) => {
  const { roomCode, payoutId, attemptId } = req.params;
  const roomKey = getRoomKey(req);
  if (!roomKey) return res.status(400).json({ error: "roomKey required" });

  const status = req.body?.status;
  const validStatuses = new Set(["confirmed", "failed", "canceled", "ambiguous"]);
  if (!validStatuses.has(status)) {
    return res.status(400).json({ error: "status must be one of confirmed|failed|canceled|ambiguous" });
  }
  const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;

  return withIdempotency(req, res, "payout_attempt_transition", roomCode, async () => {
    const session = await loadRoom(roomCode);
    if (!session || session.roomKey !== roomKey) {
      return { status: 404, body: { error: "room not found" } };
    }
    const attempt = await dbGet(
      "SELECT * FROM payout_attempts WHERE attempt_id = ? AND payout_id = ?",
      [attemptId, payoutId]
    );
    if (!attempt) {
      return { status: 404, body: { error: "attempt not found" } };
    }

    const now = Date.now();
    if (status === "confirmed") {
      const guarded = await dbRun(
        "UPDATE payout_attempts SET status = 'confirmed', note = ?, updated_at = ? WHERE attempt_id = ? AND status = 'pending'",
        [note, now, attemptId]
      );
      if (guarded.changes > 0) {
        await dbRun(
          "UPDATE payout_obligations SET confirmed_paid = confirmed_paid + ?, updated_at = ? WHERE payout_id = ?",
          [attempt.amount, now, payoutId]
        );
        const obligation = await dbGet("SELECT * FROM payout_obligations WHERE payout_id = ?", [payoutId]);
        if (obligation && obligation.confirmed_paid >= obligation.total_owed) {
          await dbRun("UPDATE payout_obligations SET status = 'paid', updated_at = ? WHERE payout_id = ?", [now, payoutId]);
        }
      }
      // If guarded.changes === 0, this attempt was already confirmed by an earlier request
      // (or is in a terminal non-pending state) — confirmed_paid is intentionally NOT touched
      // again; we just report the current, already-correct state below.
    } else if (attempt.status === "pending") {
      await dbRun("UPDATE payout_attempts SET status = ?, note = ?, updated_at = ? WHERE attempt_id = ?", [status, note, now, attemptId]);
    }

    const finalAttempt = await dbGet("SELECT * FROM payout_attempts WHERE attempt_id = ?", [attemptId]);
    const finalObligation = await dbGet("SELECT * FROM payout_obligations WHERE payout_id = ?", [payoutId]);
    return {
      status: 200,
      body: {
        attemptId: finalAttempt.attempt_id,
        status: finalAttempt.status,
        note: finalAttempt.note || null,
        obligation: {
          payoutId: finalObligation.payout_id,
          totalOwed: finalObligation.total_owed,
          confirmedPaid: finalObligation.confirmed_paid,
          outstanding: Math.max(0, finalObligation.total_owed - finalObligation.confirmed_paid),
          status: finalObligation.status,
        },
      },
    };
  });
});

// POST /api/v2/rooms/:roomCode/claims — validated bingo claim path (docs/BINGO_V2_PROTOCOL.md
// §7). The legacy call_bingo Socket.IO handler is untouched and remains fully permissive.
app.post("/api/v2/rooms/:roomCode/claims", async (req, res) => {
  const { roomCode } = req.params;
  const { seed, cardIndex, name } = req.body || {};

  if (typeof seed !== "string" || !seed.trim()) {
    return res.status(400).json({ ok: false, validated: false, reason: "seed required" });
  }
  const index = Number(cardIndex);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ ok: false, validated: false, reason: "cardIndex required" });
  }

  const session = await loadRoom(roomCode);
  if (!session) {
    return res.status(404).json({ ok: false, validated: false, reason: "room_not_found" });
  }

  const allowedSeeds = getAllowedSeeds(session);
  if (allowedSeeds.length > 0 && !allowedSeeds.includes(seed.trim())) {
    return res.status(400).json({ ok: false, validated: false, reason: "invalid_seed" });
  }
  const allowedCount = session.allowedCards[seed.trim()] || 0;
  if (index >= allowedCount) {
    return res.status(400).json({ ok: false, validated: false, reason: "invalid_card_index" });
  }

  const grid = cardgen.generateCardForIndex(seed.trim(), index);
  const cardNums = cardgen.cardNumbers(grid);
  const daubed = session.daubs?.[seed.trim()]?.[String(index)] || session.daubs?.[seed.trim()]?.[index] || [];
  const daubedSet = new Set(daubed);

  const everyDaubWasCalled = daubed.every((n) => session.calledNumbers.includes(n));
  const everyDaubOnCard = daubed.every((n) => cardNums.includes(n));
  if (!everyDaubWasCalled || !everyDaubOnCard) {
    return res.status(400).json({ ok: false, validated: false, reason: "daub_state_invalid" });
  }

  const ruleType = getRoomRuleGameType(session);
  const hasBingo = cardgen.cardHasBingo(grid, daubedSet, ruleType);
  if (!hasBingo) {
    return res.status(400).json({ ok: false, validated: false, reason: "pattern_not_satisfied" });
  }

  const caller = typeof name === "string" && name.trim() ? name.trim().slice(0, 32) : "Unknown";
  const phase = session.progressive && session.progressive.enabled ? session.progressive.currentPhase : null;
  session.lastBingo = { name: caller, seed: seed.trim(), phase, timestamp: Date.now() };
  if (!Array.isArray(session.bingoCalls)) session.bingoCalls = [];
  session.bingoCalls.push({ name: caller, seed: seed.trim(), phase, timestamp: Date.now(), validated: true, cardIndex: index });
  touchSession(session);
  await saveRoom(roomCode, session.roomKey, session);

  io.to(roomCode).emit("bingo_called", { roomCode, name: caller, seed: seed.trim(), phase, timestamp: Date.now() });

  return res.json({ ok: true, validated: true, pattern: ruleType });
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
        gameTypeBase: "Single Line",
        displayGameType: "Single Line",
        progressive: defaultProgressiveState(),
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
        gameTypeBase: "Single Line",
        displayGameType: "Single Line",
        progressive: defaultProgressiveState(),
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
      gameType: getRoomRuleGameType(session),
      gameTypeBase: session.gameType,
      displayGameType: getRoomGameTypeLabel(session),
      progressive: session.progressive,
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
      phase:
        session.progressive && session.progressive.enabled
          ? session.progressive.currentPhase
          : null,
      timestamp: Date.now(),
    };
    if (!Array.isArray(session.bingoCalls)) {
      session.bingoCalls = [];
    }
    session.bingoCalls.push({
      name: caller,
      seed: typeof seed === "string" ? seed : null,
      phase:
        session.progressive && session.progressive.enabled
          ? session.progressive.currentPhase
          : null,
      timestamp: Date.now(),
    });
    touchSession(session);
    await saveRoom(roomCode, session.roomKey, session);

    io.to(roomCode).emit("bingo_called", {
      roomCode,
      name: caller,
      seed: typeof seed === "string" ? seed : null,
      phase:
        session.progressive && session.progressive.enabled
          ? session.progressive.currentPhase
          : null,
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

    // Additive acknowledgment (docs/BINGO_V2_PROTOCOL.md §"Authoritative daub state" in the
    // reconstruction brief): the legacy client never listened for this and is unaffected, but a
    // client that does can reconcile its optimistic local toggle against the backend's actual
    // persisted array for this card instead of trusting its own DOM state — sent unconditionally
    // (even on a no-op) so a reconnect-time replay of a queued mutation gets a fresh ack too.
    socket.emit("daub_state", {
      roomCode,
      seed,
      cardIndex: card,
      numbers: session.daubs[seed][card],
    });
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


