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

const calledSet = new Set();
const calledButtons = new Map();

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
  });
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
  grid.forEach((row) => {
    row.forEach((value) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell bingo-cell";
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
      });
      gridEl.appendChild(cell);
    });
  });

  card.appendChild(gridEl);
  return card;
}

const calledGrid = document.getElementById("called-grid");
for (let i = 1; i <= 75; i += 1) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "called-number";
  button.dataset.number = String(i);
  button.textContent = String(i);
  button.addEventListener("click", () => {
    if (!calledSet.has(String(i))) {
      return;
    }
    toggleDaubForNumber(String(i));
  });
  calledButtons.set(String(i), button);
  calledGrid.appendChild(button);
}

const cardsContainer = document.getElementById("cards");
cardsContainer.classList.toggle("single", count === 1);
cardsContainer.classList.toggle("multi", count > 1);
for (let i = 0; i < count; i += 1) {
  cardsContainer.appendChild(createCard(i));
}

const meta = document.getElementById("meta");
meta.textContent =
  count > 0
    ? `Seed ${masterSeed} - Cards ${count}`
    : "Add ?seed=ROOM&count=1 to generate cards.";

if (count > 0) {
  const defaultServerUrl = window.location.origin;
  const serverUrl = params.get("server") || defaultServerUrl;
  const socket = io(serverUrl);
  const roomCode = params.get("room") || masterSeed;

  socket.on("connect", () => {
    console.log("socket_connected", socket.id);
    socket.emit("join_room", roomCode);
  });

  socket.on("disconnect", (reason) => {
    console.log("socket_disconnected", reason);
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
    const called = (payload && payload.calledNumbers) || [];
    called.forEach((value) => {
      markCalled(String(value));
    });
  });

  socket.on("number_called", (payload) => {
    console.log("number_called", payload);
    if (!payload) {
      return;
    }
    markCalled(String(payload.number));
  });
}
