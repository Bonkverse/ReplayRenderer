# replay-renderer

Deterministic bonk.io replay renderer. One decode→sim→draw spine, two outputs:

- **Trail thumbnails** for the search grid (cheap, no WebGL, runs in a Web Worker).
- **Live interactive playback** for the detail page (real PIXI `CanvasHandler` + scrubber).

Both re-simulate the replay with bonk's **real** `Physics`, so nothing is reimplemented
and replays never desync. No video is ever stored — the gzipped-PSON blob is the source
of truth and renders on demand.

## Tree

```
replay-renderer/
├── core/                  SHARED, environment-agnostic (pure — no Node/DOM imports)
│   ├── decode.js          input unpacker (halfUnserialize port) + normalize
│   ├── inputs.js          O(1) forward resolver + O(log) scrub
│   ├── sim.js             deterministic driver around the real Physics
│   ├── trail.js           Canvas2D trail thumbnail (OffscreenCanvas + node-canvas)
│   └── physics-loader.js  loads vendor/bonk-core.mjs (browser + headless paths)
│
├── browser/               FRONTEND (Vite)
│   ├── thumb.worker.js     grid thumbnails off-thread + IndexedDB cache
│   ├── thumbClient.js      singleton worker + promise API
│   ├── ReplayGrid.jsx      lazy IntersectionObserver thumbnails
│   └── ReplayPlayer.jsx    live player on CanvasHandler + scrubber
│
├── server/                NODE (build steps + dev harness)
│   ├── build-core.mjs      alpha2s.js  -> vendor/bonk-core.mjs
│   ├── wrap-box2d.mjs       Box2DModuleGJMod.js -> vendor/box2d.esm.js
│   ├── load-box2d.mjs       (fallback AMD loader for Node)
│   ├── dump-one.mjs         pull one raw blob from Postgres -> one.bin
│   ├── render-one.mjs       one real replay -> real Physics -> PNG  (the proof)
│   └── demo-thumb.mjs        visual demo (stand-in physics, no box2d) -> PNG
│
├── vendor/                BONK'S CODE — gitignored, you supply (see vendor/README.md)
│   ├── alpha2s.js · Box2DModuleGJMod.js     (inputs you provide)
│   └── bonk-core.mjs · box2d.esm.js         (generated)
│
├── package.json
├── README.md
└── SETUP.md               ← start here
```

## Where this goes in your repos

- **core/ + browser/** → Bonkverse frontend (Vite), under `src/replay/`.
- **core/ + server/** → the scraper repo (next to `db.js` / `codec.js`), for the
  build steps, the dev harness, and the future server-side thumbnail worker.

`core/` is needed in both — share it via a workspace package or just duplicate the four
small files for now. See **SETUP.md** for the step-by-step.

## Player API

Profiles for any registered bonk.io player, built from the replay archive.
Bonkverse reads these over HTTP (the replay DB and the Bonkverse DB are
separate). Guests never get a profile: their names aren't unique.

- `GET /api/player/:name` → `summary` (games, current/peak level, first and
  last replay, active days), `days` (games and highest level per day),
  `weekdays`, `hours` (UTC), `live_hours` (replays per UTC hour, for the
  viewer's own time zone), `sessions` (live replays under 30 minutes apart),
  `level_ups` (each new highest level, with replays since the last one),
  `rooms` (1v1 / free-for-all / teams / solo, quick play, typical room size,
  maps played), `modes`, top 20 `maps` (with last day and room split),
  `played_with`, `teammates` and `rivals` (registered players only), and the
  six most `recent` replays, and their latest `skin` (see below). Hours and
  sessions only use live-collected replays. 404 when the name has no
  registered replays. Cached for 5 minutes.
- `GET /api/player/:name/map/:mapid` → that player on one map: games, first
  and last day, room and mode split, and who they play it with.
- `GET /api/levels/distribution` → `levels` as `[level, players]` pairs:
  how many registered players have each level as their highest seen in
  replays, plus the total. Recomputed at most every 6 hours (it reads the
  whole participants table).
- `GET /api/players/lookup?names=a&names=b` → for up to 60 exact registered
  names: games, level in their latest replay, peak level, that replay
  (`last: {cycle, id}`), and when it was seen (`seen_at` exact for
  live-collected replays, else null; `seen_day` always; `seen_estimated`
  when the day comes from cycle estimates), and their latest `skin`. Names
  with no replays are left out. Used by Bonkverse's player search cards and
  its public API.
- `GET /api/players?q=abc` → up to 10 registered names starting with `q`
  (3+ characters), most-played first.

`skin` is the skin in the player's newest replay that recorded one
(`server/skins.mjs`, from ReplayFetcher's `avatars` table and
`replay_participants.avatar_hash`), or `null`:
`{ hash, avatar: { layers, bc }, seen_at, seen_day, seen_estimated, replay: { cycle, id } }`.
`avatar` is the form `public/skin-render.js` draws; `seen_*` mean the same as
in the lookup. Guests' skins are never returned.

The private `GET /api/internal/replay-names` (Bonkverse's sync, token
required) also gives each name its latest `skin` hash in the batch and
`skin_seen_at` (collection time, or the estimated day at 00:00 UTC), with an
`avatars` map sending each skin's `{ layers, bc }` once per batch.

No win rate: a stored replay is the end of one round and doesn't say who won.
