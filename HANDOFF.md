# Logos for Breakfast — handoff to Claude Code

Daily sports-logo guessing game. Frontend is built and working with mock
data; this doc covers what's left to make it real.

## What's already built (don't rebuild this)

`app/logo-daily.jsx` — the full game UI: start screen with name entry +
difficulty picker, gameplay (typeahead fields, 3-miss round limit, streak/
multiplier scoring, first-try + clean-sheet bonuses), completion screen
with rank + share, and a working shared leaderboard scoped per difficulty
tier. Currently runs on a 10-team mock `ROUNDS` array at the top of the
file. **Game logic, scoring rules, and UI are final — the only thing
that needs to change in this file is swapping mock data for real data.**

## What Claude Code needs to build

1. **`scripts/build-catalog.js`** — scrapes sportslogos.net into
   `data/catalog.json`. Skeleton is here with the section-exclusion
   filter wired in, but the actual Playwright selectors are placeholders
   — needs live inspection of the site (this chat's sandbox can't reach
   sportslogos.net, only Claude Code's environment can).
2. **`scripts/pick-daily.js`** — fully written, should work as-is once
   `catalog.json` exists. Samples 5 difficulty tiers × 10 teams/day with
   league-spread + cooldown logic, writes `data/daily-puzzle-{date}.json`.
3. **Wiring** — replace the mock `ROUNDS` array in the game with a fetch
   of today's puzzle for the selected difficulty tier, and swap the
   `<Crest/>` placeholder component for a real `<img src={round.logo.url}/>`.

## Data schemas

**catalog.json** (one entry per team, all logo eras in one array):
```json
{
  "id": "arkansas-razorbacks",
  "team": "Arkansas",
  "nickname": "Razorbacks",
  "league": "NCAA",
  "logos": [
    { "url": ".../1931.png", "type": "primary", "era": "1931-1937" },
    { "url": ".../2014.png", "type": "primary", "era": "2014-Pres" },
    { "url": ".../secondary-A.png", "type": "secondary", "era": "1932-2014" }
  ]
}
```

**daily-puzzle-{date}.json** (what the game actually consumes):
```json
{
  "date": "2026-07-15",
  "EASY":   [ { "id": "...", "team": "...", "nickname": "...", "league": "...", "logo": { "url": "...", "type": "primary", "era": "..." } }, /* ×10 */ ],
  "MEDIUM": [ /* ×10 */ ],
  "HARD":   [ /* ×10 */ ],
  "EXPERT": [ /* ×10 */ ],
  "SICKO":  [ /* ×10 */ ]
}
```
This maps directly onto the game's `ROUNDS` shape — `team`/`nickname`/
`league` are the answer fields, `logo.url` replaces the placeholder
crest image.

## Rules to preserve when scraping

- **Excluded logo sections** (never scrape these — see keyword list in
  `build-catalog.js`): Uniform, Helmet, Misc/Miscellaneous, Anniversary,
  Event Logo, Playoffs, Championship, Stadium. Only Primary + Secondary
  logo history sections count.
- **Difficulty tiers** (defined in `pick-daily.js`):
  - EASY — NFL/NBA/MLB/NHL, primary logos only
  - MEDIUM — + NCAA, all logo types
  - HARD — + EPL/Bundesliga/Serie A/La Liga/WNBA/PWHL, all logo types
  - EXPERT — + AHL/International League/Pacific Coast League/KHL/ECHL/SPHL/CFL,
    secondary/alternate logos only (never primary)
  - SICKO — any league in the catalog, secondary/alternate logos only
    (never primary)
  - A team is only eligible for EXPERT/SICKO if it actually has a
    secondary/alternate logo on file — no silent fallback to primary.
  - Tier names are shown to players unlabeled — never surface which
    leagues are in a tier in the UI.
- **No repeats within a day** — a team picked for EASY won't also show
  up in MEDIUM/HARD/EXPERT/SICKO that same day (handled in `pick-daily.js`
  via the `excludeIds` set).
- **14-day cooldown** — a team won't repeat across days within that
  window, with a fallback that relaxes cooldown (oldest-used-first)
  if a tier's pool gets too thin to hit 10 picks.

## Known gaps / things to verify before this is production-ready

1. **Section header wording varies by sport.** Some pages may use
   "Alternate" instead of "Secondary," or split out "Helmet History" as
   its own section on football pages but not elsewhere. Before running
   the full catalog build, scrape a handful of pages across different
   sports and log every unique section title encountered, then confirm
   the exclusion keyword list actually catches everything intended.
2. **Team vs. nickname splitting is a real problem.** The skeleton's
   `teamName.split(' ')` last-word heuristic will break on multi-word
   nicknames (Maple Leafs, Red Sox, Blue Jackets) and multi-word cities
   (Kansas City, New Orleans, Golden State). This likely needs either a
   hardcoded per-team override list, or scraping team/nickname from a
   more structured source on the page (breadcrumbs, page metadata) rather
   than parsing the H1.
3. **League label strings may not match sportslogos.net's own taxonomy**,
   especially AHL, International League, and Pacific Coast League (old
   defunct AAA baseball leagues) — confirm exact naming during the first
   scrape run.
4. **League-spread in the picker is soft, not hard-capped.** Round-robin
   naturally balances leagues, but a league with a much bigger catalog
   footprint will still get picked more often over time. Fine as a
   starting point; flag if it needs a hard per-league cap later.
5. **Leaderboard has no real auth.** It runs on the Claude artifact's
   shared persistent storage (`window.storage`), keyed by a slugified
   player name — good enough for a small internal team test, not a real
   backend. If this becomes a real product, move the leaderboard to an
   actual database.
6. **This chat's sandbox cannot reach sportslogos.net** (network
   allowlist is limited to package registries). All scraping must run
   from Claude Code locally, same pattern as the existing
   laxnumbers.com scraper.

## Suggested build order

1. Open a few sportslogos.net team pages in Claude Code, inspect real DOM
   structure, confirm section titles and image URL patterns.
2. Fill in the real selectors in `build-catalog.js`, solve the
   team/nickname split problem.
3. Run it against 2-3 leagues first (e.g. just NFL) to sanity check
   output shape against the schema above before scraping everything.
4. Run `pick-daily.js` against the small test catalog, confirm the
   output JSON matches what the game expects.
5. Wire the game to fetch `daily-puzzle-{date}.json` instead of using
   `ROUNDS`, swap in real `<img>` logos.
6. Scale the catalog build to all target leagues.
