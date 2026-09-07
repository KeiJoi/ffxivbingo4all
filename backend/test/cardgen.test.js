// Deterministic card-generation vectors. Run manually with `node test/cardgen.test.js` from
// the backend/ folder — no test runner is wired into package.json (matches the rest of this
// repo, which has no automated test suite at all; see docs/BINGO_FORENSIC_AUDIT.md §"Build /
// Tests"). These same vectors are asserted in VenueOS's C# port (BingoCardGenerator) so all
// three implementations (donor plugin, browser client, backend) are proven to agree — see
// docs/BINGO_V2_PROTOCOL.md §9.

const assert = require("assert");
const cardgen = require("../lib/cardgen");

function run() {
  // Vector captured directly from this module — regenerated after the live-QA Card 1 fix (see
  // generateCardForIndex's doc comment): index 0 now uses "{seed}_0", matching app.js's
  // createCard(index) and the donor plugin's GenerateCardGrid EXACTLY (neither has ever
  // special-cased index 0 to use the bare seed — that special case was this module's own bug).
  const grid = cardgen.generateCardForIndex("seedC", 0);
  assert.deepStrictEqual(grid, [
    [9, 28, 35, 47, 75],
    [13, 24, 44, 49, 73],
    [1, 25, "free", 54, 64],
    [11, 26, 42, 53, 61],
    [5, 30, 34, 56, 67],
  ], "seedC/index 0 (Card 1) must match the known vector");
  console.log("PASS: seedC/index 0 (Card 1) known vector");

  // Determinism: same seed+index always reproduces the same grid.
  const gridAgain = cardgen.generateCardForIndex("seedC", 0);
  assert.deepStrictEqual(grid, gridAgain, "same seed+index must always regenerate identically");
  console.log("PASS: determinism (same seed+index -> same grid)");

  // REGRESSION GUARD for the exact live-QA bug: generateCardForIndex(seed, 0) must equal
  // generateCard("{seed}_0") — NOT generateCard(seed) with no suffix at all. The buggy version
  // special-cased index 0 to the bare seed; this assertion fails against that buggy version and
  // passes against the fix. Every index (including 0) uses the identical "{seed}_{index}" rule.
  assert.deepStrictEqual(grid, cardgen.generateCard("seedC_0"), "index 0 must equal generateCard(`${seed}_0`) — the SAME rule every other index uses, no special case");
  assert.notDeepStrictEqual(grid, cardgen.generateCard("seedC"), "index 0 must NOT equal the bare, unsuffixed seed's card — that was the exact live-QA Card 1 bug");
  const secondCardGrid = cardgen.generateCardForIndex("seedC", 1);
  const suffixedGrid = cardgen.generateCard("seedC_1");
  assert.deepStrictEqual(secondCardGrid, suffixedGrid, "index 1 must equal generateCard(`${seed}_1`)");
  assert.notDeepStrictEqual(grid, secondCardGrid, "different card indexes must produce different cards");
  console.log("PASS: EVERY card index (including 0) uses the unconditional `${seed}_${index}` rule — no bare-seed special case");

  // --- Cross-implementation golden compatibility vectors (live-QA requirement): Card 1 (index 0),
  // Card 2 (index 1), Card 3 (index 2), and Card 16 (index 15), for two representative seeds. The
  // identical vectors are asserted in VenueOS's C# BingoCardGeneratorTests — both implementations
  // must independently produce these exact matrices. Pay particular attention to index 0, which is
  // the one index the live bug actually affected. ---
  const goldenSeedC = {
    0: [[9, 28, 35, 47, 75], [13, 24, 44, 49, 73], [1, 25, "free", 54, 64], [11, 26, 42, 53, 61], [5, 30, 34, 56, 67]],
    1: [[11, 21, 40, 56, 65], [2, 17, 43, 60, 70], [10, 16, "free", 55, 74], [12, 20, 42, 50, 68], [1, 26, 45, 49, 75]],
    2: [[6, 23, 41, 57, 64], [9, 27, 40, 58, 69], [13, 22, "free", 55, 67], [4, 21, 38, 59, 74], [15, 28, 36, 52, 70]],
    15: [[4, 23, 45, 49, 70], [7, 18, 41, 54, 75], [9, 30, "free", 55, 69], [3, 29, 37, 51, 71], [2, 24, 43, 58, 64]],
  };
  const goldenVenueQaSeed = {
    0: [[13, 30, 33, 46, 72], [10, 22, 37, 55, 75], [11, 26, "free", 56, 67], [8, 29, 45, 52, 62], [4, 24, 40, 50, 66]],
    1: [[3, 26, 41, 56, 61], [9, 28, 42, 51, 73], [12, 18, "free", 53, 72], [6, 16, 40, 54, 66], [5, 19, 38, 50, 68]],
    15: [[10, 29, 41, 52, 71], [9, 24, 33, 47, 67], [6, 19, "free", 60, 61], [3, 23, 39, 48, 66], [4, 17, 37, 49, 64]],
  };
  for (const [seed, byIndex] of [["seedC", goldenSeedC], ["venue-QA-seed-42", goldenVenueQaSeed]]) {
    for (const [indexStr, expected] of Object.entries(byIndex)) {
      const index = Number(indexStr);
      const actual = cardgen.generateCardForIndex(seed, index);
      assert.deepStrictEqual(actual, expected, `${seed}/index ${index} (Card ${index + 1}) golden vector mismatch`);
    }
  }
  console.log("PASS: cross-implementation golden vectors for Card 1/2/3/16 across two representative seeds (see matching C# BingoCardGeneratorTests)");

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
