// scripts/build-catalog.js
//
// Scrapes sportslogos.net team pages into data/catalog.json.
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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Polite delay between page loads so we don't hammer a small hobby site.
const REQUEST_DELAY_MS = 400;

// League -> team index ("hub") page. NFL, NHL, NBA, MLB are confirmed/tested
// (team counts matched the real league sizes: 32/32/30/30). NCAA/EPL/etc.
// need their own hub-page investigation (NCAA in particular is split into
// sub-league pages like "NCAA Division I a-c") — scale up one league at a
// time, confirming each hub page's structure before trusting it blindly.
const LEAGUE_HUB_URLS = {
  NFL: 'https://www.sportslogos.net/teams/list_by_league/7/National-Football-League-Logos/NFL-Logos/',
  MLB: 'https://www.sportslogos.net/teams/list_by_league/4/Major-League-Baseball-Logos/MLB-Logos/',
  NHL: 'https://www.sportslogos.net/teams/list_by_league/1/National-Hockey-League-Logos/NHL-Logos/',
  NBA: 'https://www.sportslogos.net/teams/list_by_league/6/National-Basketball-Association-Logos/NBA-Logos/',
};

// Leagues to scrape this run — start small, expand once verified.
const LEAGUES_TO_SCRAPE = ['NFL', 'NHL', 'NBA', 'MLB'];

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

// Collects the set of every raw section title seen, across all teams/leagues
// scraped this run — printed at the end so a human can eyeball whether
// classifySection() is still catching everything it should (HANDOFF gap #1).
const seenSectionTitles = new Set();

async function getTeamLinksForLeague(page, league) {
  const hubUrl = LEAGUE_HUB_URLS[league];
  if (!hubUrl) {
    console.warn(`  ! no hub URL configured for ${league}, skipping`);
    return [];
  }

  await page.goto(hubUrl, { waitUntil: 'domcontentloaded' });
  await sleep(REQUEST_DELAY_MS);

  // Each team-index card has a name span and a separate year-range span
  // (".card-text span:nth-child(1|2)") — read them directly rather than
  // regexing the flattened text, since the year-range format differs by
  // league (NFL: "1994 - Pres", NHL/NBA: "2006/07 - Pres" season format).
  // Still-active franchises end in "Pres"; historical franchises show closed
  // ranges (e.g. "1953 - 1983"); non-team hub links (Super Bowl, conferences,
  // league-wide pages, etc.) have no year-range span at all.
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

  return links;
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

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: USER_AGENT });

  const catalog = [];

  for (const league of LEAGUES_TO_SCRAPE) {
    console.log(`Scraping ${league}...`);
    const teamLinks = await getTeamLinksForLeague(page, league);
    console.log(`  found ${teamLinks.length} current teams`);

    for (const { url, name } of teamLinks) {
      try {
        const teamData = await scrapeTeamPage(page, url, name, league);
        if (teamData && teamData.logos.length > 0) {
          catalog.push(teamData);
          console.log(`  + ${teamData.team} ${teamData.nickname} (${teamData.logos.length} logos)`);
        } else {
          console.warn(`  ! ${name}: no primary/secondary logos found`);
        }
      } catch (e) {
        console.warn(`  ! failed on ${url}: ${e.message}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote ${catalog.length} teams to ${OUTPUT_PATH}`);

  console.log('\nAll section titles seen this run (verify classifySection() still catches everything intended):');
  for (const title of [...seenSectionTitles].sort()) {
    console.log(`  ${classifySection(title) ? '[KEPT]  ' : '[SKIP]  '}${title}`);
  }

  await browser.close();
}

run();
