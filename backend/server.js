const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const games = {};

function getSession(roomCode) {
  if (!games[roomCode]) {
    games[roomCode] = { calledNumbers: [] };
  }
  return games[roomCode];
}

app.post("/api/host-sync", (req, res) => {
  const { roomCode, calledNumbers } = req.body || {};
  console.log("api_host_sync", req.body);

  if (!roomCode) {
    return res.status(400).json({ error: "roomCode required" });
  }

  const session = getSession(roomCode);
  session.calledNumbers = Array.isArray(calledNumbers)
    ? calledNumbers.slice()
    : [];

  console.log("host_sync_updated", {
    roomCode,
    calledNumbers: session.calledNumbers,
  });
  return res.json({ ok: true, calledNumbers: session.calledNumbers });
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

  socket.on("join_room", (roomCode) => {
    console.log("join_room", { socketId: socket.id, roomCode });

    if (!roomCode) {
      socket.emit("init_state", { roomCode, calledNumbers: [] });
      return;
    }

    socket.join(roomCode);
    const session = getSession(roomCode);
    console.log("emit_init_state", {
      socketId: socket.id,
      roomCode,
      calledNumbers: session.calledNumbers,
    });
    socket.emit("init_state", {
      roomCode,
      calledNumbers: session.calledNumbers,
    });
  });

  socket.on("call_bingo", (payload) => {
    const { roomCode, name } = payload || {};
    console.log("call_bingo", { socketId: socket.id, roomCode, name });

    if (!roomCode) {
      return;
    }

    const caller =
      typeof name === "string" && name.trim().length > 0
        ? name.trim().slice(0, 32)
        : "Unknown";

    io.to(roomCode).emit("bingo_called", {
      roomCode,
      name: caller,
      timestamp: Date.now(),
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
