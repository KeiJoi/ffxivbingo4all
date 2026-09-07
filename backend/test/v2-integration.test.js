// Integration test for the v2 additive endpoints, run against a real (child-process) instance
// of server.js against a scratch SQLite file. Run manually with `node test/v2-integration.test.js`
// from the backend/ folder — no test runner is wired into package.json (see
// docs/BINGO_FORENSIC_AUDIT.md §"Build / Tests": this repo has never had an automated test
// suite). This mirrors, as a repeatable script, the exact flows manually verified during the
// VenueOS reconstruction: legacy host-sync compatibility, paid/comp card merge preservation
// across a legacy-shaped write, the economics lock, and the payout ledger's multi-chunk
// idempotent-confirm/crash-resume behavior (docs/BINGO_V2_PROTOCOL.md).

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = 39871;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, "_v2-integration.sqlite");
const CONFIG_PATH = path.join(__dirname, "..", "server.config.js");

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE}${urlPath}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch (err) {
            // leave json null; some routes (redirects) aren't JSON
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(attempts) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await request("GET", "/");
      if (result.status) return;
    } catch (err) {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not start in time");
}

async function run() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  // Temporarily point dbPath at a scratch file for this test run only, restoring the real
  // server.config.js content afterward no matter what happens.
  const originalConfig = fs.readFileSync(CONFIG_PATH, "utf8");
  const scratchConfig = originalConfig.replace(
    /dbPath:\s*"[^"]*"/,
    `dbPath: ${JSON.stringify(DB_PATH)}`
  );
  fs.writeFileSync(CONFIG_PATH, scratchConfig);

  let child;
  try {
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore",
    });
    await waitForServer(30);

    // --- 1) Legacy host-sync creates a "Legacy" room; economics always mutable. ---
    let res = await request("POST", "/api/host-sync", {
      roomCode: "IT-LEGACY",
      roomKey: "lk",
      calledNumbers: [],
      players: { seedA: { name: "Alice", count: 3 } },
      costPerCard: 100,
      startingPot: 50,
      prizePercentage: 80,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.lifecycle, "Legacy");
    assert.deepStrictEqual(res.body.pot, {
      paidCards: 3,
      compCards: 0,
      totalCards: 3,
      currentPot: 350,
      prizePool: 280,
    });
    console.log("PASS: legacy host-sync creates a Legacy room with correct additive pot");

    res = await request("POST", "/api/call-number", { roomCode: "IT-LEGACY", number: 999 });
    assert.strictEqual(res.status, 400, "out-of-range call must be rejected");
    res = await request("POST", "/api/call-number", { roomCode: "IT-LEGACY", number: 10 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.added, true);
    res = await request("POST", "/api/call-number", { roomCode: "IT-LEGACY", number: 10 });
    assert.strictEqual(res.body.added, false, "duplicate call must not be re-added");
    console.log("PASS: /api/call-number hardening (range check + dedup unchanged)");

    // --- 2) v2 room: create, grant paid+comp cards, verify pot excludes comp. ---
    res = await request("POST", "/api/v2/rooms", {
      roomCode: "IT-V2",
      roomKey: "vk",
      venueName: "Integration Venue",
      costPerCard: 100,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.lifecycle, "Draft");
    assert.strictEqual(res.body.title, "Integration Venue");
    console.log("PASS: v2 room creation (Draft lifecycle, venue name used as title)");

    res = await request(
      "POST",
      "/api/v2/rooms/IT-V2/cards",
      { seed: "seedX", name: "Bob", paidCount: 2, compCount: 1, idempotencyKey: "grant-1" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.pot, {
      paidCards: 2,
      compCards: 1,
      totalCards: 3,
      currentPot: 200,
      prizePool: 200,
    });
    const firstGrantSnapshot = JSON.stringify(res.body.players.seedX);

    // Idempotency: repeating the SAME grant key must not double-apply.
    res = await request(
      "POST",
      "/api/v2/rooms/IT-V2/cards",
      { seed: "seedX", name: "Bob", paidCount: 2, compCount: 1, idempotencyKey: "grant-1" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(JSON.stringify(res.body.players.seedX), firstGrantSnapshot, "duplicate idempotency key must not double-apply the grant");
    console.log("PASS: comp card does not inflate the paid pot; grant idempotency prevents double-apply");

    // --- 3) Legacy-shaped host-sync touching the SAME v2 room preserves compCount. ---
    res = await request("POST", "/api/host-sync", {
      roomCode: "IT-V2",
      roomKey: "vk",
      calledNumbers: [],
      players: { seedX: { name: "Bob", count: 4 } },
      costPerCard: 100,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.body.players.seedX.compCount, 1, "compCount must survive a legacy-shaped resync");
    assert.strictEqual(res.body.players.seedX.paidCount, 3, "the count delta (3->4) must be attributed to paidCount");
    console.log("PASS: comp-card allocation survives a legacy-shaped players write (delta attributed to paid)");

    // --- 4) Economics lock. ---
    res = await request("POST", "/api/v2/rooms/IT-V2/start", null, { "x-room-key": "vk" });
    assert.strictEqual(res.body.lifecycle, "Active");
    res = await request("POST", "/api/host-sync", {
      roomCode: "IT-V2",
      roomKey: "vk",
      calledNumbers: [],
      players: { seedX: { name: "Bob", count: 4 } },
      costPerCard: 999,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 409, "a genuine price change after Active must be rejected");
    res = await request("POST", "/api/host-sync", {
      roomCode: "IT-V2",
      roomKey: "vk",
      calledNumbers: [],
      players: { seedX: { name: "Bob", count: 4 } },
      costPerCard: 100,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 200, "resending the SAME price after Active must succeed (no-op)");
    console.log("PASS: economics lock rejects a genuine change, accepts a same-value resync");

    // A Legacy room must never be lockable.
    res = await request("POST", "/api/v2/rooms/IT-LEGACY/start", null, { "x-room-key": "lk" });
    assert.strictEqual(res.status, 409);
    console.log("PASS: a Legacy room can never be economics-locked");

    // --- 5) Payout ledger: multi-chunk, idempotent confirm, crash-resume snapshot. ---
    res = await request(
      "POST",
      "/api/v2/rooms/IT-V2/payouts",
      { winnerSeed: "seedX", winnerName: "Bob", totalOwed: 1750000, idempotencyKey: "payout-1" },
      { "x-room-key": "vk" }
    );
    const payoutId = res.body.payoutId;
    assert.strictEqual(res.body.outstanding, 1750000);

    res = await request(
      "POST",
      `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts`,
      { amount: 1000000, idempotencyKey: "attempt-1" },
      { "x-room-key": "vk" }
    );
    const attempt1Id = res.body.attemptId;

    for (let i = 0; i < 2; i += 1) {
      res = await request(
        "PATCH",
        `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts/${attempt1Id}`,
        { status: "confirmed", idempotencyKey: "confirm-1" },
        { "x-room-key": "vk" }
      );
      assert.strictEqual(res.body.obligation.confirmedPaid, 1000000, `confirmedPaid must be exactly 1,000,000 after ${i + 1} confirm call(s) — never double-applied`);
    }
    console.log("PASS: duplicate confirm of the same attempt never double-applies confirmedPaid");

    // Simulate a crash: read the full snapshot as a second host would.
    res = await request("GET", "/api/v2/rooms/IT-V2");
    assert.strictEqual(res.body.payouts[0].outstanding, 750000, "a resuming host must see exactly the outstanding remainder");
    console.log("PASS: crash/resume snapshot reports the exact outstanding remainder (1,750,000 - 1,000,000 = 750,000)");

    res = await request(
      "POST",
      `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts`,
      { amount: 750001, idempotencyKey: "attempt-2-bad" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(res.status, 409, "an attempt exceeding outstanding must be rejected");

    res = await request(
      "POST",
      `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts`,
      { amount: 750000, idempotencyKey: "attempt-2" },
      { "x-room-key": "vk" }
    );
    const attempt2Id = res.body.attemptId;
    res = await request(
      "PATCH",
      `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts/${attempt2Id}`,
      { status: "confirmed", idempotencyKey: "confirm-2" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(res.body.obligation.status, "paid");
    assert.strictEqual(res.body.obligation.outstanding, 0);
    console.log("PASS: obligation transitions to 'paid' exactly when confirmedPaid reaches totalOwed");

    res = await request(
      "POST",
      `/api/v2/rooms/IT-V2/payouts/${payoutId}/attempts`,
      { amount: 1, idempotencyKey: "attempt-3-bad" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(res.status, 409, "no further attempts may be created once an obligation is paid");
    console.log("PASS: a paid obligation rejects further attempts");

    // Ambiguous transition must not touch confirmedPaid.
    res = await request(
      "POST",
      "/api/v2/rooms/IT-V2/payouts",
      { winnerSeed: "seedY", winnerName: "Cara", totalOwed: 500, idempotencyKey: "payout-2" },
      { "x-room-key": "vk" }
    );
    const payoutId2 = res.body.payoutId;
    res = await request(
      "POST",
      `/api/v2/rooms/IT-V2/payouts/${payoutId2}/attempts`,
      { amount: 500, idempotencyKey: "attempt-y-1" },
      { "x-room-key": "vk" }
    );
    const attemptYId = res.body.attemptId;
    res = await request(
      "PATCH",
      `/api/v2/rooms/IT-V2/payouts/${payoutId2}/attempts/${attemptYId}`,
      { status: "ambiguous", idempotencyKey: "ambiguous-y-1" },
      { "x-room-key": "vk" }
    );
    assert.strictEqual(res.body.obligation.confirmedPaid, 0, "an ambiguous attempt must never be counted as paid");
    assert.strictEqual(res.body.obligation.status, "open", "an ambiguous attempt must leave the obligation open, not paid, for manual reconciliation");
    console.log("PASS: an 'ambiguous' outcome never marks anything paid (ambiguous != unpaid, but also != paid)");

    // --- 6) Room Key as a persistent per-venue grouping/listing key (product correction). ---
    // The backend's room_key semantics were never the bug — a persistent key reused across many room_codes already
    // works correctly here; the fix was entirely client-side (VenueOS was minting a new key per game instead of
    // reusing its configured one). This proves the backend needs no change for that fix to work.
    res = await request("POST", "/api/host-sync", {
      roomCode: "IT-VENUEA-1",
      roomKey: "VenueASecret",
      calledNumbers: [],
      players: {},
      costPerCard: 50,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 200);
    res = await request("POST", "/api/v2/rooms", {
      roomCode: "IT-VENUEA-2",
      roomKey: "VenueASecret",
      venueName: "Venue A",
      costPerCard: 50,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 201, "a v2-created room must accept the SAME persistent key a legacy room already used");
    res = await request("POST", "/api/host-sync", {
      roomCode: "IT-VENUEB-1",
      roomKey: "VenueBSecret",
      calledNumbers: [],
      players: {},
      costPerCard: 50,
      startingPot: 0,
      prizePercentage: 100,
      gameType: "Single Line",
    });
    assert.strictEqual(res.status, 200);

    res = await request("GET", "/api/rooms", null, { "x-room-key": "VenueASecret" });
    const venueARoomCodes = res.body.rooms.map((r) => r.roomCode).sort();
    assert.deepStrictEqual(
      venueARoomCodes,
      ["IT-VENUEA-1", "IT-VENUEA-2"],
      "listing by VenueASecret must return exactly Venue A's rooms — a mix of legacy-created and v2-created — and nothing from Venue B"
    );
    console.log("PASS: a persistent room_key correctly groups both legacy- and v2-created rooms, and separates venues");

    res = await request("GET", "/api/rooms", null, { "x-room-key": "VenueBSecret" });
    const venueBRoomCodes = res.body.rooms.map((r) => r.roomCode);
    assert.deepStrictEqual(venueBRoomCodes, ["IT-VENUEB-1"]);
    assert.ok(!venueBRoomCodes.includes("IT-VENUEA-1") && !venueBRoomCodes.includes("IT-VENUEA-2"), "Venue B's listing must never include Venue A's rooms");
    console.log("PASS: Venue B's listing is fully isolated from Venue A's, using the same shared backend");

    // A second host configured with Venue A's persistent key can discover and resume Venue A's room without ever
    // having generated or been told a per-game key — this is the host-handoff scenario the correction is about.
    res = await request("GET", "/api/v2/rooms/IT-VENUEA-2");
    assert.strictEqual(res.body.lifecycle, "Draft");
    assert.ok(!("roomKey" in res.body), "the public v2 room-read response must never include the room's key");
    console.log("PASS: host handoff can resume a discovered room by code, and the room key is never exposed in the public snapshot");

    console.log("\nAll v2 integration tests passed.");
  } finally {
    if (child) child.kill();
    fs.writeFileSync(CONFIG_PATH, originalConfig);
    // Best-effort cleanup: on Windows, sqlite3's file handle can briefly outlive the killed
    // child process, so a leftover scratch DB here is harmless (the next run deletes it first)
    // rather than something worth failing the test over.
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    } catch (err) {
      console.log("(non-fatal) could not remove scratch db immediately:", err.code);
    }
  }
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exitCode = 1;
});
