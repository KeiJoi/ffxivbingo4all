// Server-side port of the deterministic card-generation and pattern-check algorithms.
//
// This is a byte-for-byte transcription of backend/public/app.js's hashSeed/mulberry32/
// shuffle/generateColumn/generateCard/cardHasBingo (the browser client) — which is itself
// already algorithmically identical to FFXIVBingo4All.Plugin/Plugin.cs's HashSeed/Mulberry32/
// GenerateColumn/GenerateCardGrid (the host plugin). Do NOT change this file without updating
// both of those in lockstep — see docs/BINGO_V2_PROTOCOL.md §9 and §24 of the forensic audit
// (card generation is a Category A "must preserve exactly" production contract).
//
// Used only by the new, additive POST /api/v2/rooms/:roomCode/claims validation path — the
// legacy call_bingo Socket.IO handler is untouched and does not use this module.

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
  return function next() {
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

// grid[row][col]; grid[2][2] === "free"
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

// Matches the browser client's per-seed-per-card seeding convention (app.js: `${masterSeed}_${index}`).
function generateCardForIndex(masterSeed, cardIndex) {
  const seed = cardIndex > 0 ? `${masterSeed}_${cardIndex}` : masterSeed;
  return generateCard(seed);
}

// daubedNumbers: a Set/array of numbers the seed has marked daubed for this card index.
// gameType: the room's effective rule game type string (e.g. from getRoomRuleGameType).
function cardHasBingo(grid, daubedNumbers, gameType) {
  const daubed = daubedNumbers instanceof Set ? daubedNumbers : new Set(daubedNumbers);
  const isDaubed = (value) => value === "free" || daubed.has(value);
  const lowerType = String(gameType || "").trim().toLowerCase();

  if (lowerType === "four corners") {
    return (
      isDaubed(grid[0][0]) &&
      isDaubed(grid[0][4]) &&
      isDaubed(grid[4][0]) &&
      isDaubed(grid[4][4])
    );
  }

  if (lowerType === "blackout") {
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (!isDaubed(grid[row][col])) {
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
      if (!isDaubed(grid[row][col])) {
        rowComplete = false;
        break;
      }
    }
    if (rowComplete) lines += 1;
  }

  for (let col = 0; col < 5; col += 1) {
    let colComplete = true;
    for (let row = 0; row < 5; row += 1) {
      if (!isDaubed(grid[row][col])) {
        colComplete = false;
        break;
      }
    }
    if (colComplete) lines += 1;
  }

  let diagComplete = true;
  for (let i = 0; i < 5; i += 1) {
    if (!isDaubed(grid[i][i])) {
      diagComplete = false;
      break;
    }
  }
  if (diagComplete) lines += 1;

  let antiDiagComplete = true;
  for (let i = 0; i < 5; i += 1) {
    if (!isDaubed(grid[i][4 - i])) {
      antiDiagComplete = false;
      break;
    }
  }
  if (antiDiagComplete) lines += 1;

  if (lowerType === "two lines") {
    return lines >= 2;
  }
  return lines >= 1;
}

// The non-"free" numbers that actually appear on a generated card — used to confirm every
// daubed number on a claimed card was a real number on that card AND was actually called.
function cardNumbers(grid) {
  const numbers = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const value = grid[row][col];
      if (value !== "free") numbers.push(value);
    }
  }
  return numbers;
}

module.exports = {
  hashSeed,
  mulberry32,
  shuffle,
  generateColumn,
  generateCard,
  generateCardForIndex,
  cardHasBingo,
  cardNumbers,
};
