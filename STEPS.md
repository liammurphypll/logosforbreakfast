# Logos for Breakfast — step by step to production

Companion to HANDOFF.md. That doc is the *spec*; this is the *runbook*.
**Updated** — Phases 0–3 are now mostly done (real Vite+React app,
Supabase wired in, Profile screen built). Picking up from Phase 1.5.

## Current file structure

```
logos-for-breakfast/
  HANDOFF.md          — spec: schemas, tier rules, known gaps
  STEPS.md            — this file
  package.json         — Vite + React + Supabase + lucide-react + Playwright (dev)
  vite.config.js
  index.html
  .env.example         — copy to .env, fill in Supabase credentials
  .gitignore
  src/
    main.jsx            — React entry point
    LogoDaily.jsx        — the real app (ported from the artifact, Supabase-backed)
    supabaseClient.js    — Supabase client setup
  supabase/
    schema.sql           — run once in Supabase's SQL editor
  scripts/
    build-catalog.js     — scraper skeleton (selectors still placeholder)
    pick-daily.js         — daily tier picker (complete, untested against real data)
  data/                  — empty, gets populated by the scripts above
  app/
    logo-daily.jsx        — OLD artifact-only version, kept for reference only.
                             Not used anywhere. Safe to delete once you've
                             confirmed src/LogoDaily.jsx is working.
```

---

## Phase 0 — Repo setup ✅ done

Project structure above is built. To pick this up:
1. Create a GitHub repo (e.g. `logos-for-breakfast`).
2. Copy everything above into it (skip `app/` if you don't want the old
   reference file, skip `node_modules/` and `data/*.json` if any exist).
3. `git init`, first commit.

---

## Phase 1 — Scaffold a real, buildable app ✅ mostly done

**Decided:** Vite + React (not vanilla HTML/JS).

`src/LogoDaily.jsx` is the ported, Supabase-backed version of the game —
same UI, same scoring rules, same 10-round/5-difficulty/leaderboard
logic as the artifact, but every `window.storage` call has been
replaced with real Supabase queries (leaderboard) and `localStorage`
(remembering your own name on this device — that's fine now since this
is a real browser context, not a Claude artifact sandbox).

**⚠️ Not yet build-verified.** I syntax-checked every file with esbuild
(zero errors — catches broken JSX/imports/braces), but I could not run
a real `npm install` + `npm run dev` in this sandbox (hit a hard
~60-second command timeout that full dependency resolution exceeds, plus
some sandbox filesystem flakiness on the last attempt). **This is your
actual first step in Claude Code:**

1. `npm install` (no timeout constraints there — should just work).
2. `npm run dev`.
3. Confirm the UI renders and plays exactly like the artifact did —
   this is your regression baseline before touching anything else.
4. If anything errors, that's the first real bug hunt — likely
   candidates: a prop name typo, or a leftover reference I missed when
   porting. Nothing structural should be wrong given the syntax checks
   passed clean, but "syntax-valid" isn't the same as "runs correctly."

---

## Phase 2 — Leaderboard backend: Supabase ✅ schema written, not yet provisioned

**Decided:** Supabase over a custom Express+Postgres API — less total
setup.

1. Create a free Supabase project at supabase.com.
2. Open the SQL Editor, paste in `supabase/schema.sql`, run it. This
   creates `leaderboard_entries` with the right columns/indexes and
   permissive RLS policies (public read, public insert — matches the
   current no-login design).
3. Project Settings → API — copy your Project URL and `anon` public key.
4. `cp .env.example .env`, fill in those two values.

---

## Phase 3 — Wire the app to Supabase ✅ done in code, needs live testing

Already implemented in `src/LogoDaily.jsx`:
- `savePlayerResult()` / `loadPlayerRecord()` / `loadLeaderboard()` all
  hit the real `leaderboard_entries` table now.
- Player name remembering uses `localStorage` instead of artifact
  storage.
- **New: Profile screen.** All-time points, days played, a real
  *day-streak* (consecutive calendar days played — separate from the
  in-round puzzle streak), a "best category" callout, and a per-
  difficulty breakdown table. Accessible from the start screen (next to
  Leaderboard) and from the puzzle-complete screen. Reuses the player
  record that was already being fetched for the play-once-per-day
  check, so it's not an extra network round trip.

**Next, once Phase 1's `npm run dev` is working:**
1. Play a round, confirm it writes a real row to `leaderboard_entries`
   in the Supabase table editor.
2. Reload the page, confirm the leaderboard and profile screens both
   reflect it.
3. Try the same name from a second browser/incognito window — confirm
   the duplicate-name check and the "already played this tier today"
   check both work against real shared data, not just local state.
4. Commit.

---

## Phase 4 — Build the real scraper (not started)

Follow the build order in `HANDOFF.md`:

1. In Claude Code, open a handful of sportslogos.net team pages across
   different sports (NFL, NBA, NCAA, EPL) and inspect the actual DOM —
   note exact section header wording, image URL patterns, and how
   team/nickname actually appears on the page.
2. Solve the team/nickname split problem first (see HANDOFF.md gap #2)
   — this is the riskiest part. Multi-word nicknames (Maple Leafs, Red
   Sox) and multi-word cities (Kansas City, New Orleans) will break a
   naive split.
3. Fill in real selectors in `scripts/build-catalog.js`, replacing the
   `getTeamLinksForLeague` and `scrapeTeamPage` placeholders.
4. Run it against **just NFL first**, manually check the output against
   real pages before expanding to more leagues.
5. Expand `LEAGUES_TO_SCRAPE` incrementally, re-checking each time.
6. Commit `catalog.json`.

---

## Phase 5 — Test the daily picker (not started, script is ready)

`scripts/pick-daily.js` is fully written and should work as-is once a
real `catalog.json` exists.

1. Run it against the real catalog.
2. Confirm `data/daily-puzzle-{date}.json` has all 5 tiers × 10 teams,
   no team repeated across tiers same day, image URLs resolve.
3. Run it again on a faked next day, confirm the 14-day cooldown
   excludes yesterday's teams.
4. Commit.

---

## Phase 6 — Wire the game to real daily data (not started)

1. Replace the mock `ROUNDS` constant in `src/LogoDaily.jsx` with a
   fetch of today's `daily-puzzle-{date}.json`, filtered to the
   selected difficulty tier.
2. Replace the `<Crest/>` placeholder with a real `<img
   src={round.logo.url} />`, keeping the same square-frame styling.
3. Play through all 5 tiers locally, confirm everything still works.
4. Commit.

---

## Phase 7 — Automate the daily pick (not started)

1. `.github/workflows/daily-pick.yml` — cron-scheduled Action that runs
   `node scripts/pick-daily.js` and commits the result.
2. That commit triggers your existing Render auto-deploy — no separate
   deploy step needed.
3. Test with a manual `workflow_dispatch` run before trusting the
   schedule.

---

## Phase 8 — Deploy (not started)

1. Push to `main`.
2. Connect the repo to Render as you have with other projects.
3. Add the Supabase env vars (`VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`) in Render's environment settings — `.env`
   itself is gitignored, so these need to be set there directly.
4. Confirm the live URL loads, plays a full round, leaderboard and
   profile both update against the real Supabase table.

---

## Phase 9 — Ongoing

- Re-run `build-catalog.js` occasionally to pick up new logo redesigns
  or newly added teams.
- Watch the first week of real `pick-daily.js` output for repeats or
  league imbalance — the round-robin spread is soft, not hard-capped
  (HANDOFF.md gap #4).
- Keep an eye on the Supabase free tier's row/bandwidth limits if this
  gets real usage beyond your team.
