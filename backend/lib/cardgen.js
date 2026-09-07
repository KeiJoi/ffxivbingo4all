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

// Shared, ONE authoritative definition of "what cells make up a valid win for this game type"
// (live-QA correction — balls-to-Bingo proximity must never implement a subtly different notion
// of Bingo than claim validation). Returns either:
//   { kind: "all", cells: [[row,col], ...] }             — every listed cell must be satisfied
//   { kind: "lines", lines: [[[row,col]x5], ...], needed } — at least `needed` of the listed
//                                                            5-cell lines must be fully satisfied
// "lines" always lists all 5 rows, then all 5 columns, then the two diagonals (12 total) — the
// exact same candidate set cardHasBingo has always checked, just organized as data instead of
// three separate inline loops.
function getPatternGroups(gameType) {
  const lowerType = String(gameType || "").trim().toLowerCase();

  if (lowerType === "four corners") {
    return { kind: "all", cells: [[0, 0], [0, 4], [4, 0], [4, 4]] };
  }

  if (lowerType === "blackout") {
    const cells = [];
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) cells.push([row, col]);
    }
    return { kind: "all", cells };
  }

  const lines = [];
  for (let row = 0; row < 5; row += 1) {
    const line = [];
    for (let col = 0; col < 5; col += 1) line.push([row, col]);
    lines.push(line);
  }
  for (let col = 0; col < 5; col += 1) {
    const line = [];
    for (let row = 0; row < 5; row += 1) line.push([row, col]);
    lines.push(line);
  }
  lines.push([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  lines.push([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]);

  return { kind: "lines", lines, needed: lowerType === "two lines" ? 2 : 1 };
}

// daubedNumbers: a Set/array of numbers the seed has marked daubed for this card index.
// gameType: the room's effective rule game type string (e.g. from getRoomRuleGameType).
// Behavior is UNCHANGED from before this was rewritten on top of getPatternGroups — see
// backend/test/cardgen.test.js's existing pattern-rule assertions, which still pass verbatim.
function cardHasBingo(grid, daubedNumbers, gameType) {
  const daubed = daubedNumbers instanceof Set ? daubedNumbers : new Set(daubedNumbers);
  const isDaubed = (value) => value === "free" || daubed.has(value);
  const group = getPatternGroups(gameType);

  if (group.kind === "all") {
    return group.cells.every(([row, col]) => isDaubed(grid[row][col]));
  }

  let lines = 0;
  for (const line of group.lines) {
    if (line.every(([row, col]) => isDaubed(grid[row][col]))) lines += 1;
  }
  return lines >= group.needed;
}

// Live-QA addition: "how many more balls must be CALLED (not daubed) before this card could be a
// valid Bingo under this game type" — the backend-authoritative basis for the roster's "(N)"
// balls-to-Bingo display. Deliberately takes CALLED numbers, not daubed ones: a player forgetting
// to click an already-called number must not count as a ball still needing to be called (see
// docs/BINGO_V2_PROTOCOL.md's balls-to-Bingo section). Uses the exact same getPatternGroups this
// card's cardHasBingo result would use, so `ballsToBingoForCard(...) === 0` if and only if
// `cardHasBingo(grid, calledNumbers, gameType) === true` — the two can never silently disagree on
// what a "valid Bingo" is, only on which set of numbers (daubed vs. called) they're evaluated
// against (see backend/test/cardgen.test.js's explicit equivalence assertions).
function ballsToBingoForCard(grid, calledNumbers, gameType) {
  const called = calledNumbers instanceof Set ? calledNumbers : new Set(calledNumbers);
  const isSatisfied = (value) => value === "free" || called.has(value);
  const group = getPatternGroups(gameType);

  if (group.kind === "all") {
    return group.cells.reduce((missing, [row, col]) => missing + (isSatisfied(grid[row][col]) ? 0 : 1), 0);
  }

  const missingSets = group.lines.map((line) => {
    const missing = new Set();
    for (const [row, col] of line) {
      const value = grid[row][col];
      if (!isSatisfied(value)) missing.add(value);
    }
    return missing;
  });

  if (group.needed === 1) {
    return Math.min(...missingSets.map((set) => set.size));
  }

  // needed === 2 ("Two Lines"): the minimum UNION of missing numbers across any two candidate
  // lines — two lines can share a cell (e.g. a row and a diagonal both pass through the center),
  // so summing their two individual missing-counts can overstate how many NEW balls are actually
  // required. The union is the true answer: "how many distinct numbers must still be called for
  // BOTH of these lines to complete simultaneously."
  let best = Infinity;
  for (let i = 0; i < missingSets.length; i += 1) {
    for (let j = i + 1; j < missingSets.length; j += 1) {
      const unionSize = new Set([...missingSets[i], ...missingSets[j]]).size;
      if (unionSize < best) best = unionSize;
    }
  }
  return best;
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
  getPatternGroups,
  cardHasBingo,
  ballsToBingoForCard,
  cardNumbers,
};
