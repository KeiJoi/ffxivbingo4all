// Deterministic card-generation vectors. Run manually with `node test/cardgen.test.js` from
// the backend/ folder — no test runner is wired into package.json (matches the rest of this
// repo, which has no automated test suite at all; see docs/BINGO_FORENSIC_AUDIT.md §"Build /
// Tests"). These same vectors are asserted in VenueOS's C# port (BingoCardGenerator) so all
// three implementations (donor plugin, browser client, backend) are proven to agree — see
// docs/BINGO_V2_PROTOCOL.md §9.

const assert = require("assert");
const cardgen = require("../lib/cardgen");

function run() {
  // Vector captured directly from this module and cross-checked against the browser client's
  // identical algorithm (backend/public/app.js) by inspection line-for-line.
  const grid = cardgen.generateCardForIndex("seedC", 0);
  assert.deepStrictEqual(grid, [
    [5, 30, 35, 52, 65],
    [15, 22, 38, 56, 71],
    [10, 28, "free", 54, 64],
    [2, 20, 32, 48, 73],
    [3, 16, 36, 57, 68],
  ], "seedC/index 0 must match the known vector");
  console.log("PASS: seedC/index 0 known vector");

  // Determinism: same seed+index always reproduces the same grid.
  const gridAgain = cardgen.generateCardForIndex("seedC", 0);
  assert.deepStrictEqual(grid, gridAgain, "same seed+index must always regenerate identically");
  console.log("PASS: determinism (same seed+index -> same grid)");

  // Index 0 uses the bare seed; index > 0 uses "{seed}_{index}" (app.js's own convention).
  const bareSeedGrid = cardgen.generateCard("seedC");
  assert.deepStrictEqual(grid, bareSeedGrid, "index 0 must equal generateCard(seed) with no suffix");
  const secondCardGrid = cardgen.generateCardForIndex("seedC", 1);
  const suffixedGrid = cardgen.generateCard("seedC_1");
  assert.deepStrictEqual(secondCardGrid, suffixedGrid, "index 1 must equal generateCard(`${seed}_1`)");
  assert.notDeepStrictEqual(grid, secondCardGrid, "different card indexes must produce different cards");
  console.log("PASS: per-index seeding convention (bare seed for index 0, `${seed}_${index}` otherwise)");

  // Free space is always the center cell.
  assert.strictEqual(grid[2][2], "free", "row 2, col 2 must always be the free space");
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if (row === 2 && col === 2) continue;
      assert.ok(Number.isInteger(grid[row][col]), `cell [${row}][${col}] must be a number`);
    }
  }
  console.log("PASS: free space placement and non-free cell types");

  // Column ranges match standard 75-ball bingo (B:1-15, I:16-30, N:31-45, G:46-60, O:61-75).
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  for (let col = 0; col < 5; col += 1) {
    for (let row = 0; row < 5; row += 1) {
      const value = grid[row][col];
      if (value === "free") continue;
      assert.ok(
        value >= ranges[col][0] && value <= ranges[col][1],
        `column ${col} value ${value} out of range ${ranges[col]}`
      );
    }
  }
  console.log("PASS: column ranges match standard 75-ball bingo layout");

  // cardHasBingo pattern checks.
  const lineGrid = [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11, 12, "free", 13, 14],
    [15, 16, 17, 18, 19],
    [20, 21, 22, 23, 24],
  ];
  assert.strictEqual(
    cardgen.cardHasBingo(lineGrid, [1, 2, 3, 4, 5], "Single Line"),
    true,
    "a fully daubed row must satisfy Single Line"
  );
  assert.strictEqual(
    cardgen.cardHasBingo(lineGrid, [1, 2, 3], "Single Line"),
    false,
    "a partially daubed row must not satisfy Single Line"
  );
  assert.strictEqual(
    cardgen.cardHasBingo(lineGrid, [1, 2, 3, 4, 5], "Two Lines"),
    false,
    "one complete line must not satisfy Two Lines"
  );
  const fourCorners = [1, 5, 20, 24];
  assert.strictEqual(
    cardgen.cardHasBingo(lineGrid, fourCorners, "Four Corners"),
    true,
    "all four corners daubed must satisfy Four Corners"
  );
  const allNumbers = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      if (lineGrid[row][col] !== "free") allNumbers.push(lineGrid[row][col]);
    }
  }
  assert.strictEqual(cardgen.cardHasBingo(lineGrid, allNumbers, "Blackout"), true);
  assert.strictEqual(cardgen.cardHasBingo(lineGrid, [1, 2, 3, 4], "Blackout"), false);
  console.log("PASS: cardHasBingo pattern rules (Single Line / Two Lines / Four Corners / Blackout)");

  console.log("\nAll cardgen tests passed.");
}

run();
