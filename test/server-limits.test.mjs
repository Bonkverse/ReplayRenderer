// Limits that keep one visitor from stalling the replay server.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createPool,
  statementTimeoutMs,
  DEFAULT_STATEMENT_TIMEOUT_MS,
} from "../server/api-routes.mjs";
import { registerPlayerRoutes } from "../server/player-routes.mjs";

test("a long run of spaces in /api/players is refused before any regex runs", async () => {
  // / +$/ on 16k spaces then "x" took ~0.3 s and blocked the event loop.
  const pool = { query: () => assert.fail("no query for a name this long") };
  const app = express();
  registerPlayerRoutes(app, pool, { enrichKeys: () => {}, sendDbError: () => {} });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    // "+" is a space in a query string: one byte each, so this fits in Node's
    // 16 KB request-header limit, like the real attack.
    const q = "+".repeat(15000) + "x";
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/players?q=${q}`);
    const ms = performance.now() - started;
    assert.deepEqual(await res.json(), { results: [] });
    assert.ok(ms < 100, `took ${ms.toFixed(0)} ms`);
  } finally {
    server.close();
  }
});

test("the pool cancels slow statements (15 s unless configured)", () => {
  let config;
  class FakePool {
    constructor(c) { config = c; }
    on() {}
  }
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused@localhost/unused";
  try {
    createPool(FakePool);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
  assert.equal(config.statement_timeout, DEFAULT_STATEMENT_TIMEOUT_MS);
});

test("DB_STATEMENT_TIMEOUT_MS overrides the timeout; 0 turns it off; junk is ignored", () => {
  assert.equal(statementTimeoutMs({}), 15_000);
  assert.equal(statementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(statementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: "0" }), 0);
  assert.equal(statementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: "soon" }), 15_000);
  assert.equal(statementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: "-1" }), 15_000);
});

test(
  "with the timeout, Postgres cancels a slow statement with 57014",
  { skip: !process.env.TEST_DATABASE_URL && "set TEST_DATABASE_URL to run" },
  async () => {
    const { default: pg } = await import("pg");
    const saved = { url: process.env.DATABASE_URL, ms: process.env.DB_STATEMENT_TIMEOUT_MS };
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.DB_STATEMENT_TIMEOUT_MS = "200";
    const pool = createPool(pg.Pool);
    try {
      await assert.rejects(pool.query("SELECT pg_sleep(2)"), (err) => err.code === "57014");
    } finally {
      await pool.end();
      for (const [k, v] of [["DATABASE_URL", saved.url], ["DB_STATEMENT_TIMEOUT_MS", saved.ms]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
);
