const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { adminKey } = require("./admin.config");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const games = {};

function touchSession(session) {
  session.updatedAt = Date.now();
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
      daubs: {},
      lastBingo: null,
      gameType: "Single Line",
      updatedAt: Date.now(),
    };
  }
  return games[roomCode];
}

app.post("/api/host-sync", (req, res) => {
  const { roomCode, calledNumbers, allowedSeeds, gameType } = req.body || {};
  console.log("api_host_sync", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const session = getSession(roomCode);
  session.calledNumbers = Array.isArray(calledNumbers)
    ? calledNumbers.slice()
    : [];
  if (Array.isArray(allowedSeeds)) {
    const cleaned = allowedSeeds
      .filter((seed) => typeof seed === "string")
      .map((seed) => seed.trim())
      .filter((seed) => seed.length > 0);
    session.allowedSeeds = Array.from(new Set(cleaned));
    const allowedSet = new Set(session.allowedSeeds);
    Object.keys(session.daubs).forEach((seed) => {
      if (!allowedSet.has(seed)) {
        delete session.daubs[seed];
      }
    });
  }
  if (typeof gameType === "string" && gameType.trim().length > 0) {
    session.gameType = gameType.trim();
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
      daubPlayers,
      lastBingo: session.lastBingo,
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

  const session = getSession(roomCode);
  return res.json({
    ok: true,
    roomCode,
    calledNumbers: session.calledNumbers,
    allowedSeeds: session.allowedSeeds,
    daubs: session.daubs,
    lastBingo: session.lastBingo,
    gameType: session.gameType,
  });
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
        enforceSeeds: false,
      });
      return;
    }

    const session = getSession(roomCode);
    const enforceSeeds = Array.isArray(session.allowedSeeds)
      ? session.allowedSeeds.length > 0
      : false;

    if (enforceSeeds) {
      if (typeof seed !== "string" || !session.allowedSeeds.includes(seed)) {
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
      allowedSeedsCount: session.allowedSeeds.length,
    });
    socket.emit("init_state", {
      roomCode,
      calledNumbers: session.calledNumbers,
      allowedSeeds: session.allowedSeeds,
      enforceSeeds,
    });
  });

  socket.on("call_bingo", (payload) => {
    const { roomCode, name, seed } = payload || {};
    console.log("call_bingo", { socketId: socket.id, roomCode, name });

    if (!roomCode) {
      return;
    }

    const session = getSession(roomCode);
    if (
      Array.isArray(session.allowedSeeds) &&
      session.allowedSeeds.length > 0 &&
      (typeof seed !== "string" || !session.allowedSeeds.includes(seed))
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
    if (
      Array.isArray(session.allowedSeeds) &&
      session.allowedSeeds.length > 0 &&
      (typeof seed !== "string" || !session.allowedSeeds.includes(seed))
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
