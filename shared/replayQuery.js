// shared/replayQuery.js
//
// The advanced replay search: a rule builder, one line per rule,
// [Where / AND / OR] [field] [condition] [value]. Shared by the server
// (server/replay-rules.mjs turns rules into SQL) and the page
// (browser/app/pages/Search.jsx draws the builder), so both always agree on
// the fields, their conditions and their values.
//
// AND binds before OR, like in a search engine: a AND b OR c means
// (a AND b) OR c.
//
// Rules travel in the URL as numbered parameters, the same as on
// bonkverse.io's Players page: c1 (AND/OR, not on the first), f0 (field),
// o0 (condition), v0 (value), w0 (second value for "between"), k0 (match
// case, text only).

export const MAX_RULES = 12;
export const MAX_TEXT = 100;
const MAX_WILDCARDS = 10;

const NUMBER_OPS = [
  ["eq", "is"],
  ["ne", "is not"],
  ["gte", "is at least"],
  ["lte", "is at most"],
  ["between", "is between"],
];
const TEXT_OPS = [
  ["contains", "contains"],
  ["not_contains", "doesn't contain"],
  ["starts", "starts with"],
  ["ends", "ends with"],
  ["is", "is exactly"],
  ["is_not", "is not"],
  ["pattern", "matches pattern"],
];

export const MODES = [
  ["b", "Classic"],
  ["ar", "Arrows"],
  ["ard", "Death Arrows"],
  ["sp", "Grapple"],
  ["v", "VTOL"],
  ["f", "Football"],
  ["bs", "Simple"],
];
export const ROOMS = [
  ["1v1", "1v1"],
  ["ffa", "Free for all"],
  ["teams", "Teams"],
  ["solo", "Solo"],
];

// value: text | number | choice | date | none
export const FIELDS = [
  // ── Players ──
  {
    key: "player",
    group: "Players",
    label: "Player",
    value: "text",
    ops: [
      ["is", "is in the game"],
      ["is_not", "isn't in the game"],
      ["contains", "name contains"],
      ["starts", "name starts with"],
      ["ends", "name ends with"],
      ["pattern", "name matches pattern"],
    ],
  },
  {
    key: "level",
    group: "Players",
    label: "A player's level",
    value: "number",
    min: 1,
    max: 5000,
    ops: [
      ["gte", "is at least"],
      ["lte", "is at most"],
      ["eq", "is"],
      ["between", "is between"],
    ],
  },
  { key: "players", group: "Players", label: "Players", value: "number", min: 0, max: 99, unit: "in the game", ops: NUMBER_OPS },
  { key: "guests", group: "Players", label: "Guests", value: "number", min: 0, max: 99, unit: "in the game", ops: NUMBER_OPS },

  // ── Game ──
  { key: "mode", group: "Game", label: "Mode", value: "choice", choices: MODES, ops: [["is", "is"], ["is_not", "is not"]] },
  {
    key: "length",
    group: "Game",
    label: "Length",
    value: "number",
    min: 0,
    max: 36000,
    unit: "seconds",
    ops: [["gte", "is at least"], ["lte", "is at most"], ["between", "is between"]],
  },
  { key: "rounds", group: "Game", label: "Rounds played", value: "number", min: 0, max: 999, ops: NUMBER_OPS },
  { key: "win_limit", group: "Game", label: "Rounds to win", value: "number", min: 0, max: 999, ops: NUMBER_OPS },

  // ── Lobby ──
  { key: "room", group: "Lobby", label: "Room", value: "choice", choices: ROOMS, ops: [["is", "is"], ["is_not", "is not"]] },
  { key: "teams", group: "Lobby", label: "Teams on", value: "none", ops: [["yes", "yes"], ["no", "no"]] },
  { key: "quickplay", group: "Lobby", label: "Quick play", value: "none", ops: [["yes", "yes"], ["no", "no"]] },

  // ── Map ──
  { key: "map", group: "Map", label: "Map name", value: "text", ops: TEXT_OPS },
  { key: "author", group: "Map", label: "Map author", value: "text", ops: TEXT_OPS },
  { key: "mapid", group: "Map", label: "Map ID", value: "number", min: 1, max: 1e15, ops: [["eq", "is"], ["ne", "is not"]] },

  // ── Date ──
  {
    key: "date",
    group: "Date",
    label: "Date",
    value: "date",
    ops: [
      ["on", "is on"],
      ["before", "is before"],
      ["after", "is after"],
      ["between", "is between"],
    ],
  },
  { key: "cycle", group: "Date", label: "Cycle", value: "choice", choices: [["6", "Cycle 6 (May 2026 – now)"], ["5", "Cycle 5 (Mar 2025 – Apr 2026)"]], ops: [["is", "is"]] },
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const FIELD_GROUPS = [...new Set(FIELDS.map((f) => f.group))];

// One-click starting points under the builder.
export const EXAMPLES = [
  ["1v1s on Death Arrows", [{ field: "room", op: "is", value: "1v1" }, { field: "mode", op: "is", value: "ard" }]],
  ["Level 100+ player", [{ field: "level", op: "gte", value: "100" }]],
  ["Long games (5 min+)", [{ field: "length", op: "gte", value: "300" }]],
  ["Big lobbies (8+)", [{ field: "players", op: "gte", value: "8" }]],
  ["Football teams", [{ field: "mode", op: "is", value: "f" }, { field: "teams", op: "yes" }]],
  ["No guests", [{ field: "guests", op: "eq", value: "0" }]],
];

// ─── Parsing ───────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

function validNumber(raw, spec) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return n >= spec.min && n <= spec.max ? s : null;
}

/** Rule `i` from a params getter (`get(name) → string | null`), or null. */
function readRule(get, i) {
  const spec = FIELD_BY_KEY[get(`f${i}`) ?? ""];
  if (!spec) return null;
  const op = get(`o${i}`) ?? "";
  if (!spec.ops.some(([k]) => k === op)) return null;
  const rule = {
    conn: get(`c${i}`) === "or" ? "or" : "and",
    field: spec.key,
    op,
    value: "",
    value2: "",
    caseSensitive: false,
  };
  const raw = get(`v${i}`) ?? "";
  const raw2 = get(`w${i}`) ?? "";
  const between = op === "between";

  if (spec.value === "none") return rule;
  if (spec.value === "text") {
    rule.value = String(raw).slice(0, MAX_TEXT); // not trimmed: spaces are part of names
    rule.caseSensitive = get(`k${i}`) === "1";
    return rule.value ? rule : null;
  }
  if (spec.value === "choice") {
    rule.value = spec.choices.some(([k]) => k === raw) ? raw : "";
    return rule.value ? rule : null;
  }
  const check = spec.value === "date" ? validDate : (s) => validNumber(s, spec);
  const a = check(raw);
  if (a == null) return null;
  rule.value = a;
  if (between) {
    const b = check(raw2);
    if (b == null) return null;
    const less = spec.value === "date" ? a <= b : Number(a) <= Number(b);
    [rule.value, rule.value2] = less ? [a, b] : [b, a];
  }
  return rule;
}

/** Usable rules from URL/query params; unusable lines are dropped. */
export function parseRules(params) {
  const get =
    typeof params.get === "function"
      ? (k) => params.get(k)
      : (k) => (Array.isArray(params[k]) ? params[k][0] : params[k] ?? null);
  const rules = [];
  for (let i = 0; i < MAX_RULES; i++) {
    const rule = readRule(get, i);
    if (rule) rules.push(rule);
  }
  return rules;
}

/** Rules → { name: value } URL params (numbered from 0, no blanks). */
export function rulesToParams(rules) {
  const out = {};
  rules.forEach((r, i) => {
    if (i > 0) out[`c${i}`] = r.conn;
    out[`f${i}`] = r.field;
    out[`o${i}`] = r.op;
    if (r.value) out[`v${i}`] = r.value;
    if (r.value2 && r.op === "between") out[`w${i}`] = r.value2;
    if (r.caseSensitive) out[`k${i}`] = "1";
  });
  return out;
}

/** "Mode is Death Arrows", for the chips above the results. */
export function describeRule(r) {
  const spec = FIELD_BY_KEY[r.field];
  const op = spec.ops.find(([k]) => k === r.op)[1];
  if (spec.value === "none") return `${spec.label}: ${op}`;
  if (spec.value === "choice") return `${spec.label} ${op} ${spec.choices.find(([k]) => k === r.value)[1]}`;
  if (spec.value === "text") {
    const shown = r.value.replace(/ /g, "␣");
    return `${spec.label} ${op} “${shown}”${r.caseSensitive ? " (Aa)" : ""}`;
  }
  const unit = spec.unit ? ` ${spec.unit}` : "";
  if (r.op === "between") return `${spec.label} ${op} ${r.value} and ${r.value2}${unit}`;
  return `${spec.label} ${op} ${r.value}${unit}`;
}

/** A name pattern as an anchored POSIX regex: * any run, ? one character. */
export function patternRegex(text) {
  let wild = 0;
  let out = "";
  for (const ch of text) {
    if ((ch === "*" || ch === "?") && wild < MAX_WILDCARDS) {
      wild++;
      out += ch === "*" ? ".*" : ".";
    } else {
      out += /[\\^$.|?*+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return `^${out}$`;
}
