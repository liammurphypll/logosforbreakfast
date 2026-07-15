// scripts/pick-daily.js
//
// Run daily via cron / GitHub Action. Reads public/data/catalog.json (built
// by build-catalog.js) and public/data/used-log.json (rolling history), and
// writes public/data/daily-puzzle-{date}.json with all 5 difficulty tiers
// for the day. Lives under public/ so Vite serves it statically and the
// game can fetch(`/data/daily-puzzle-${today}.json`) at runtime.
//
// USAGE:
//   node scripts/pick-daily.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const COOLDOWN_DAYS = 14;
const DAILY_COUNT = 10; // matches ROUNDS.length in the game

// logoTypes: null = any type in the catalog; otherwise a whitelist of
// catalog `logo.type` values ('primary' or 'secondary' — note the scraper
// already folds sportslogos.net's "Alternate" sections into 'secondary',
// so 'secondary' here covers both secondary AND alternate marks).
//
// EPL is deliberately absent: sportslogos.net doesn't have an English
// Premier League section under any name (checked their league-ID range,
// Soccer sport-category index, and site search) — English clubs simply
// aren't cataloged there, so it can't be scraped from this data source.
const TIERS = {
  EASY:   { leagues: ['NFL', 'NBA', 'MLB', 'NHL'], logoTypes: ['primary'] },
  MEDIUM: { leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA'], logoTypes: null },
  HARD:   { leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'Bundesliga', 'Serie A', 'La Liga', 'WNBA', 'PWHL'], logoTypes: null },
  EXPERT: { leagues: ['NFL', 'NBA', 'MLB', 'NHL', 'NCAA', 'Bundesliga', 'Serie A', 'La Liga', 'WNBA', 'PWHL', 'AHL', 'International League', 'Pacific Coast League', 'KHL', 'ECHL', 'SPHL', 'CFL'], logoTypes: ['secondary'] },
  SICKO:  { leagues: null, logoTypes: ['secondary'] }, // null = every league in the catalog
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

function logoPoolFor(team, logoTypes) {
  return logoTypes ? team.logos.filter((l) => logoTypes.includes(l.type)) : team.logos;
}

function pickLogoForTeam(team, logoTypes) {
  const pool = logoPoolFor(team, logoTypes);
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickTier(catalog, cooldownIds, excludeIds, tierConfig) {
  // A team is only eligible if it actually has a logo matching this tier's
  // required type(s) — e.g. a team with zero secondary/alternate logos on
  // file can't be picked for EXPERT/SICKO, rather than silently falling
  // back to showing its primary logo there.
  const hasEligibleLogo = (t) => logoPoolFor(t, tierConfig.logoTypes).length > 0;

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

function run() {
  const catalog = loadJSON(path.join(DATA_DIR, 'catalog.json'), []);
  const usedLog = loadJSON(path.join(DATA_DIR, 'used-log.json'), []);
  const today = new Date().toISOString().slice(0, 10);

  if (catalog.length === 0) {
    console.error('catalog.json is empty — run build-catalog.js first.');
    process.exit(1);
  }

  const cooldownIds = new Set(
    usedLog.filter((e) => daysAgo(e.date) < COOLDOWN_DAYS).map((e) => e.teamId)
  );

  const excludeIds = new Set(); // teams already used by an earlier tier today
  const output = { date: today };

  for (const tierName of TIER_ORDER) {
    const teams = pickTier(catalog, cooldownIds, excludeIds, TIERS[tierName]);
    teams.forEach((t) => excludeIds.add(t.id));

    output[tierName] = teams.map((team) => {
      const logo = pickLogoForTeam(team, TIERS[tierName].logoTypes);
      return {
        id: team.id,
        team: team.team,
        nickname: team.nickname,
        league: team.league,
        logo, // { url, type, era }
      };
    });
  }

  fs.writeFileSync(path.join(DATA_DIR, `daily-puzzle-${today}.json`), JSON.stringify(output, null, 2));

  const newLog = [
    ...usedLog.filter((e) => daysAgo(e.date) < COOLDOWN_DAYS * 3),
    ...[...excludeIds].map((teamId) => ({ teamId, date: today })),
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'used-log.json'), JSON.stringify(newLog, null, 2));

  console.log(`Picked 5 tiers × ${DAILY_COUNT} for ${today}`);
}

run();
