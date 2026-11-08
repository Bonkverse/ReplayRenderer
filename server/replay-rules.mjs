// server/replay-rules.mjs
//
// The advanced-search rules (shared/replayQuery.js) as one SQL condition
// on `replays r` LEFT JOIN `replay_meta rm`. Every value is a bound
// parameter (`p(value)` returns its placeholder); field and condition
// names only ever pick between fixed SQL snippets here.
//
// AND binds before OR: the rules are cut into groups at each OR, each group
// is ANDed, and the groups are ORed.
import { patternRegex } from "../shared/replayQuery.js";

const likeSafe = (s) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

const NUM_SQL = { eq: "=", ne: "<>", gte: ">=", lte: "<=" };

function numberCond(expr, rule, p, cast = "") {
  if (rule.op === "between") return `(${expr} BETWEEN ${p(rule.value)}${cast} AND ${p(rule.value2)}${cast})`;
  return `(${expr} ${NUM_SQL[rule.op]} ${p(rule.value)}${cast})`;
}

// A text comparison on a column: contains / starts / ends / is / pattern,
// case-insensitive unless the rule asks for match case.
function textCond(column, rule, p, op = rule.op) {
  const col = rule.caseSensitive ? column : `lower(${column})`;
  const val = (v) => (rule.caseSensitive ? p(v) : `lower(${p(v)})`);
  switch (op) {
    case "contains":
    case "not_contains":
      return `${col} LIKE '%' || ${val(likeSafe(rule.value))} || '%' ESCAPE '\\'`;
    case "starts":
      return `${col} LIKE ${val(likeSafe(rule.value))} || '%' ESCAPE '\\'`;
    case "ends":
      return `${col} LIKE '%' || ${val(likeSafe(rule.value))} ESCAPE '\\'`;
    case "is":
    case "is_not":
      return `${col} = ${val(rule.value)}`;
    case "pattern":
      return `${column} ${rule.caseSensitive ? "~" : "~*"} ${p(patternRegex(rule.value))}`;
    default:
      throw new Error(`text op ${op}`);
  }
}

// The day a replay was uploaded: live replays have fetched_at; collected
// later ones get their estimated day from replay_cycle_days.
const DAY_SQL = `COALESCE(
    (SELECT rcd.day FROM replay_cycle_days rcd
      WHERE rcd.cycle = r.cycle AND r.id BETWEEN rcd.first_id AND rcd.last_id LIMIT 1),
    (r.fetched_at AT TIME ZONE 'UTC')::date)`;

const ROOM_SQL = `(CASE WHEN COALESCE(rm.teams, false) THEN 'teams'
    WHEN rm.player_count <= 1 THEN 'solo'
    WHEN rm.player_count = 2 THEN '1v1'
    ELSE 'ffa' END)`;

/**
 * One rule as SQL. `guestCond` is the search's account-type filter for
 * player names ("AND NOT rp.guest", "AND rp.guest" or "").
 */
function ruleSql(rule, p, guestCond) {
  const participant = (cond) => `EXISTS (
      SELECT 1 FROM replay_participants rp
      WHERE rp.cycle = r.cycle AND rp.replay_id = r.id AND ${cond} ${guestCond})`;
  const anyMapVersion = (cond) => `EXISTS (
      SELECT 1 FROM maps mr WHERE mr.mapid = r.mapid AND ${cond})`;

  switch (rule.field) {
    case "player":
      if (rule.op === "is_not") return `NOT ${participant(textCond("rp.username", rule, p, "is"))}`;
      return participant(textCond("rp.username", rule, p));
    case "level":
      return participant(numberCond("rp.level", rule, p, "::int"));
    case "dbid":
    case "joined": {
      // player_ids: name ↔ DBID and estimated join day, sent by bonkverse.io
      let cond;
      if (rule.field === "dbid") {
        cond = numberCond("pi.dbid", rule, p, "::bigint");
      } else {
        const jan1 = (year) => `make_date(${p(year)}::int, 1, 1)`;
        const next = (year) => String(Number(year) + 1);
        if (rule.op === "eq") cond = `pi.joined >= ${jan1(rule.value)} AND pi.joined < ${jan1(next(rule.value))}`;
        else if (rule.op === "lt") cond = `pi.joined < ${jan1(rule.value)}`;
        else if (rule.op === "gt") cond = `pi.joined >= ${jan1(next(rule.value))}`;
        else cond = `pi.joined >= ${jan1(rule.value)} AND pi.joined < ${jan1(next(rule.value2))}`;
      }
      return `EXISTS (
        SELECT 1 FROM replay_participants rp
        JOIN player_ids pi ON lower(pi.username) = lower(rp.username)
        WHERE rp.cycle = r.cycle AND rp.replay_id = r.id AND NOT rp.guest AND ${cond})`;
    }
    case "players":
      return numberCond("rm.player_count", rule, p, "::int");
    case "guests":
      return numberCond("rm.guest_count", rule, p, "::int");
    case "mode":
      return rule.op === "is"
        ? `rm.mode = ${p(rule.value)}`
        : `rm.mode IS DISTINCT FROM ${p(rule.value)}`;
    case "length":
      // frames run at 30 per second
      return numberCond("rm.frames", { ...rule, value: String(Number(rule.value) * 30), value2: String(Number(rule.value2 || 0) * 30) }, p, "::int");
    case "rounds":
      return numberCond("rm.rounds", rule, p, "::int");
    case "win_limit":
      return numberCond("rm.win_limit", rule, p, "::int");
    case "room":
      return rule.op === "is"
        ? `rm.cycle IS NOT NULL AND ${ROOM_SQL} = ${p(rule.value)}`
        : `(rm.cycle IS NULL OR ${ROOM_SQL} <> ${p(rule.value)})`;
    case "teams":
      return rule.op === "yes" ? "rm.teams IS TRUE" : "rm.teams IS FALSE";
    case "quickplay":
      return rule.op === "yes" ? "rm.quickplay IS TRUE" : "rm.quickplay IS FALSE";
    case "map":
    case "author": {
      const column = rule.field === "map" ? "mr.name" : "mr.author";
      const negate = rule.op === "not_contains" || rule.op === "is_not";
      const found = anyMapVersion(textCond(column, rule, p));
      return negate ? `NOT ${found}` : found;
    }
    case "mapid":
      return rule.op === "eq"
        ? `r.mapid = ${p(rule.value)}::bigint`
        : `r.mapid IS DISTINCT FROM ${p(rule.value)}::bigint`;
    case "date": {
      const day = (v) => `${p(v)}::date`;
      if (rule.op === "on") return `${DAY_SQL} = ${day(rule.value)}`;
      if (rule.op === "before") return `${DAY_SQL} < ${day(rule.value)}`;
      if (rule.op === "after") return `${DAY_SQL} > ${day(rule.value)}`;
      return `${DAY_SQL} BETWEEN ${day(rule.value)} AND ${day(rule.value2)}`;
    }
    case "cycle":
      return `r.cycle = ${p(rule.value)}::int`;
    default:
      throw new Error(`unknown field ${rule.field}`);
  }
}

/** All rules as one SQL condition (AND before OR), or null for none. */
export function rulesSql(rules, p, guestCond = "AND NOT rp.guest") {
  if (!rules.length) return null;
  const groups = [];
  let current = [];
  rules.forEach((rule, i) => {
    if (i > 0 && rule.conn === "or") {
      groups.push(current);
      current = [];
    }
    current.push(`(${ruleSql(rule, p, guestCond)})`);
  });
  groups.push(current);
  return groups.length === 1
    ? groups[0].join(" AND ")
    : `(${groups.map((g) => `(${g.join(" AND ")})`).join(" OR ")})`;
}
