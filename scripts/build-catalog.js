// scripts/build-catalog.js
//
// Scrapes sportslogos.net team pages into data/catalog.json.
// Run this occasionally (not daily) — it's the master pool that
// pick-daily.js samples from. Uses Playwright, matching the existing
// laxnumbers.com scraper pattern.
//
// USAGE:
//   node scripts/build-catalog.js
//
// This is a SKELETON — the actual page selectors below are placeholders.
// Sportslogos.net's DOM structure needs to be inspected live (this chat's
// sandbox can't reach the site) before the scrape logic will work.
// Look for: league index pages -> team index pages -> individual team
// pages with "Primary Logos History" / "Secondary Logos History" sections.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

// Leagues to scrape. Match these strings to whatever sportslogos.net's own
// league labels are — confirm exact casing/naming during the first run.
const LEAGUES_TO_SCRAPE = [
  'NFL', 'NBA', 'MLB', 'NHL',
  'NCAA', // college — likely needs per-conference or per-sport sub-navigation
  'EPL', 'Bundesliga', 'Serie A', 'La Liga',
  'WNBA', 'AHL',
  'International League', 'Pacific Coast League', // AAA baseball — verify site taxonomy
];

// Sections that aren't guessable team identity logos — skip at scrape time.
const EXCLUDED_SECTION_KEYWORDS = [
  'uniform',
  'helmet',
  'miscellaneous',
  'misc.',
  'misc',
  'anniversary',
  'event logo',
  'playoff',
  'championship',
  'stadium',
];

function shouldSkipSection(sectionTitle) {
  const t = sectionTitle.toLowerCase();
  return EXCLUDED_SECTION_KEYWORDS.some((keyword) => t.includes(keyword));
}

function slugify(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function getTeamLinksForLeague(page, league) {
  // TODO: navigate to the league's team index page and collect links.
  // Placeholder return — replace with real scraping logic.
  console.log(`  [TODO] collecting team links for ${league}`);
  return [];
}

async function scrapeTeamPage(page, url, league) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // TODO: replace with real selectors once the page structure is confirmed.
  // Expect something like: sections with a heading (e.g. "ARKANSAS
  // RAZORBACKS PRIMARY LOGOS HISTORY") each containing a grid of logo tiles
  // (image + era label).
  const teamName = await page.locator('h1').first().innerText().catch(() => null);
  if (!teamName) return null;

  // Sportslogos.net team names are often "City Nickname" as a single H1 —
  // splitting into { team, nickname } may need per-league heuristics
  // (e.g. last word(s) = nickname, rest = team/city). Verify against
  // real examples before trusting this blindly — multi-word nicknames
  // like "Maple Leafs" or "Red Sox" will break a naive last-word split.
  const parts = teamName.trim().split(' ');
  const nickname = parts.slice(-1).join(' '); // PLACEHOLDER — needs real logic
  const team = parts.slice(0, -1).join(' ');

  const sections = await page.locator('[data-section], .logo-section').all().catch(() => []);
  const logos = [];

  for (const section of sections) {
    const sectionTitle = await section.locator('h2, h3, .section-title').first().innerText().catch(() => '');
    if (!sectionTitle || shouldSkipSection(sectionTitle)) {
      if (sectionTitle) console.log(`    skipping section: ${sectionTitle}`);
      continue;
    }

    const type = sectionTitle.toLowerCase().includes('primary') ? 'primary' : 'secondary';
    const tiles = await section.locator('.logo-tile, figure').all().catch(() => []);

    for (const tile of tiles) {
      const imageUrl = await tile.locator('img').first().getAttribute('src').catch(() => null);
      const era = await tile.locator('.era-label, figcaption').first().innerText().catch(() => '');
      if (imageUrl) logos.push({ url: imageUrl, type, era: era.trim() });
    }
  }

  return {
    id: slugify(`${team}-${nickname}`),
    team: team.trim(),
    nickname: nickname.trim(),
    league,
    logos,
  };
}

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const catalog = [];

  for (const league of LEAGUES_TO_SCRAPE) {
    console.log(`Scraping ${league}...`);
    const teamLinks = await getTeamLinksForLeague(page, league);

    for (const url of teamLinks) {
      try {
        const teamData = await scrapeTeamPage(page, url, league);
        if (teamData && teamData.logos.length > 0) {
          catalog.push(teamData);
          console.log(`  + ${teamData.team} ${teamData.nickname} (${teamData.logos.length} logos)`);
        }
      } catch (e) {
        console.warn(`  ! failed on ${url}: ${e.message}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote ${catalog.length} teams to ${OUTPUT_PATH}`);

  await browser.close();
}

run();
