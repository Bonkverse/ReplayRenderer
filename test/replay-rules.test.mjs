// Advanced replay search: rule parsing (shared/replayQuery.js) and the SQL
// it becomes (server/replay-rules.mjs, via GET /api/search).
//
//   npm test                                   parsing tests only
//   TEST_DATABASE_URL=postgres://… npm test    also runs searches against a
//                                              scratch database with the
//                                              ReplayFetcher schema (it is
//                                              emptied and re-seeded)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import {
  parseRules,
  rulesToParams,
  describeRule,
  patternRegex,
} from "../shared/replayQuery.js";
import { registerApiRoutes } from "../server/api-routes.mjs";

const qs = (rules) => new URLSearchParams(rulesToParams(rules));

describe("parsing", () => {
  test("keeps usable rules and drops the rest", () => {
    const params = new URLSearchParams({
      f0: "player", o0: "is", v0: "  spaced ",
      c1: "or", f1: "level", o1: "between", v1: "200", w1: "100",
      f2: "mode", o2: "is", v2: "nope", // no such mode
      f3: "date", o3: "on", v3: "2026-02-30", // no such day
      f4: "evil", o4: "is", v4: "x",
      f5: "players", o5: "between", v5: "2", // between needs two
      f6: "teams", o6: "yes",
    });
    const rules = parseRules(params);
    assert.deepEqual(
      rules.map((r) => [r.conn, r.field, r.op, r.value, r.value2]),
      [
        ["and", "player", "is", "  spaced ", ""],
        ["or", "level", "between", "100", "200"],
        ["and", "teams", "yes", "", ""],
      ],
    );
  });

  test("reads Express-style query objects", () => {
    const rules = parseRules({ f0: "mode", o0: "is", v0: ["ard", "b"] });
    assert.equal(rules[0].value, "ard");
  });

  test("round-trips through URL params", () => {
    const rules = parseRules(new URLSearchParams("f0=map&o0=starts&v0=Death&k0=1&c1=or&f1=date&o1=between&v1=2026-05-01&w1=2026-06-01"));
    assert.deepEqual(parseRules(qs(rules)), rules);
  });

  test("describes rules for chips", () => {
    const [a, b, c] = parseRules(new URLSearchParams("f0=mode&o0=is&v0=ard&f1=length&o1=gte&v1=300&f2=player&o2=is&v2=a%20b"));
    assert.equal(describeRule(a), "Mode is Death Arrows");
    assert.equal(describeRule(b), "Length is at least 300 seconds");
    assert.equal(describeRule(c), "Player is in the game “a␣b”");
  });

  test("patterns escape everything but * and ?", () => {
    assert.equal(patternRegex("a*b?"), "^a.*b.$");
    assert.equal(patternRegex("x.(y)"), "^x\\.\\(y\\)$");
  });
});

// ─── Against a database ──────────────────────────────────────────────────

const DB = process.env.TEST_DATABASE_URL;

describe("searching", { skip: !DB && "set TEST_DATABASE_URL to run" }, () => {
  let pool, server, base;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB });
    await pool.query(`TRUNCATE replays, maps, replay_cycle_days CASCADE`);
    await pool.query(`CREATE TABLE IF NOT EXISTS player_ids (dbid BIGINT PRIMARY KEY, username TEXT NOT NULL, joined DATE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`TRUNCATE player_ids`);
    // From bonkverse.io: Alpha and _x_ have known DBIDs; Beta doesn't.
    await pool.query(`INSERT INTO player_ids (dbid, username, joined) VALUES (500, 'alpha', '2014-06-01'), (9000000, '_x_', '2021-03-01')`);
    // id, cycle, mapid, fetched_at, meta [mode, teams, quickplay, rounds, win_limit, frames, players, guests], players [name, guest, level]
    const games = [
      [1, 6, 10, "2026-06-01", ["ard", false, false, 5, 3, 3000, 2, 0], [["Alpha", false, 120], ["Beta", false, 40]]],
      [2, 6, 10, "2026-06-02", ["ard", true, true, 3, 3, 12000, 4, 1], [["Alpha", false, 121], ["guesty", true, 1], ["Gamma", false, 15], ["Delta", false, 9]]],
      [3, 6, 20, "2026-06-03", ["f", true, false, 2, 5, 9000, 8, 0], [["_x_", false, 60], ["Beta", false, 41]]],
      [4, 6, 30, "2026-06-04", ["b", false, false, 1, 1, 600, 1, 0], [["solo man", false, 3]]],
      [5, 5, 20, "2025-01-01", ["b", false, false, 4, 3, 1800, 3, 2], [["Alpha", false, 80]]],
    ];
    for (const [id, cycle, mapid, day, meta, players] of games) {
      await pool.query(`INSERT INTO replays (cycle, id, mapid, replaydata, fetched_at) VALUES ($1, $2, $3, '\\x00', $4)`, [cycle, id, mapid, `${day}T12:00:00Z`]);
      await pool.query(
        `INSERT INTO replay_meta (cycle, replay_id, mode, teams, quickplay, rounds, win_limit, frames, player_count, guest_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cycle, id, ...meta],
      );
      for (const [slot, [name, guest, level]] of players.entries()) {
        await pool.query(
          `INSERT INTO replay_participants (cycle, replay_id, slot, username, guest, level) VALUES ($1,$2,$3,$4,$5,$6)`,
          [cycle, id, slot, name, guest, level],
        );
      }
    }
    await pool.query(`INSERT INTO maps (mapid, version, name, author) VALUES (10, 1, 'Death Arrows Pit', 'Saucy'), (20, 1, 'Ball Park', 'Tulip'), (30, 1, 'Lonely', 'Saucy')`);
    // Cycle 5 replays carry an estimated day instead of fetched_at.
    await pool.query(`INSERT INTO replay_cycle_days (cycle, day, first_id, last_id) VALUES (5, '2025-04-10', 1, 100)`);

    const app = express();
    registerApiRoutes(app, pool);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await pool?.end();
  });

  async function ids(query) {
    const res = await fetch(`${base}/api/search?${query}`);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.results.map((r) => Number(r.id)).sort((a, b) => a - b);
  }
  const rule = (field, op, value, value2) => ({ field, op, value, value2, conn: "and" });
  const or = (field, op, value, value2) => ({ field, op, value, value2, conn: "or" });

  const cases = [
    ["player is in the game", [rule("player", "is", "alpha")], [1, 2, 5]],
    ["player isn't in the game", [rule("player", "is_not", "Alpha")], [3, 4]],
    ["two players in the same game", [rule("player", "is", "Alpha"), rule("player", "is", "Beta")], [1]],
    ["name starts and ends with _", [rule("player", "starts", "_"), rule("player", "ends", "_")], [3]],
    ["name pattern", [rule("player", "pattern", "?e?a")], [1, 3]],
    ["name pattern, longer", [rule("player", "pattern", "?e??a")], [2]],
    ["name with a space", [rule("player", "contains", " ")], [4]],
    ["guest names are left out by default", [rule("player", "is", "guesty")], []],
    ["a player's level", [rule("level", "gte", "100")], [1, 2]],
    ["level between", [rule("level", "between", "40", "60")], [1, 3]],
    ["player count", [rule("players", "gte", "4")], [2, 3]],
    ["no guests", [rule("guests", "eq", "0")], [1, 3, 4]],
    ["mode", [rule("mode", "is", "ard")], [1, 2]],
    ["mode is not", [rule("mode", "is_not", "ard")], [3, 4, 5]],
    ["length in seconds", [rule("length", "gte", "300")], [2, 3]],
    ["rounds", [rule("rounds", "between", "2", "4")], [2, 3, 5]],
    ["room 1v1", [rule("room", "is", "1v1")], [1]],
    ["room ffa", [rule("room", "is", "ffa")], [5]],
    ["room solo", [rule("room", "is", "solo")], [4]],
    ["teams", [rule("teams", "yes")], [2, 3]],
    ["quick play", [rule("quickplay", "yes")], [2]],
    ["map name", [rule("map", "contains", "arrows")], [1, 2]],
    ["map name, match case", [{ ...rule("map", "contains", "arrows"), caseSensitive: true }], []],
    ["map author", [rule("author", "is", "saucy")], [1, 2, 4]],
    ["map id", [rule("mapid", "eq", "20")], [3, 5]],
    ["date on (live)", [rule("date", "on", "2026-06-02")], [2]],
    ["date on (estimated day)", [rule("date", "on", "2025-04-10")], [5]],
    ["date between", [rule("date", "between", "2026-06-02", "2026-06-03")], [2, 3]],
    ["date before", [rule("date", "before", "2026-01-01")], [5]],
    ["cycle", [rule("cycle", "is", "5")], [5]],
    ["a player's DBID (names match any case)", [rule("dbid", "eq", "500")], [1, 2, 5]],
    ["DBID range", [rule("dbid", "gte", "1000000")], [3]],
    ["joined in a year", [rule("joined", "eq", "2014")], [1, 2, 5]],
    ["joined after", [rule("joined", "gt", "2014")], [3]],
    ["joined between", [rule("joined", "between", "2013", "2022")], [1, 2, 3, 5]],
    ["joined before", [rule("joined", "lt", "2014")], []],
    // AND before OR: (Death Arrows AND 1v1) OR Football
    ["and before or", [rule("mode", "is", "ard"), rule("room", "is", "1v1"), or("mode", "is", "f")], [1, 3]],
  ];
  for (const [name, rules, expected] of cases) {
    test(name, async () => {
      assert.deepEqual(await ids(qs(rules).toString()), expected);
    });
  }

  test("the DBID search tab finds a player's replays and names them", async () => {
    assert.deepEqual(await ids("q=500&scope=dbid"), [1, 2, 5]);
    const body = await (await fetch(`${base}/api/search?q=500&scope=dbid`)).json();
    assert.equal(body.query.dbidPlayer, "alpha");
    assert.deepEqual(await ids("q=abc&scope=dbid"), []); // not a number
  });

  test("\"All\" with a number also matches a DBID", async () => {
    assert.deepEqual(await ids("q=9000000"), [3]); // _x_'s DBID
    assert.deepEqual(await ids("q=2"), [2]); // still a replay ID
  });

  test("guests can be included for name rules", async () => {
    assert.deepEqual(await ids(`guests=include&${qs([rule("player", "is", "guesty")])}`), [2]);
  });

  test("rules combine with the search box", async () => {
    assert.deepEqual(await ids(`q=Alpha&scope=username&${qs([rule("mode", "is", "b")])}`), [5]);
  });

  test("the echo carries the rules back", async () => {
    const res = await fetch(`${base}/api/search?${qs([rule("teams", "no")])}`);
    const body = await res.json();
    assert.equal(body.query.rules[0].field, "teams");
  });
});

describe("sync with bonkverse.io", { skip: !DB && "set TEST_DATABASE_URL to run" }, () => {
  let pool, server, base;
  const TOKEN = "test-sync-token";
  const auth = { Authorization: `Bearer ${TOKEN}` };

  before(async () => {
    process.env.BONKVERSE_SYNC_TOKEN = TOKEN;
    pool = new pg.Pool({ connectionString: DB });
    const app = express();
    registerApiRoutes(app, pool);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    delete process.env.BONKVERSE_SYNC_TOKEN;
    server?.close();
    await pool?.end();
  });

  test("needs the token", async () => {
    assert.equal((await fetch(`${base}/api/internal/replay-names`)).status, 401);
    const wrong = await fetch(`${base}/api/internal/replay-names`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  });

  test("is hidden when no token is configured", async () => {
    delete process.env.BONKVERSE_SYNC_TOKEN;
    try {
      assert.equal((await fetch(`${base}/api/internal/replay-names`, { headers: auth })).status, 404);
    } finally {
      process.env.BONKVERSE_SYNC_TOKEN = TOKEN;
    }
  });

  test("saves name and DBID pairs, updating changed ones", async () => {
    const post = (players) =>
      fetch(`${base}/api/internal/player-ids`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ players }),
      }).then((r) => r.json());
    const first = await post([
      { username: "Beta", dbid: 777, joined: "2016-02-02" },
      { username: "bad", dbid: -4 },
      { username: "", dbid: 9 },
    ]);
    assert.deepEqual([first.received, first.written, first.skipped], [1, 1, 2]);
    const again = await post([{ username: "Beta", dbid: 777, joined: "2016-02-02" }]);
    assert.equal(again.written, 0); // unchanged rows aren't rewritten
    const changed = await post([{ username: "Beta", dbid: 777, joined: "2016-03-03" }]);
    assert.equal(changed.written, 1);
    const { rows } = await pool.query(`SELECT username, to_char(joined, 'YYYY-MM-DD') AS joined FROM player_ids WHERE dbid = 777`);
    assert.deepEqual(rows[0], { username: "Beta", joined: "2016-03-03" });
  });

  test("reads registered replay names in batches after a cursor", async () => {
    const get = (q) => fetch(`${base}/api/internal/replay-names?${q}`, { headers: auth }).then((r) => r.json());
    const page1 = await get("limit=2");
    assert.equal(page1.done, false);
    assert.equal(page1.next, "6:1"); // cycle 5's replay first, then cycle 6's
    assert.deepEqual(page1.names.map((n) => [n.username, n.games]), [["Alpha", 2], ["Beta", 1]]);
    const all = [];
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const page = await get(`limit=2${cursor ? `&after=${cursor}` : ""}`);
      all.push(...page.names);
      cursor = page.next;
      if (page.done) break;
    }
    const names = [...new Set(all.map((n) => n.username))].sort();
    assert.deepEqual(names, ["Alpha", "Beta", "Delta", "Gamma", "_x_", "solo man"]); // no guests
    const alphaLevels = all.filter((n) => n.username === "Alpha").map((n) => n.level);
    assert.ok(alphaLevels.includes(121));
  });
});
