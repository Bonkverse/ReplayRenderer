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
           COALESCE(rm.teams, false) AS teams
    FROM mine m
    JOIN replays r ON r.cycle = m.cycle AND r.id = m.replay_id
    LEFT JOIN replay_cycle_days rcd
      ON rcd.cycle = m.cycle AND m.replay_id BETWEEN rcd.first_id AND rcd.last_id
    LEFT JOIN replay_meta rm ON rm.cycle = m.cycle AND rm.replay_id = m.replay_id
  ),
  others AS (
    -- Other registered players in the same replays. Guests are left out:
    -- their names aren't identities.
    SELECT d.cycle, d.replay_id, d.teams, d.team AS my_team,
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
        'mapid', mapid::text, 'name', name, 'games', games) ORDER BY games DESC, mapid), '[]')
      FROM (
        SELECT t.mapid, t.games,
               (SELECT name FROM maps mp WHERE mp.mapid = t.mapid ORDER BY version DESC LIMIT 1) AS name
        FROM (SELECT mapid, count(*) AS games FROM dated WHERE mapid IS NOT NULL
              GROUP BY mapid ORDER BY count(*) DESC, mapid LIMIT ${TOP_N}) t
      ) t2) AS maps,

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
            ORDER BY 2 DESC, 1 LIMIT ${TOP_N}) t) AS teammates
`;

export function validPlayerName(raw) {
  const name = String(raw ?? "");
  // Not trimmed: bonk.io names can have meaningful leading/trailing spaces.
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function registerPlayerRoutes(app, pool, { enrichKeys, sendDbError }) {
  // ─── Full profile ───────────────────────────────────────────────────────
  //
  // GET /api/player/:name → summary, per-day games and level, weekday and
  // hour activity, modes, top maps, frequent co-players and teammates, and
  // the most recent replays (same shape as search results).
  app.get("/api/player/:name", async (req, res) => {
    const name = validPlayerName(req.params.name);
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
        recent,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error("GET /api/player/:name failed:", err);
      return sendDbError(res, err, "We couldn't load that player. Please try again.");
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
