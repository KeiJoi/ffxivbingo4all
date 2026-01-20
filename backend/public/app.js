const params = new URLSearchParams(window.location.search);
const hasSeed = params.has("seed");
const hasCount = params.has("count");
const masterSeed = params.get("seed") || "default-seed";
const countParam = parseInt(params.get("count"), 10);
const count =
  hasSeed || hasCount
    ? Number.isFinite(countParam)
      ? Math.min(Math.max(countParam, 1), 16)
      : 1
    : 0;
const lettersParam = params.get("letters") || "BINGO";
const playerParam = params.get("player") || params.get("name") || "";
const titleParam = params.get("title") || "";
const gameParam = params.get("game") || params.get("type") || "";

function normalizeHex(value) {
  if (!value) {
    return null;
  }
  const cleaned = value.replace("#", "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const expanded = cleaned
      .split("")
      .map((ch) => ch + ch)
      .join("");
    return `#${expanded}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return `#${cleaned}`;
  }
  return null;
}

function setThemeVariable(paramName, varName, fallback) {
  const value = normalizeHex(params.get(paramName)) || fallback;
  document.documentElement.style.setProperty(varName, value);
}

setThemeVariable("bg", "--page-bg", "#111418");
setThemeVariable("card", "--card-bg", "#1b2026");
setThemeVariable("header", "--header-bg", "#2a313a");
setThemeVariable("text", "--text-color", "#e6edf3");
setThemeVariable("daub", "--daub-color", "#33d17a");
setThemeVariable("ball", "--ball-color", "#f3f3f3");

const calledSet = new Set();
const calledButtons = new Map();
const bingoCallButton = document.getElementById("bingo-call");
const bingoBanner = document.getElementById("bingo-banner");
const playerNameEl = document.getElementById("player-name");
const pageTitleEl = document.querySelector("header h1");
const roomCode = params.get("room") || masterSeed;
let socket = null;
let hasBingo = false;
let isConnected = false;
let enforceSeeds = false;
const cardMatrices = [];
const gameTypes = ["Single Line", "Two Lines", "Four Corners", "Blackout"];
let currentGameType = normalizeGameType(gameParam) || "Single Line";

const playerName =
  (playerParam || "").trim().length > 0 ? playerParam.trim().slice(0, 32) : "";
const pageTitle =
  (titleParam || "").trim().length > 0 ? titleParam.trim().slice(0, 40) : "";

if (pageTitleEl) {
  pageTitleEl.textContent = pageTitle || "FFXIV Bingo";
}

if (pageTitle) {
  document.title = pageTitle;
}

if (playerNameEl) {
  playerNameEl.textContent = playerName
    ? `Player: ${playerName}`
    : "Player: Guest";
}

function setBingoBanner(message) {
  if (!bingoBanner) {
    return;
  }
  bingoBanner.textContent = message;
  bingoBanner.classList.toggle("active", Boolean(message));
}

function normalizeGameType(value) {
  const trimmed = (value || "").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  for (const type of gameTypes) {
    if (type.toLowerCase() === trimmed) {
      return type;
    }
  }
  return "";
}

function showBlockingMessage(title, message) {
  document.body.classList.add("cheater");
  document.body.innerHTML = `
    <div class="cheat-screen">
      <h2>${title}</h2>
      <p>${message}</p>
    </div>
  `;
}

function showCheatMessage() {
  showBlockingMessage(
    "YOU ARE CHEATING!",
    "This card hash is not registered for the current room."
  );
}

function showMissingCardsMessage() {
  showBlockingMessage(
    "CARDS DON'T EXIST",
    "The seed you used is not registered for this room."
  );
}

function showServerUnreachableMessage() {
  showBlockingMessage(
    "SERVER UNREACHABLE",
    "The bingo server could not be reached. Check the server URL and try again."
  );
}

function updateBingoButtonState() {
  if (!bingoCallButton) {
    return;
  }
  bingoCallButton.disabled = !isConnected || !hasBingo;
}

function getCallerName() {
  return playerName.length > 0 ? playerName : "Guest";
}

if (bingoCallButton) {
  bingoCallButton.disabled = true;
  bingoCallButton.addEventListener("click", () => {
    if (!socket || !socket.connected) {
      setBingoBanner("Not connected to the server.");
      return;
    }
    if (!hasBingo) {
      setBingoBanner("No bingo detected yet.");
      return;
    }
    const caller = getCallerName();
    socket.emit("call_bingo", { roomCode, name: caller, seed: masterSeed });
    setBingoBanner(`BINGO called by ${caller}.`);
  });
}

const headers = (() => {
  let parts = [];
  if (/[^\w]/.test(lettersParam)) {
    parts = lettersParam.split(/[^A-Za-z0-9]+/).filter(Boolean);
  } else {
    parts = lettersParam.split("");
  }
  const fallback = "BINGO".split("");
  const result = [];
  for (let i = 0; i < 5; i += 1) {
    result.push((parts[i] || fallback[i]).toUpperCase());
  }
  return result;
})();

async function verifyRoomAvailability(serverUrl, room) {
  const normalized = serverUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(
      `${normalized}/api/room-state?roomCode=${encodeURIComponent(
        room
      )}&requireExisting=1`,
      { signal: controller.signal }
    );
    if (response.ok) {
      return { ok: true };
    }
    if (response.status === 404) {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "unreachable" };
  } catch (err) {
    console.log("room_check_failed", err);
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

function hashSeed(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateColumn(rng, start, end) {
  const numbers = [];
  for (let i = start; i <= end; i += 1) {
    numbers.push(i);
  }
  return shuffle(numbers, rng).slice(0, 5);
}

function generateCard(seed) {
  const rng = mulberry32(hashSeed(seed));
  const columns = [
    generateColumn(rng, 1, 15),
    generateColumn(rng, 16, 30),
    generateColumn(rng, 31, 45),
    generateColumn(rng, 46, 60),
    generateColumn(rng, 61, 75),
  ];
  const grid = [];
  for (let row = 0; row < 5; row += 1) {
    const rowValues = [];
    for (let col = 0; col < 5; col += 1) {
      if (row === 2 && col === 2) {
        rowValues.push("free");
      } else {
        rowValues.push(columns[col][row]);
      }
    }
    grid.push(rowValues);
  }
  return grid;
}

function setDaubed(cell, next) {
  cell.classList.toggle("daubed", next);
  cell.setAttribute("aria-pressed", String(next));
}

function emitDaubUpdate(cell, next) {
  if (!socket || !socket.connected) {
    return;
  }
  if (cell.dataset.number === "free") {
    return;
  }
  const cardIndex = Number(cell.dataset.card);
  if (!Number.isFinite(cardIndex)) {
    return;
  }
  socket.emit("daub_update", {
    roomCode,
    seed: masterSeed,
    cardIndex,
    number: cell.dataset.number,
    daubed: next,
  });
}

function isCellDaubed(cell) {
  return cell.classList.contains("daubed") || cell.dataset.number === "free";
}

function cardHasBingo(matrix) {
  const lowerType = currentGameType.toLowerCase();
  if (lowerType === "four corners") {
    return (
      isCellDaubed(matrix[0][0]) &&
      isCellDaubed(matrix[0][4]) &&
      isCellDaubed(matrix[4][0]) &&
      isCellDaubed(matrix[4][4])
    );
  }

  if (lowerType === "blackout") {
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (!isCellDaubed(matrix[row][col])) {
          return false;
        }
      }
    }
    return true;
  }

  let lines = 0;
  for (let row = 0; row < 5; row += 1) {
    let rowComplete = true;
    for (let col = 0; col < 5; col += 1) {
      if (!isCellDaubed(matrix[row][col])) {
        rowComplete = false;
        break;
      }
    }
    if (rowComplete) {
      lines += 1;
    }
  }

  for (let col = 0; col < 5; col += 1) {
    let colComplete = true;
    for (let row = 0; row < 5; row += 1) {
      if (!isCellDaubed(matrix[row][col])) {
        colComplete = false;
        break;
      }
    }
    if (colComplete) {
      lines += 1;
    }
  }

  let diagComplete = true;
  for (let i = 0; i < 5; i += 1) {
    if (!isCellDaubed(matrix[i][i])) {
      diagComplete = false;
      break;
    }
  }
  if (diagComplete) {
    lines += 1;
  }

  let antiDiagComplete = true;
  for (let i = 0; i < 5; i += 1) {
    if (!isCellDaubed(matrix[i][4 - i])) {
      antiDiagComplete = false;
      break;
    }
  }
  if (antiDiagComplete) {
    lines += 1;
  }

  if (lowerType === "two lines") {
    return lines >= 2;
  }

  return lines >= 1;
}

function updateBingoState() {
  hasBingo = cardMatrices.some((matrix) => cardHasBingo(matrix));
  updateBingoButtonState();
}

function canDaubCell(cell) {
  if (cell.dataset.number === "free") {
    return true;
  }
  return calledSet.has(cell.dataset.number);
}

function toggleDaubForNumber(value) {
  const selector = `[data-number="${value}"]`;
  const cells = Array.from(document.querySelectorAll(selector));
  if (!cells.length) {
    return;
  }
  const shouldDaub = cells.some((cell) => !cell.classList.contains("daubed"));
  cells.forEach((cell) => {
    if (!canDaubCell(cell)) {
      return;
    }
    setDaubed(cell, shouldDaub);
    emitDaubUpdate(cell, shouldDaub);
  });
  updateBingoState();
}

function createCard(index) {
  const seed = `${masterSeed}_${index}`;
  const grid = generateCard(seed);

  const card = document.createElement("section");
  card.className = "card";

  const headerRow = document.createElement("div");
  headerRow.className = "card-header";
  headers.forEach((label) => {
    const cell = document.createElement("div");
    cell.className = "header-cell";
    cell.textContent = label;
    headerRow.appendChild(cell);
  });
  card.appendChild(headerRow);

  const gridEl = document.createElement("div");
  gridEl.className = "grid";
  const matrix = [];
  grid.forEach((row, rowIndex) => {
    const rowCells = [];
    row.forEach((value) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell bingo-cell";
      cell.dataset.card = String(index);
      if (value === "free") {
        cell.classList.add("free", "daubed");
        cell.dataset.number = "free";
        cell.textContent = "FREE";
        cell.setAttribute("aria-pressed", "true");
      } else {
        cell.dataset.number = String(value);
        cell.textContent = value;
        cell.classList.add("uncalled");
        cell.setAttribute("aria-pressed", "false");
      }
      cell.addEventListener("click", () => {
        if (!canDaubCell(cell)) {
          return;
        }
        const next = !cell.classList.contains("daubed");
        setDaubed(cell, next);
        emitDaubUpdate(cell, next);
        updateBingoState();
      });
      gridEl.appendChild(cell);
      rowCells.push(cell);
    });
    matrix[rowIndex] = rowCells;
  });

  card.appendChild(gridEl);
  cardMatrices.push(matrix);
  return card;
}

const calledGrid = document.getElementById("called-grid");
if (calledGrid) {
  for (let col = 0; col < 5; col += 1) {
    const row = document.createElement("div");
    row.className = "called-row";

    for (let i = 1; i <= 15; i += 1) {
      const value = (col * 15) + i;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "called-number";
      button.dataset.number = String(value);
      button.textContent = String(value);
      button.addEventListener("click", () => {
        if (!calledSet.has(String(value))) {
          return;
        }
        toggleDaubForNumber(String(value));
      });
      calledButtons.set(String(value), button);
      row.appendChild(button);
    }

    calledGrid.appendChild(row);
  }
}

const cardsContainer = document.getElementById("cards");
cardsContainer.classList.toggle("single", count === 1);
cardsContainer.classList.toggle("multi", count > 1);
for (let i = 0; i < count; i += 1) {
  cardsContainer.appendChild(createCard(i));
}
updateBingoState();

const meta = document.getElementById("meta");
meta.textContent =
  count > 0
    ? `Seed ${masterSeed} - Cards ${count}`
    : "Add ?seed=ROOM&count=1 to generate cards.";

function connectSocket(serverUrl) {
  socket = io(serverUrl);

  socket.on("connect", () => {
    console.log("socket_connected", socket.id);
    socket.emit("join_room", { roomCode, seed: masterSeed });
    isConnected = true;
    updateBingoButtonState();
  });

  socket.on("connect_error", (err) => {
    console.log("socket_connect_error", err);
    showServerUnreachableMessage();
    if (socket) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("socket_disconnected", reason);
    isConnected = false;
    updateBingoButtonState();
  });

  function markCalled(value) {
    const key = String(value);
    calledSet.add(key);
    const button = calledButtons.get(key);
    if (button) {
      button.classList.add("called");
    }
    const selector = `[data-number="${key}"]`;
    document.querySelectorAll(selector).forEach((cell) => {
      cell.classList.add("called");
      cell.classList.remove("uncalled");
    });
  }

  socket.on("init_state", (payload) => {
    console.log("init_state", payload);
    const allowedSeeds = (payload && payload.allowedSeeds) || [];
    enforceSeeds =
      Boolean(payload && payload.enforceSeeds) || allowedSeeds.length > 0;
    if (payload && payload.gameType) {
      currentGameType = normalizeGameType(payload.gameType) || currentGameType;
    }
    if (enforceSeeds && !allowedSeeds.includes(masterSeed)) {
      showMissingCardsMessage();
      if (socket) {
        socket.disconnect();
      }
      return;
    }
    const called = (payload && payload.calledNumbers) || [];
    called.forEach((value) => {
      markCalled(String(value));
    });
    updateBingoState();
  });

  socket.on("number_called", (payload) => {
    console.log("number_called", payload);
    if (!payload) {
      return;
    }
    markCalled(String(payload.number));
  });

  socket.on("bingo_called", (payload) => {
    console.log("bingo_called", payload);
    const caller = payload && payload.name ? payload.name : "Unknown";
    setBingoBanner(`BINGO called by ${caller}!`);
  });

  socket.on("cheat_detected", (payload) => {
    if (payload && payload.reason === "invalid_seed") {
      showMissingCardsMessage();
    } else {
      showCheatMessage();
    }
    if (socket) {
      socket.disconnect();
    }
  });
}

if (count > 0) {
  const defaultServerUrl = window.location.origin;
  const serverUrl = params.get("server") || defaultServerUrl;

  verifyRoomAvailability(serverUrl, roomCode).then((result) => {
    if (!result.ok) {
      if (result.reason === "missing") {
        showMissingCardsMessage();
      } else {
        showServerUnreachableMessage();
      }
      return;
    }

    connectSocket(serverUrl);
  });
}
