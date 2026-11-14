// server/skins.mjs
//
// The skin each registered player wore most recently, from the replay
// archive. ReplayFetcher stores every distinct skin once in `avatars`
// (hash → { layers, bc }, the form public/skin-render.js draws) and points
// each replay_participants row at the one worn (avatar_hash). A player's
// latest skin is the avatar_hash of their newest row that has one.
//
// Guests are left out like everywhere else in the player API: their names
// aren't identities, so a guest's skin is never anyone's skin.
//
// Each skin comes with when it was seen, in the same shape as the player
// lookup's level: seen_at is the exact collection time for live-collected
// replays (null otherwise), seen_day is always set, seen_estimated marks
// days from replay_cycle_days.

// One index walk per name (idx_rpart_lower_username, newest first), stopping
// at the first row with a skin: cheap even for players with thousands of
// replays.
const LATEST_SKINS_SQL = `
  SELECT n.k, a.hash, a.avatar, s.cycle, s.replay_id::text AS replay_id,
         CASE WHEN rcd.day IS NULL THEN r.fetched_at END AS seen_at,
         to_char(COALESCE(rcd.day, (r.fetched_at AT TIME ZONE 'UTC')::date), 'YYYY-MM-DD') AS seen_day,
         rcd.day IS NOT NULL AS seen_estimated
  FROM unnest($1::text[]) AS n(k)
  CROSS JOIN LATERAL (
    SELECT rp.cycle, rp.replay_id, rp.avatar_hash
    FROM replay_participants rp
    WHERE lower(rp.username) = n.k AND NOT rp.guest AND rp.avatar_hash IS NOT NULL
    ORDER BY rp.cycle DESC, rp.replay_id DESC
    LIMIT 1
  ) s
  JOIN avatars a ON a.hash = s.avatar_hash
  JOIN replays r ON r.cycle = s.cycle AND r.id = s.replay_id
  LEFT JOIN replay_cycle_days rcd
    ON rcd.cycle = s.cycle AND s.replay_id BETWEEN rcd.first_id AND rcd.last_id
`;

/**
 * Latest skin for each of `names` (matched ignoring case).
 *
 * @param {import("pg").Pool} pool
 * @param {string[]} names
 * @returns {Promise<Map<string, {hash, avatar, seen_at, seen_day, seen_estimated, replay}>>}
 *   keyed by lower-case name; names with no skin are missing.
 */
export async function latestSkins(pool, names) {
  const keys = [...new Set(names.map((n) => n.toLowerCase()))];
  if (keys.length === 0) return new Map();
  const { rows } = await pool.query(LATEST_SKINS_SQL, [keys]);
  return new Map(
    rows.map((r) => [
      r.k,
      {
        hash: r.hash,
        avatar: r.avatar,
        seen_at: r.seen_at,
        seen_day: r.seen_day,
        seen_estimated: r.seen_estimated,
        replay: { cycle: r.cycle, id: r.replay_id },
      },
    ])
  );
}
