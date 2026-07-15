// scripts/pick-daily.js
//
// Run daily via cron / GitHub Action (see .github/workflows/daily-puzzle.yml).
// Reads public/data/catalog.json (built by build-catalog.js, committed to
// git — a big mostly-static reference dataset, fine as a static asset) and
// the team_usage_log table in Supabase (rolling 14-day cooldown history),
// and upserts today's 5 difficulty tiers into the daily_puzzles table.
//
// Puzzles live in Supabase rather than a static public/data/daily-puzzle-
// {date}.json file because that file is gitignored (regenerated daily, not
// source) — a real deploy (Render, etc.) builds straight from git and would
// never actually have it. Supabase is a live source the deployed frontend
// can fetch from directly, independent of any build/deploy cycle.
//
// USAGE:
//   node scripts/pick-daily.js
//
// Needs VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in the environment —
// loaded from .env for local runs; set as real environment variables in
// CI/CD (GitHub Actions secrets, Render env vars, etc.).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

try { process.loadEnvFile(); } catch { /* no .env file — env vars are already set (CI/Render) */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '..', 'public', 'data', 'catalog.json');
const COOLDOWN_DAYS = 14;
const DAILY_COUNT = 10; // matches ROUNDS.length in the game

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

// Parses "1931 - 1937" / "2014 - Pres" / "1960 - 1960" into the year the
// logo went OUT of use (Infinity for "Pres", i.e. still current).
function eraEndYear(era) {
  const m = era.match(/(\d{4})\s*-\s*(\d{4}|Pres)/i);
  if (!m) return null;
  return /pres/i.test(m[2]) ? Infinity : parseInt(m[2], 10);
}

const BIG_FOUR = ['NFL', 'NBA', 'MLB', 'NHL'];

// logoTypes: null = any type in the catalog; otherwise a whitelist of
// catalog `logo.type` values ('primary' or 'secondary' — note the scraper
// already folds sportslogos.net's "Alternate" sections into 'secondary',
// so 'secondary' here covers both secondary AND alternate marks).
//
// eraFilter(logo, league): optional extra gate a logo must pass for this
// tier, beyond logoTypes/leagues. null = no extra restriction.
//   - EASY/MEDIUM: only logos still in use at some point from 1995 on —
//     keeps these tiers to recognizable modern logos, not vintage ones.
//   - HARD/EXPERT: no era restriction, any year is fair game.
//   - SICKO: the 4 major US leagues are blocked entirely UNLESS the logo
//     retired before 1965 — a vintage/obscure mark from those leagues is
//     fair game for the hardest tier, but a recognizable modern NFL/NBA/
//     MLB/NHL logo is not. Every other league is unrestricted by era.
//
// EPL is deliberately absent: sportslogos.net doesn't have an English
// Premier League section under any name (checked their league-ID range,
// Soccer sport-category index, and site search) — English clubs simply
// aren't cataloged there, so it can't be scraped from this data source.
const TIERS = {
  EASY: {
    leagues: ['NFL', 'NBA', 'MLB', 'NHL'],
    logoTypes: ['primary'],
    eraFilter: (logo) => eraEndYear(logo.era) >= 1995,
  },
  MEDIUM: {
    leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA'],
    logoTypes: null,
    eraFilter: (logo) => eraEndYear(logo.era) >= 1995,
  },
  HARD: {
    leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'Bundesliga', 'Serie A', 'La Liga', 'WNBA', 'PWHL'],
    logoTypes: null,
    eraFilter: null,
  },
  EXPERT: {
    leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'Bundesliga', 'Serie A', 'La Liga', 'WNBA', 'PWHL', 'AHL', 'International League', 'Pacific Coast League', 'KHL', 'ECHL', 'SPHL', 'CFL'],
    logoTypes: ['secondary'],
    eraFilter: null,
  },
  SICKO: {
    leagues: null, // every league in the catalog
    logoTypes: ['secondary'],
    eraFilter: (logo, league) => !BIG_FOUR.includes(league) || eraEndYear(logo.era) < 1965,
  },
};
const TIER_ORDER = ['EASY', 'MEDIUM', 'HARD', 'EXPERT', 'SICKO'];

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function daysAgo(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

function logoPoolFor(team, tierConfig) {
  let pool = tierConfig.logoTypes ? team.logos.filter((l) => tierConfig.logoTypes.includes(l.type)) : team.logos;
  if (tierConfig.eraFilter) pool = pool.filter((l) => tierConfig.eraFilter(l, team.league));
  return pool;
}

function pickLogoForTeam(team, tierConfig) {
  const pool = logoPoolFor(team, tierConfig);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickTier(catalog, cooldownIds, excludeIds, tierConfig) {
  // A team is only eligible if it actually has a logo matching this tier's
  // required type(s)/era — e.g. a team with zero secondary/alternate logos
  // on file can't be picked for EXPERT/SICKO, rather than silently falling
  // back to showing its primary logo there.
  const hasEligibleLogo = (t) => logoPoolFor(t, tierConfig).length > 0;

  let eligible = catalog.filter((t) =>
    !cooldownIds.has(t.id) &&
    !excludeIds.has(t.id) &&
    (tierConfig.leagues === null || tierConfig.leagues.includes(t.league)) &&
    hasEligibleLogo(t)
  );

  if (eligible.length < DAILY_COUNT) {
    eligible = catalog.filter((t) =>
      !excludeIds.has(t.id) &&
      (tierConfig.leagues === null || tierConfig.leagues.includes(t.league)) &&
      hasEligibleLogo(t)
    );
    console.warn(`[pick-daily] cooldown relaxed for a tier — pool was under ${DAILY_COUNT}`);
  }

  const byLeague = {};
  for (const team of eligible) (byLeague[team.league] ??= []).push(team);
  const leagues = shuffle(Object.keys(byLeague));
  for (const lg of leagues) byLeague[lg] = shuffle(byLeague[lg]);

  const picks = [];
  let round = 0;
  while (picks.length < DAILY_COUNT) {
    let addedThisRound = false;
    for (const lg of leagues) {
      if (picks.length >= DAILY_COUNT) break;
      if (byLeague[lg][round]) {
        picks.push(byLeague[lg][round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break;
    round++;
  }

  return shuffle(picks);
}

async function run() {
  const catalog = loadJSON(CATALOG_PATH, []);
  const today = new Date().toISOString().slice(0, 10);

  if (catalog.length === 0) {
    console.error('catalog.json is empty — run build-catalog.js first.');
    process.exit(1);
  }

  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString().slice(0, 10);
  const { data: usageRows, error: usageError } = await supabase
    .from('team_usage_log')
    .select('team_id, used_date')
    .gte('used_date', cooldownCutoff);
  if (usageError) {
    console.error('Failed to read team_usage_log:', usageError.message);
    process.exit(1);
  }

  const cooldownIds = new Set(usageRows.map((r) => r.team_id));
  const excludeIds = new Set(); // teams already used by an earlier tier today
  const output = { date: today };

  for (const tierName of TIER_ORDER) {
    const teams = pickTier(catalog, cooldownIds, excludeIds, TIERS[tierName]);
    teams.forEach((t) => excludeIds.add(t.id));

    output[tierName] = teams.map((team) => {
      const logo = pickLogoForTeam(team, TIERS[tierName]);
      return {
        id: team.id,
        team: team.team,
        nickname: team.nickname,
        league: team.league,
        logo, // { url, type, era }
      };
    });
  }

  const { error: upsertError } = await supabase
    .from('daily_puzzles')
    .upsert({ play_date: today, data: output }, { onConflict: 'play_date' });
  if (upsertError) {
    console.error('Failed to upsert daily_puzzles:', upsertError.message);
    process.exit(1);
  }

  const { error: insertError } = await supabase
    .from('team_usage_log')
    .insert([...excludeIds].map((teamId) => ({ team_id: teamId, used_date: today })));
  if (insertError) {
    console.error('Failed to insert team_usage_log:', insertError.message);
    process.exit(1);
  }

  // Keep the log bounded, mirroring the old used-log.json trimming — prune
  // anything older than the window pick-daily actually consults (with a
  // margin), rather than growing this table forever.
  const pruneCutoff = new Date(Date.now() - COOLDOWN_DAYS * 3 * 86400000).toISOString().slice(0, 10);
  const { error: pruneError } = await supabase
    .from('team_usage_log')
    .delete()
    .lt('used_date', pruneCutoff);
  if (pruneError) {
    console.warn('Failed to prune old team_usage_log rows (non-fatal):', pruneError.message);
  }

  console.log(`Picked 5 tiers × ${DAILY_COUNT} for ${today}`);
}

run();
