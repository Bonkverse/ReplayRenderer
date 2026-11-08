// server/player-routes.mjs
//
// Player profiles built from the replay archive, for any registered bonk.io
// username, whether or not they have a Bonkverse account. Bonkverse (Django)
// reads these over HTTP because the replay database and the Bonkverse
// database are separate; the replay site can use them too.
//
// Only registered players get a profile. Registered usernames are unique and
// permanent; guest names are not, so a guest "profile" would mix strangers.
//
// What a replay can and can't tell us: each stored replay is the end of one
// round, with every player's account level at that moment, their team and
// the mode and map. It can't say who won, so there is no win rate here.
//
// Dates: replays collected live have an accurate fetched_at. Replays
// collected after the fact (cycle 5, the cycle 6 backlog) only have an
// estimated upload day from replay_cycle_days, so hours of the day come from
// live-collected replays only, and the response says how many that was.

const MAX_NAME_LENGTH = 100;
const TOP_N = 10;
const RECENT_N = 6;
const MAPS_N = 20;

// Every replay the player is in, with its date, mode and map. Referenced by
// each section below; Postgres materialises it once per request.
const PLAYER_CTE = `
  mine AS (
    SELECT rp.cycle, rp.replay_id, rp.slot, rp.team, rp.level, rp.username
    FROM replay_participants rp
    WHERE lower(rp.username) = lower($1) AND NOT rp.guest
  ),
  dated AS (
    SELECT m.*,
           r.mapid,
           r.fetched_at,
           COALESCE(rcd.day, (r.fetched_at AT TIME ZONE 'UTC')::date) AS day,
           rcd.day IS NULL AS live,
           rm.mode,
           COALESCE(rm.teams, false) AS teams,
           COALESCE(rm.quickplay, false) AS quickplay,
           rm.player_count,
           -- Room kind: team modes; alone; two players; otherwise free-for-all.
           CASE WHEN COALESCE(rm.teams, false) THEN 'teams'
                WHEN rm.player_count <= 1 THEN 'solo'
                WHEN rm.player_count = 2 THEN '1v1'
                ELSE 'ffa' END AS room
    FROM mine m
    JOIN replays r ON r.cycle = m.cycle AND r.id = m.replay_id
    LEFT JOIN replay_cycle_days rcd
      ON rcd.cycle = m.cycle AND m.replay_id BETWEEN rcd.first_id AND rcd.last_id
    LEFT JOIN replay_meta rm ON rm.cycle = m.cycle AND rm.replay_id = m.replay_id
  ),
  others AS (
    -- Other registered players in the same replays. Guests are left out:
    -- their names aren't identities.
    SELECT d.cycle, d.replay_id, d.teams, d.team AS my_team, d.room, d.mapid,
           o.username, o.team
    FROM dated d
    JOIN replay_participants o
      ON o.cycle = d.cycle AND o.replay_id = d.replay_id AND o.slot <> d.slot
    WHERE NOT o.guest AND lower(o.username) <> lower($1)
  )
`;

const PROFILE_SQL = `
  WITH ${PLAYER_CTE}
  SELECT
    (SELECT json_build_object(
        'username',      (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1],
        'games',         count(*),
        'current_level', (array_agg(level ORDER BY cycle DESC, replay_id DESC))[1],
        'peak_level',    max(level),
        'active_days',   count(DISTINCT day),
        'cycles',        count(DISTINCT cycle),
        'first', (array_agg(json_build_object('cycle', cycle, 'id', replay_id::text,
                    'day', to_char(day, 'YYYY-MM-DD')) ORDER BY cycle, replay_id))[1],
        'last',  (array_agg(json_build_object('cycle', cycle, 'id', replay_id::text,
                    'day', to_char(day, 'YYYY-MM-DD')) ORDER BY cycle DESC, replay_id DESC))[1],
        'team_games',    count(*) FILTER (WHERE teams)
      ) FROM dated) AS summary,

    -- One point per day played: games that day and the highest level seen.
    (SELECT COALESCE(json_agg(json_build_object(
        'day', to_char(day, 'YYYY-MM-DD'), 'games', games, 'level', level) ORDER BY day), '[]')
      FROM (SELECT day, count(*) AS games, max(level) AS level
            FROM dated WHERE day IS NOT NULL GROUP BY day) t) AS days,

    -- Mon = 1 … Sun = 7 (ISO), by upload day.
    (SELECT COALESCE(json_agg(json_build_object('weekday', wd, 'games', games) ORDER BY wd), '[]')
      FROM (SELECT extract(isodow FROM day)::int AS wd, count(*) AS games
            FROM dated WHERE day IS NOT NULL GROUP BY 1) t) AS weekdays,

    -- UTC hour, live-collected replays only (see top of file).
    (SELECT json_build_object(
        'sample', (SELECT count(*) FROM dated WHERE live),
        'hours', COALESCE(json_agg(json_build_object('hour', h, 'games', games) ORDER BY h), '[]'))
      FROM (SELECT extract(hour FROM fetched_at AT TIME ZONE 'UTC')::int AS h, count(*) AS games
            FROM dated WHERE live AND fetched_at IS NOT NULL GROUP BY 1) t) AS hours,

    (SELECT COALESCE(json_agg(json_build_object('mode', mode, 'games', games) ORDER BY games DESC), '[]')
      FROM (SELECT mode, count(*) AS games FROM dated GROUP BY mode) t) AS modes,

    (SELECT COALESCE(json_agg(json_build_object(
        'mapid', mapid::text, 'name', name, 'games', games, 'last_day', to_char(last_day, 'YYYY-MM-DD'),
        'rooms', json_build_object('1v1', one_v_one, 'ffa', ffa, 'teams', teams_n, 'solo', solo)) ORDER BY games DESC, mapid), '[]')
      FROM (
        SELECT t.*,
               (SELECT name FROM maps mp WHERE mp.mapid = t.mapid ORDER BY version DESC LIMIT 1) AS name
        FROM (SELECT mapid, count(*) AS games, max(day) AS last_day,
                     count(*) FILTER (WHERE room = '1v1') AS one_v_one,
                     count(*) FILTER (WHERE room = 'ffa') AS ffa,
                     count(*) FILTER (WHERE room = 'teams') AS teams_n,
                     count(*) FILTER (WHERE room = 'solo') AS solo
              FROM dated WHERE mapid IS NOT NULL
              GROUP BY mapid ORDER BY count(*) DESC, mapid LIMIT ${MAPS_N}) t
      ) t2) AS maps,

    -- What kind of rooms they play in.
    (SELECT json_build_object(
        '1v1', count(*) FILTER (WHERE room = '1v1'),
        'ffa', count(*) FILTER (WHERE room = 'ffa'),
        'teams', count(*) FILTER (WHERE room = 'teams'),
        'solo', count(*) FILTER (WHERE room = 'solo'),
        'quickplay', count(*) FILTER (WHERE quickplay),
        'median_players', percentile_cont(0.5) WITHIN GROUP (ORDER BY player_count),
        'distinct_maps', count(DISTINCT mapid)
      ) FROM dated) AS rooms,

    -- Each new highest level, in replay order. Replays only show levels, so
    -- this is when a level was first seen, not the exact moment it changed.
    (SELECT COALESCE(json_agg(json_build_object(
        'level', level, 'cycle', cycle, 'id', replay_id::text,
        'day', to_char(day, 'YYYY-MM-DD'),
        'at', CASE WHEN live THEN fetched_at END,
        'replays', replays_since) ORDER BY cycle, replay_id), '[]')
      FROM (SELECT x.*, n - lag(n, 1, 1::bigint) OVER (ORDER BY cycle, replay_id) AS replays_since
            FROM (SELECT d.*, row_number() OVER w AS n,
                         max(level) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
                  FROM dated d WINDOW w AS (ORDER BY cycle, replay_id)) x
            WHERE prev_max IS NOT NULL AND level > prev_max) y) AS level_ups,

    -- Replays per UTC hour, live-collected replays only; the page turns these
    -- into the viewer's own days and hours.
    (SELECT COALESCE(json_agg(json_build_object('t', t, 'games', games) ORDER BY t), '[]')
      FROM (SELECT to_char(date_trunc('hour', fetched_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"') AS t,
                   count(*) AS games
            FROM dated WHERE live AND fetched_at IS NOT NULL GROUP BY 1) t) AS live_hours,

    -- Sessions: live replays less than 30 minutes apart (by when they were
    -- collected, which trails play by a few minutes).
    (SELECT json_build_object(
        'count', count(*),
        'median_minutes', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 0),
        'longest_minutes', round(max(minutes)::numeric, 0))
      FROM (SELECT sid, extract(epoch FROM max(fetched_at) - min(fetched_at)) / 60 AS minutes
            FROM (SELECT fetched_at,
                         sum(new_session) OVER (ORDER BY fetched_at) AS sid
                  FROM (SELECT fetched_at,
                               CASE WHEN fetched_at - lag(fetched_at) OVER (ORDER BY fetched_at)
                                         <= interval '30 minutes' THEN 0 ELSE 1 END AS new_session
                        FROM dated WHERE live AND fetched_at IS NOT NULL) a) b
            GROUP BY sid) c) AS sessions,

    -- Registered players seen in the same replays most often, and how many
    -- of those games were on the same team (team modes; red = 2 and up).
    (SELECT COALESCE(json_agg(json_build_object(
        'username', username, 'games', games, 'same_team', same_team) ORDER BY games DESC, username), '[]')
      FROM (SELECT (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1] AS username,
                   count(DISTINCT (cycle, replay_id)) AS games,
                   count(DISTINCT (cycle, replay_id))
                     FILTER (WHERE teams AND my_team >= 2 AND team = my_team) AS same_team
            FROM others GROUP BY lower(username)
            ORDER BY 2 DESC, 1 LIMIT ${TOP_N}) t) AS played_with,

    (SELECT COALESCE(json_agg(json_build_object(
        'username', username, 'games', games) ORDER BY games DESC, username), '[]')
      FROM (SELECT (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1] AS username,
                   count(DISTINCT (cycle, replay_id)) AS games
            FROM others
            WHERE teams AND my_team >= 2 AND team = my_team
            GROUP BY lower(username)
            ORDER BY 2 DESC, 1 LIMIT ${TOP_N}) t) AS teammates,

    -- Opponents: the other team in team games, or the other player in a 1v1.
    (SELECT COALESCE(json_agg(json_build_object(
        'username', username, 'games', games) ORDER BY games DESC, username), '[]')
      FROM (SELECT (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1] AS username,
                   count(DISTINCT (cycle, replay_id)) AS games
            FROM others
            WHERE (teams AND my_team >= 2 AND team >= 2 AND team <> my_team) OR room = '1v1'
            GROUP BY lower(username)
            ORDER BY 2 DESC, 1 LIMIT ${TOP_N}) t) AS rivals
`;

// One map, from one player's side: how they play it and who with.
const PLAYER_MAP_SQL = `
  WITH ${PLAYER_CTE}
  SELECT
    (SELECT json_build_object(
        'games', count(*),
        'first_day', to_char(min(day), 'YYYY-MM-DD'),
        'last_day', to_char(max(day), 'YYYY-MM-DD'),
        'rooms', json_build_object(
          '1v1', count(*) FILTER (WHERE room = '1v1'),
          'ffa', count(*) FILTER (WHERE room = 'ffa'),
          'teams', count(*) FILTER (WHERE room = 'teams'),
          'solo', count(*) FILTER (WHERE room = 'solo')),
        'modes', (SELECT COALESCE(json_object_agg(COALESCE(mode, '?'), n), '{}')
                  FROM (SELECT mode, count(*) AS n FROM dated WHERE mapid = $2 GROUP BY mode) mm)
      ) FROM dated WHERE mapid = $2) AS summary,
    (SELECT name FROM maps WHERE mapid = $2 ORDER BY version DESC LIMIT 1) AS name,
    (SELECT COALESCE(json_agg(json_build_object(
        'username', username, 'games', games, 'same_team', same_team) ORDER BY games DESC, username), '[]')
      FROM (SELECT (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1] AS username,
                   count(DISTINCT (cycle, replay_id)) AS games,
                   count(DISTINCT (cycle, replay_id))
                     FILTER (WHERE teams AND my_team >= 2 AND team = my_team) AS same_team
            FROM others WHERE mapid = $2
            GROUP BY lower(username)
            ORDER BY 2 DESC, 1 LIMIT 5) t) AS played_with
`;

export function validPlayerName(raw) {
  const name = String(raw ?? "");
  // Not trimmed: bonk.io names can have meaningful leading/trailing spaces.
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

// Every registered player's highest level seen in replays, counted per
// level. It reads the whole participants table, so it's computed at most
// every few hours and shared by every request in between.
const DISTRIBUTION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SANE_LEVEL = 5000; // ignore corrupt values (e.g. clamped 1e308)
let distribution = null; // { at, data }
let distributionPending = null;

async function levelDistribution(pool) {
  if (distribution && Date.now() - distribution.at < DISTRIBUTION_TTL_MS) return distribution.data;
  if (!distributionPending) {
    distributionPending = pool
      .query(
        `SELECT lvl AS level, count(*)::int AS players
         FROM (SELECT max(level) AS lvl
               FROM replay_participants
               WHERE NOT guest AND level > 0 AND level <= ${MAX_SANE_LEVEL}
               GROUP BY lower(username)) t
         GROUP BY lvl ORDER BY lvl`
      )
      .then((result) => {
        const levels = result.rows.map((r) => [r.level, r.players]);
        const data = {
          levels,
          players: levels.reduce((sum, [, n]) => sum + n, 0),
          generated_at: new Date().toISOString(),
        };
        distribution = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        distributionPending = null;
      });
  }
  return distributionPending;
}

export function registerPlayerRoutes(app, pool, { enrichKeys, sendDbError }) {
  // ─── Level distribution ─────────────────────────────────────────────────
  //
  // GET /api/levels/distribution → {levels: [[level, players], ...],
  // players, generated_at}: how many registered players have each level
  // as their highest seen in replays. For "higher than N% of players".
  app.get("/api/levels/distribution", async (req, res) => {
    try {
      const data = await levelDistribution(pool);
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.json(data);
    } catch (err) {
      console.error("GET /api/levels/distribution failed:", err);
      return sendDbError(res, err, "We couldn't work out the level spread right now.");
    }
  });

  // The player name from the path, or from ?name= on the query-string routes.
  const nameFrom = (req) =>
    req.params.name ?? (typeof req.query.name === "string" ? req.query.name : undefined);

  // ─── Full profile ───────────────────────────────────────────────────────
  //
  // GET /api/player/:name → summary, per-day games and level, weekday and
  // hour activity, modes, top maps, frequent co-players and teammates, and
  // the most recent replays (same shape as search results).
  //
  // GET /api/player?name=… is the same, for names that can't sit in a path:
  // "." and ".." are dot segments, which clients and proxies resolve away
  // (/api/player/.. becomes /api/).
  app.get(["/api/player/:name", "/api/player"], async (req, res) => {
    const name = validPlayerName(nameFrom(req));
    if (!name) return res.status(400).json({ error: "That isn't a valid username." });

    try {
      const [profile, recent] = await Promise.all([
        pool.query(PROFILE_SQL, [name]),
        enrichKeys(
          pool,
          `SELECT r.cycle, r.id, r.mapid, r.fetched_at
           FROM replay_participants rp
           JOIN replays r ON r.cycle = rp.cycle AND r.id = rp.replay_id
           WHERE lower(rp.username) = lower($1) AND NOT rp.guest
           ORDER BY rp.cycle DESC, rp.replay_id DESC
           LIMIT ${RECENT_N}`,
          [name]
        ),
      ]);

      const row = profile.rows[0];
      if (!row?.summary || !row.summary.games) {
        res.setHeader("Cache-Control", "public, max-age=300");
        return res.status(404).json({
          error: "No replays found for that registered player.",
          username: name,
        });
      }

      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({
        username: row.summary.username,
        summary: row.summary,
        days: row.days,
        weekdays: row.weekdays,
        hours: row.hours,
        modes: row.modes,
        maps: row.maps,
        played_with: row.played_with,
        teammates: row.teammates,
        rivals: row.rivals,
        rooms: row.rooms,
        level_ups: row.level_ups,
        live_hours: row.live_hours,
        sessions: row.sessions,
        recent,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("GET /api/player/:name failed:", err);
      return sendDbError(res, err, "We couldn't load that player. Please try again.");
    }
  });

  // ─── One map from a player's side ───────────────────────────────────────
  //
  // GET /api/player/:name/map/:mapid → games, first/last day, room and mode
  // split, and the registered players they play it with most.
  // GET /api/player/map/:mapid?name=… is the same, with the name in the query.
  app.get(["/api/player/:name/map/:mapid", "/api/player/map/:mapid"], async (req, res) => {
    const name = validPlayerName(nameFrom(req));
    const mapid = String(req.params.mapid ?? "");
    if (!name || !/^\d{1,18}$/.test(mapid)) {
      return res.status(400).json({ error: "That isn't a valid player or map." });
    }
    try {
      const result = await pool.query(PLAYER_MAP_SQL, [name, mapid]);
      const row = result.rows[0];
      res.setHeader("Cache-Control", "public, max-age=300");
      if (!row?.summary?.games) {
        return res.status(404).json({ error: "This player has no replays on that map." });
      }
      return res.json({ mapid, name: row.name, ...row.summary, played_with: row.played_with });
    } catch (err) {
      console.error("GET /api/player/:name/map/:mapid failed:", err);
      return sendDbError(res, err, "We couldn't load that map for this player.");
    }
  });

  // ─── Bulk lookup by exact name ──────────────────────────────────────────
  //
  // GET /api/players/lookup?names=a&names=b (up to 60) → replay totals for
  // each registered name that has replays, for player search cards on
  // Bonkverse and its public API. Names without replays are simply missing
  // from the results.
  //
  // Each result: username (latest spelling), games, level (in their latest
  // replay), peak_level, last ({cycle, id}), and when that latest replay was
  // seen: seen_at is the exact collection time for live-collected replays
  // (null otherwise); seen_day is always set, and seen_estimated says it
  // came from replay_cycle_days (cycle 5, the cycle 6 backlog) rather than
  // a live fetch.
  app.get("/api/players/lookup", async (req, res) => {
    const raw = req.query.names;
    const names = [...new Set((Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .map((n) => validPlayerName(n))
      .filter(Boolean)
      .map((n) => n.toLowerCase()))].slice(0, 60);
    if (names.length === 0) return res.json({ results: [] });
    try {
      const result = await pool.query(
        `WITH hits AS (
           SELECT rp.cycle, rp.replay_id, rp.username, rp.level
           FROM replay_participants rp
           WHERE NOT rp.guest AND lower(rp.username) = ANY($1::text[])
         ),
         totals AS (
           SELECT lower(username) AS k, count(*)::int AS games, max(level) AS peak_level
           FROM hits GROUP BY 1
         ),
         latest AS (
           SELECT DISTINCT ON (lower(username))
                  lower(username) AS k, username, level, cycle, replay_id
           FROM hits
           ORDER BY lower(username), cycle DESC, replay_id DESC
         )
         SELECT l.username, t.games, l.level, t.peak_level,
                json_build_object('cycle', l.cycle, 'id', l.replay_id::text) AS last,
                CASE WHEN rcd.day IS NULL THEN r.fetched_at END AS seen_at,
                to_char(COALESCE(rcd.day, (r.fetched_at AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD')
                  AS seen_day,
                rcd.day IS NOT NULL AS seen_estimated
         FROM latest l
         JOIN totals t ON t.k = l.k
         JOIN replays r ON r.cycle = l.cycle AND r.id = l.replay_id
         LEFT JOIN replay_cycle_days rcd
           ON rcd.cycle = l.cycle AND l.replay_id BETWEEN rcd.first_id AND rcd.last_id`,
        [names]
      );
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({ results: result.rows });
    } catch (err) {
      console.error("GET /api/players/lookup failed:", err);
      return sendDbError(res, err, "We couldn't look up those players right now.");
    }
  });

  // ─── Name lookup (autocomplete / "did you mean") ────────────────────────
  //
  // GET /api/players?q=prefix → up to 10 registered names starting with q,
  // most-played first. Served by the trigram index on lower(username),
  // which needs at least 3 characters to narrow anything down.
  app.get("/api/players", async (req, res) => {
    const q = String(req.query.q ?? "");
    if (q.length < 3 || q.length > MAX_NAME_LENGTH) return res.json({ results: [] });

    const likeSafe = (s) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    try {
      const result = await pool.query(
        `SELECT (array_agg(username ORDER BY cycle DESC, replay_id DESC))[1] AS username,
                count(*)::int AS games,
                max(level) AS level
         FROM replay_participants
         WHERE NOT guest
           AND lower(username) LIKE lower($1) || '%' ESCAPE '\\'
         GROUP BY lower(username)
         ORDER BY count(*) DESC
         LIMIT 10`,
        [likeSafe(q)]
      );
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json({ results: result.rows });
    } catch (err) {
      console.error("GET /api/players failed:", err);
      return sendDbError(res, err, "We couldn't look up players right now.");
    }
  });
}
