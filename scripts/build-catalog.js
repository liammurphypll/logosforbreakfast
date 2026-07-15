// scripts/build-catalog.js
//
// Scrapes sportslogos.net team pages into public/data/catalog.json.
// Lives under public/ so Vite serves it statically and the game can
// fetch('/data/catalog.json') at runtime for typeahead options.
// Run this occasionally (not daily) — it's the master pool that
// pick-daily.js samples from. Uses Playwright.
//
// USAGE:
//   node scripts/build-catalog.js
//
// DOM structure (confirmed live against sportslogos.net, July 2026):
// A team's logo page (e.g. /logos/list_by_team/606/Arkansas-Razorbacks-Logos/)
// renders each history section as:
//   <div class="browseHeading"><h3 class="cftr_browseHeading">TEAM Primary Logos History</h3></div>
//   <div class="team-card-list">
//     <div class="team-card"><a href="/logos/view/.../Primary-Logo">
//       <div><img src=".../thumbs/ID.gif" alt="TEAM (1931 - 1937)" title="TEAM Primary Logo (1931 - 1937)"></div>
//     </a></div>
//     ...
//   </div>
// The era range is already in img.alt, e.g. "(1931 - 1937)" or "(2014 - Pres)" —
// no need to parse a separate caption element.
//
// A regular plain-HTTP fetch of this page type was reportedly blocked; a real
// Playwright browser gets a normal 200 with full content, no fallback via
// individual logo pages / Timeline links was needed.

import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'public', 'data', 'catalog.json');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Polite delay between page loads so we don't hammer a small hobby site.
const REQUEST_DELAY_MS = 400;

// League -> team index ("hub") page(s). Every entry here has been verified
// live (team counts matched real league sizes, or in NCAA's case the site's
// own 6-way a-z split). Each value is a list because NCAA's Division I
// index is split across 6 alphabetical sub-pages that all feed one "NCAA"
// league label.
//
// NOTE: English Premier League is NOT on this site under any name — no
// "EPL"/"English Premier League" hub page exists (checked IDs 1-135, the
// Soccer sport-category index, and site search; English clubs aren't even
// in the generic "European Clubs" bucket). It's left out of tier configs
// entirely rather than configured with no backing data.
const LEAGUE_HUB_URLS = {
  NFL: ['https://www.sportslogos.net/teams/list_by_league/7/National-Football-League-Logos/NFL-Logos/'],
  MLB: ['https://www.sportslogos.net/teams/list_by_league/4/Major-League-Baseball-Logos/MLB-Logos/'],
  NHL: ['https://www.sportslogos.net/teams/list_by_league/1/National-Hockey-League-Logos/NHL-Logos/'],
  NBA: ['https://www.sportslogos.net/teams/list_by_league/6/National-Basketball-Association-Logos/NBA-Logos/'],
  WNBA: ['https://www.sportslogos.net/teams/list_by_league/16/Womens-National-Basketball-Association-Logos/WNBA-Logos/'],
  PWHL: ['https://www.sportslogos.net/teams/list_by_league/235/Professional-Womens-Hockey-League-Logos/PWHL-Logos/'],
  KHL: ['https://www.sportslogos.net/teams/list_by_league/90/Kontinental-Hockey-League-Logos/KHL-Logos/'],
  AHL: ['https://www.sportslogos.net/teams/list_by_league/2/American-Hockey-League-Logos/AHL-Logos/'],
  ECHL: ['https://www.sportslogos.net/teams/list_by_league/14/ECHL-Logos/ECHL-Logos/'],
  SPHL: ['https://www.sportslogos.net/teams/list_by_league/107/SPHL-Logos/SPHL-Logos/'],
  CFL: ['https://www.sportslogos.net/teams/list_by_league/8/Canadian-Football-League-Logos/CFL-Logos/'],
  Bundesliga: ['https://www.sportslogos.net/teams/list_by_league/132/German-Bundesliga-Logos/German-Liga-Logos/'],
  'Serie A': ['https://www.sportslogos.net/teams/list_by_league/128/Italian-Serie-A-Logos/Italian-Serie-A-Logos/'],
  'La Liga': ['https://www.sportslogos.net/teams/list_by_league/130/Spanish-La-Liga-Logos/Spanish-La-Liga-Logos/'],
  'International League': ['https://www.sportslogos.net/teams/list_by_league/36/International-League-AAA-Logos/IL-Logos/'],
  'Pacific Coast League': ['https://www.sportslogos.net/teams/list_by_league/37/Pacific-Coast-League-AAA-Logos/PCL-Logos/'],
  // NCAA hub pages are scraped in 2-page batches (see LEAGUES_TO_SCRAPE
  // comment below) — temporarily comment out all but the current batch's
  // pages, since Playwright nav + OCR over ~380 teams total is too long for
  // a single run. Upsert-by-id merging means partial batches accumulate
  // safely across runs, in any order.
  NCAA: [
    'https://www.sportslogos.net/teams/list_by_league/30/NCAA-a-c-Logos/NCAA-a-c-Logos/',
    'https://www.sportslogos.net/teams/list_by_league/31/NCAA-d-h-Logos/NCAA-d-h-Logos/',
    'https://www.sportslogos.net/teams/list_by_league/32/NCAA-i-m-Logos/NCAA-i-m-Logos/',
    'https://www.sportslogos.net/teams/list_by_league/33/NCAA-n-r-Logos/NCAA-n-r-Logos/',
    'https://www.sportslogos.net/teams/list_by_league/34/NCAA-s-t-Logos/NCAA-s-t-Logos/',
    'https://www.sportslogos.net/teams/list_by_league/35/NCAA-u-z-Logos/NCAA-u-z-Logos/',
  ],
};

// Leagues to scrape THIS run. Re-running a league here replaces its slice
// of the existing catalog rather than duplicating it; leagues already in
// catalog.json but not listed here are left untouched (and not re-OCR'd —
// that's the expensive part, so this lets big rebuilds happen in batches
// across multiple runs instead of one very long one).
// Full list of every league with a verified hub URL above. All of these
// have already been scraped at least once (see HANDOFF.md) — re-running
// this as-is refreshes everything, but for a first-time run of a large
// league (NCAA in particular) it's safer to comment out its extra hub URLs
// above and scrape it in smaller batches (each run upserts by team id, so
// partial batches accumulate safely across multiple runs).
const LEAGUES_TO_SCRAPE = [
  'NFL', 'NHL', 'NBA', 'MLB', 'WNBA', 'PWHL', 'KHL', 'AHL', 'ECHL', 'SPHL',
  'CFL', 'Bundesliga', 'Serie A', 'La Liga', 'International League',
  'Pacific Coast League', 'NCAA',
];

// Section titles that ARE team-identity logo history, mapped to our type.
// "Alternate" is treated as equivalent to "Secondary": some teams (e.g.
// Green Bay Packers) have no "Secondary Logos History" section at all —
// "Alternate Logos History" is the section that fills that role for them.
// Others (e.g. Arkansas Razorbacks) have both as genuinely separate
// sections; in that case both count as secondary-tier logos.
// Everything else (Player Logo Pages, Gear For Sale, Helmets, Wordmark,
// Uniforms, Anniversary, "* Dark" variants, Throwback, Stadium, Misc) is
// excluded — dark-mode variants and throwbacks are recolors/reissues of
// logos already captured elsewhere, not distinct identity marks.
function classifySection(sectionTitle) {
  const t = sectionTitle.toLowerCase();
  if (!t.includes('logo')) return null; // e.g. "Gear For Sale"
  if (
    t.includes('uniform') ||
    t.includes('dark') ||
    t.includes('helmet') ||
    t.includes('wordmark') ||
    t.includes('anniversary') ||
    t.includes('throwback') ||
    t.includes('misc') ||
    t.includes('stadium') ||
    t.includes('player')
  ) {
    return null;
  }
  if (/\bprimary\b/.test(t)) return 'primary';
  if (/\bsecondary\b/.test(t) || /\balternate\b/.test(t)) return 'secondary';
  return null;
}

// Multi-word nicknames break a naive "last word = nickname" split. Keyed by
// the exact "City Nickname" string as sportslogos.net renders it. Expand
// this as new leagues get scraped and new breakages are found (see
// HANDOFF.md gap #2) — not meant to be exhaustive up front.
const NICKNAME_OVERRIDES = {
  'Toronto Maple Leafs': ['Toronto', 'Maple Leafs'],
  'Columbus Blue Jackets': ['Columbus', 'Blue Jackets'],
  'Vegas Golden Knights': ['Vegas', 'Golden Knights'],
  'Detroit Red Wings': ['Detroit', 'Red Wings'],
  'Boston Red Sox': ['Boston', 'Red Sox'],
  'Chicago White Sox': ['Chicago', 'White Sox'],
  'Toronto Blue Jays': ['Toronto', 'Blue Jays'],
  'Portland Trail Blazers': ['Portland', 'Trail Blazers'],
};

function splitTeamNickname(fullName) {
  if (NICKNAME_OVERRIDES[fullName]) {
    const [team, nickname] = NICKNAME_OVERRIDES[fullName];
    return { team, nickname };
  }
  const parts = fullName.trim().split(' ');
  // Some franchises are currently listed under a single word with no city
  // (e.g. MLB's "Athletics", mid-relocation) — naive split would leave team
  // blank, so fall back to using the same word for both fields.
  if (parts.length === 1) {
    return { team: parts[0], nickname: parts[0] };
  }
  return {
    team: parts.slice(0, -1).join(' '),
    nickname: parts.slice(-1).join(' '),
  };
}

function slugify(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Text-in-logo filter ------------------------------------------------
// A guessing game can't use a logo that gives away readable text as a clue.
// Whole "Wordmark" sections are already excluded by classifySection(), but
// plenty of Primary/Secondary/Alternate marks (seals, badges, script logos)
// also bake real text into the artwork itself. There's no DOM signal for
// this — it has to be read off the actual image — so this runs OCR
// (tesseract.js) against every candidate logo thumbnail and drops any where
// it detects a run of letters at or above MIN_SIGNIFICANT_TEXT_LEN, anywhere
// in the image (not just team-name matches). Short 1-2 letter monograms
// (e.g. a stylized "KC" or "NY") are allowed through; anything longer is
// treated as a spoiler and dropped, regardless of whether it happens to
// spell out the team's own name.
//
// OCR on small/stylized sports-logo thumbnails is inherently imperfect:
// curved or heavily stylized text is often misread, so this will miss some
// text logos (false negatives) — clean, boxy lettering (e.g. "BENGALS") is
// reliably caught, garbled/curved script often isn't. It should be treated
// as a real reduction in text-logo contamination, not a guarantee of zero.
// It also means occasional false positives on totally clean icon-only
// logos where OCR hallucinates a few letters out of the shape's edges.
const MIN_SIGNIFICANT_TEXT_LEN = 3;

function ocrHasSignificantText(ocrText) {
  const letterRuns = ocrText.toLowerCase().match(/[a-z]+/g) || [];
  return letterRuns.some((run) => run.length >= MIN_SIGNIFICANT_TEXT_LEN);
}

async function filterTextLogos(catalog) {
  console.log('\nRunning OCR text-in-logo filter (this can take a while)...');
  const worker = await createWorker('eng');
  let scanned = 0;
  let removed = 0;

  for (const entry of catalog) {
    const kept = [];
    const flagged = [];
    for (const logo of entry.logos) {
      scanned++;
      try {
        const res = await fetch(logo.url);
        const buf = Buffer.from(await res.arrayBuffer());
        const { data } = await worker.recognize(buf);
        if (ocrHasSignificantText(data.text)) {
          flagged.push(logo);
          continue;
        }
      } catch (e) {
        console.warn(`  ! OCR failed on ${logo.url}: ${e.message} — keeping logo`);
      }
      kept.push(logo);
    }

    // Never let this filter zero out a team entirely — if every single logo
    // got flagged, that's much more likely a systematic OCR misread (e.g. an
    // icon's shape getting read as letters) than a team that genuinely has
    // no usable identity mark. Keep the originals and flag for human review
    // instead of silently dropping the team from the catalog.
    if (kept.length === 0 && flagged.length > 0) {
      console.warn(`  ? ${entry.team} ${entry.nickname}: OCR flagged ALL ${flagged.length} logo(s) as text — keeping them, needs manual review`);
      entry.logos = flagged;
    } else {
      for (const logo of flagged) {
        removed++;
        console.log(`  [text logo removed] ${entry.team} ${entry.nickname} (${logo.type}, ${logo.era})`);
      }
      entry.logos = kept;
    }
  }

  await worker.terminate();
  console.log(`OCR filter done: scanned ${scanned} logos, removed ${removed} text logos.`);
  return catalog.filter((entry) => entry.logos.length > 0);
}

// Collects the set of every raw section title seen, across all teams/leagues
// scraped this run — printed at the end so a human can eyeball whether
// classifySection() is still catching everything it should (HANDOFF gap #1).
const seenSectionTitles = new Set();

async function getTeamLinksForLeague(page, league) {
  const hubUrls = LEAGUE_HUB_URLS[league];
  if (!hubUrls || hubUrls.length === 0) {
    console.warn(`  ! no hub URL configured for ${league}, skipping`);
    return [];
  }

  const allLinks = [];
  const seenUrls = new Set();

  for (const hubUrl of hubUrls) {
    await page.goto(hubUrl, { waitUntil: 'domcontentloaded' });
    await sleep(REQUEST_DELAY_MS);

    // Each team-index card has a name span and a separate year-range span
    // (".card-text span:nth-child(1|2)") — read them directly rather than
    // regexing the flattened text, since the year-range format differs by
    // league (NFL: "1994 - Pres", NHL/NBA: "2006/07 - Pres" season format).
    // Still-active franchises end in "Pres"; historical franchises show
    // closed ranges (e.g. "1953 - 1983"); non-team hub links (Super Bowl,
    // conferences, league-wide pages, etc.) have no year-range span at all.
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/logos/list_by_team/"]'))
        .map((a) => {
          const spans = a.querySelectorAll('.card-text span');
          return {
            url: a.href,
            name: (spans[0]?.textContent || '').trim(),
            years: (spans[1]?.textContent || '').trim(),
          };
        })
        .filter((l) => l.name && /pres/i.test(l.years));
    });

    for (const link of links) {
      if (seenUrls.has(link.url)) continue; // NCAA sub-pages could in theory overlap
      seenUrls.add(link.url);
      allLinks.push(link);
    }
  }

  return allLinks;
}

async function scrapeTeamPage(page, url, teamName, league) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(REQUEST_DELAY_MS);

  const sections = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('h3.cftr_browseHeading')).map((heading) => {
      const container = heading.closest('.browseHeading');
      const cardList = container ? container.nextElementSibling : null;
      const hasCards = cardList && cardList.classList.contains('team-card-list');
      const tiles = hasCards
        ? Array.from(cardList.querySelectorAll('.team-card img')).map((img) => ({
            src: img.src,
            alt: img.alt || '',
          }))
        : [];
      return { title: heading.textContent.trim(), tiles };
    });
  });

  const { team, nickname } = splitTeamNickname(teamName);
  const logos = [];
  const seenUrls = new Set();

  for (const section of sections) {
    seenSectionTitles.add(section.title);
    const type = classifySection(section.title);
    if (!type) continue;

    for (const tile of section.tiles) {
      if (!tile.src || seenUrls.has(tile.src)) continue;
      seenUrls.add(tile.src);
      const eraMatch = tile.alt.match(/\(([^)]+)\)\s*$/);
      logos.push({ url: tile.src, type, era: eraMatch ? eraMatch[1].trim() : '' });
    }
  }

  return {
    id: slugify(`${team}-${nickname}`),
    team,
    nickname,
    league,
    logos,
  };
}

function loadExistingCatalog() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: USER_AGENT });

  const newEntries = [];

  for (const league of LEAGUES_TO_SCRAPE) {
    console.log(`Scraping ${league}...`);
    const teamLinks = await getTeamLinksForLeague(page, league);
    console.log(`  found ${teamLinks.length} current teams`);

    for (const { url, name } of teamLinks) {
      try {
        const teamData = await scrapeTeamPage(page, url, name, league);
        if (teamData && teamData.logos.length > 0) {
          newEntries.push(teamData);
          console.log(`  + ${teamData.team} ${teamData.nickname} (${teamData.logos.length} logos)`);
        } else {
          console.warn(`  ! ${name}: no primary/secondary logos found`);
        }
      } catch (e) {
        console.warn(`  ! failed on ${url}: ${e.message}`);
      }
    }
  }

  await browser.close();

  // Only OCR-filter the entries scraped THIS run — that's the slow part,
  // and everything already in the existing catalog was already filtered by
  // a previous run. Upsert by team id rather than replacing a whole league
  // wholesale: NCAA's 6 hub pages get scraped in separate batches (each
  // batch is a partial slice of the "NCAA" league), so replacing by league
  // name would wipe out earlier NCAA batches when a later one runs.
  const filteredNewEntries = await filterTextLogos(newEntries);

  const existingCatalog = loadExistingCatalog();
  const merged = new Map(existingCatalog.map((entry) => [entry.id, entry]));
  for (const entry of filteredNewEntries) merged.set(entry.id, entry);
  const finalCatalog = [...merged.values()];

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalCatalog, null, 2));
  console.log(`\nWrote ${finalCatalog.length} teams total to ${OUTPUT_PATH} (${existingCatalog.length} existed before, ${filteredNewEntries.length} upserted from this run)`);

  console.log('\nAll section titles seen this run (verify classifySection() still catches everything intended):');
  for (const title of [...seenSectionTitles].sort()) {
    console.log(`  ${classifySection(title) ? '[KEPT]  ' : '[SKIP]  '}${title}`);
  }
}

run();
