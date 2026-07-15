// scripts/recheck-text-filter.js
//
// Re-runs the OCR text-in-logo filter (scripts/lib/ocr-filter.js) against
// EVERY logo already in public/data/catalog.json, regardless of league.
//
// build-catalog.js only OCR-filters entries scraped in that run — leagues
// already in the catalog are left untouched, so if the filter's rules
// change (stricter matching, better preprocessing, etc.) after a league was
// scraped, that league's logos never get re-checked. This script closes
// that gap without needing to re-scrape anything from sportslogos.net —
// it just re-fetches each already-known image and re-runs OCR on it.
//
// Only OCR is the slow part here (no Playwright/page navigation), but a
// 700+ team catalog is still thousands of images — run this in league-sized
// chunks via RECHECK_LEAGUES if a single pass is too slow for one sitting.
//
// USAGE:
//   node scripts/recheck-text-filter.js
//   RECHECK_LEAGUES=NFL,NHL,NBA,MLB node scripts/recheck-text-filter.js
//   RECHECK_LEAGUES=NCAA RECHECK_OFFSET=0 RECHECK_LIMIT=130 node scripts/recheck-text-filter.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { filterTextLogos } from './lib/ocr-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '..', 'public', 'data', 'catalog.json');

async function run() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

  const leagueFilter = process.env.RECHECK_LEAGUES
    ? new Set(process.env.RECHECK_LEAGUES.split(',').map((s) => s.trim()))
    : null;
  const offset = process.env.RECHECK_OFFSET ? parseInt(process.env.RECHECK_OFFSET, 10) : 0;
  const limit = process.env.RECHECK_LIMIT ? parseInt(process.env.RECHECK_LIMIT, 10) : Infinity;

  const matching = leagueFilter ? catalog.filter((t) => leagueFilter.has(t.league)) : catalog;
  const untouchedByLeague = leagueFilter ? catalog.filter((t) => !leagueFilter.has(t.league)) : [];

  // Slice within the league-matched set (sorted by id for a stable, repeatable
  // order across separate offset/limit runs) — lets a huge league like NCAA
  // get rechecked in several bounded chunks instead of one long run.
  const sorted = [...matching].sort((a, b) => a.id.localeCompare(b.id));
  const toRecheck = sorted.slice(offset, offset + limit);
  const skippedInLeague = [...sorted.slice(0, offset), ...sorted.slice(offset + limit)];
  const untouched = [...untouchedByLeague, ...skippedInLeague];

  console.log(`Rechecking ${toRecheck.length} teams${leagueFilter ? ` (${[...leagueFilter].join(', ')})` : ' (entire catalog)'}${offset || limit !== Infinity ? ` [offset ${offset}, limit ${limit}]` : ''}...`);

  const rechecked = await filterTextLogos(toRecheck);
  const merged = new Map([...untouched, ...rechecked].map((t) => [t.id, t]));
  const finalCatalog = [...merged.values()];

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(finalCatalog, null, 2));
  console.log(`\nWrote ${finalCatalog.length} teams total to ${CATALOG_PATH}`);
}

run();
