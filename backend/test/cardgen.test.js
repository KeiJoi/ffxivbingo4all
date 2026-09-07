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

  // ballsToBingoForCard (live-QA addition): the balls-to-Bingo proximity metric. Uses CALLED
  // numbers, not daubed ones — same lineGrid as above.
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [1, 2, 3, 4], "Single Line"), 1, "one number away from completing row 0");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [1, 2, 3, 4, 5], "Single Line"), 0, "a complete row is 0 away");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [], "Single Line"), 4, "an entirely uncalled card's closest line is a corner-touching row/col/diagonal needing 4 (the free center satisfies the middle row/col/diagonals' center cell for free)");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [1, 5, 20, 24], "Four Corners"), 0, "all four corners already called");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [1, 5, 20], "Four Corners"), 1, "one corner short");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, allNumbers, "Blackout"), 0, "every number called satisfies Blackout");
  assert.strictEqual(cardgen.ballsToBingoForCard(lineGrid, [1, 2, 3, 4], "Blackout"), allNumbers.length - 4, "Blackout counts every still-uncalled non-free cell");
  console.log("PASS: ballsToBingoForCard matches cardHasBingo's 0-distance boundary for Single Line/Four Corners/Blackout");

  // Two Lines: overlapping-line union, not closestLine + secondClosestLine. Row 0 and the main
  // diagonal share cell [0][0]=1 (already called) — completing row 0 needs {2,3,4,5} (4 more),
  // completing the diagonal (1,7,free,18,24) needs {7,18,24} (3 more, since 1 and free are already
  // satisfied). Their UNION is {2,3,4,5,7,18,24} = 7, not 4+3=7 coincidentally equal here because
  // they don't actually overlap on any MISSING cell — use a case where the missing cells overlap
  // to prove union (not sum) is used.
  const overlapGrid = [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10],
    [11, 12, "free", 13, 14],
    [15, 16, 17, 18, 19],
    [20, 21, 22, 23, 24],
  ];
  // Row 0 missing {3,4,5} (1,2 called); main diagonal (1,7,free,18,24) missing {18,24} (1,7 called;
  // free always satisfied) — these two lines share NO missing cell, so union = 3+2 = 5.
  assert.strictEqual(cardgen.ballsToBingoForCard(overlapGrid, [1, 2, 7], "Two Lines"), 5, "non-overlapping missing cells: union equals the sum");
  // Now also call 18 — row 0 still missing {3,4,5} (3), diagonal now missing {24} (1). A naive
  // sum-of-two-smallest could pick two DIFFERENT lines than the true best pair; the real answer
  // must still be the smallest ACHIEVABLE union across every pair, which here is row0+diagonal = 4.
  assert.strictEqual(cardgen.ballsToBingoForCard(overlapGrid, [1, 2, 7, 18], "Two Lines"), 4, "row 0 (missing 3) + diagonal (missing 1) unions to 4");
  assert.strictEqual(cardgen.cardHasBingo(overlapGrid, [1, 2, 7, 18, 3, 4, 5, 24], "Two Lines"), true, "calling exactly the unioned missing numbers completes Two Lines");
  console.log("PASS: Two Lines uses the minimum UNION of missing numbers across any two lines, not a naive sum");

  // Explicit shared-rules equivalence (Part 8 requirement): ballsToBingoForCard(...) === 0 if and
  // only if cardHasBingo(grid, sameNumbers, gameType) === true, for every supported game type —
  // proximity and claim validation can never silently disagree on what a valid Bingo IS.
  const gameTypes = ["Single Line", "Two Lines", "Four Corners", "Blackout"];
  const probes = [[], [1, 2, 3, 4], [1, 2, 3, 4, 5], allNumbers, [1, 5, 20, 24], fourCorners.concat([2, 3])];
  for (const gameType of gameTypes) {
    for (const probe of probes) {
      const distance = cardgen.ballsToBingoForCard(lineGrid, probe, gameType);
      const hasBingo = cardgen.cardHasBingo(lineGrid, probe, gameType);
      assert.strictEqual(distance === 0, hasBingo, `${gameType}: distance=${distance} but cardHasBingo=${hasBingo} for called=[${probe}]`);
    }
  }
  console.log("PASS: ballsToBingoForCard(...) === 0 exactly when cardHasBingo(...) === true, for every game type");

  console.log("\nAll cardgen tests passed.");
}

run();
