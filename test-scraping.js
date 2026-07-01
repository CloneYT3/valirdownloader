/**
 * Verifies server/valirscans.js against the real captured HTML fixtures
 * (same ones validated in the Suwatte runner project). Mocks global fetch
 * so no real network calls happen.
 */
const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "test-fixtures");
const listingHTML = fs.readFileSync(path.join(FIXTURES, "listing.html"), "utf-8");
const seriesHTML = fs.readFileSync(path.join(FIXTURES, "series.html"), "utf-8");
const chapterHTML = fs.readFileSync(path.join(FIXTURES, "chapter.html"), "utf-8");

global.fetch = async (url) => {
  let body;
  if (url.includes("/chapter/")) {
    body = chapterHTML;
  } else if (url.includes("/series/comic/our-guilds-idol")) {
    body = seriesHTML;
  } else if (url.includes("/series")) {
    // Only page 1 has our captured fixture; simulate an empty page 2 so
    // fetchAllSeries' pagination loop terminates instead of looping
    // against the same 24 results forever.
    const pageMatch = url.match(/page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    body = page === 1 ? listingHTML : "<html><body></body></html>";
  } else {
    throw new Error(`Unmocked URL: ${url}`);
  }

  return {
    ok: true,
    status: 200,
    text: async () => body,
  };
};

const { fetchAllSeries, fetchSeriesDetails, fetchChapterPages, fetchAvailableGenres } = require("./server/valirscans");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  console.log("\n--- fetchAllSeries ---");
  const series = await fetchAllSeries();
  assert(series.length === 23, `found ${series.length} series, novels excluded (expected 23 of 24 raw entries)`);
  assert(
    series.every((s) => s.type !== "WEB_NOVEL" && s.type !== "WEB NOVEL"),
    "no novels appear in the directory listing at all"
  );
  assert(
    series.every((s) => s.urlType === "comic"),
    "every remaining series has urlType comic (none slipped through as novel)"
  );
  const ourGuildsIdol = series.find((s) => s.slug === "our-guilds-idol");
  assert(!!ourGuildsIdol, "found Our Guild's Idol in listing");
  assert(ourGuildsIdol?.title === "Our Guild's Idol", `title correct: "${ourGuildsIdol?.title}"`);

  // Regression check: an earlier regex-based parser misaligned titles
  // against slugs/types once the page had >1 link variant per card
  // (real-link, repeated empty-image link, and per-chapter links all
  // sharing the same href prefix). These specific pairings must hold.
  const bunkerDays = series.find((s) => s.slug === "bunker-days");
  assert(!!bunkerDays, "found bunker-days in listing");
  assert(bunkerDays?.title === "Bunker Days", `bunker-days title correctly aligned: "${bunkerDays?.title}"`);

  const snakeSeries = series.find((s) => s.slug === "in-the-empresss-bedroom-lives-a-snake");
  assert(!!snakeSeries, "found the snake series by its correct slug");
  assert(
    snakeSeries?.title === "In the Empress’s Bedroom Lives a Snake",
    `snake series title correctly aligned: "${snakeSeries?.title}"`
  );

  const countSeries = series.find((s) => s.slug === "the-counts-beloved-contract-young-lady");
  assert(countSeries?.type === "MANGA", `type badge correctly varies per card (got "${countSeries?.type}")`);
  assert(ourGuildsIdol?.type === "MANHWA", `Our Guild's Idol type correct (got "${ourGuildsIdol?.type}")`);

  // New fields needed for filtering/sorting in the UI.
  assert(
    Array.isArray(ourGuildsIdol?.genres) && ourGuildsIdol.genres.includes("romance"),
    `directory listing includes genre slugs (got: ${JSON.stringify(ourGuildsIdol?.genres)})`
  );
  assert(ourGuildsIdol?.status === "ONGOING", `status available from listing (got "${ourGuildsIdol?.status}")`);
  assert(typeof ourGuildsIdol?.rating === "number", `rating available from listing (got ${ourGuildsIdol?.rating})`);
  assert(
    ourGuildsIdol?.latestChapterNumber === 51,
    `latest chapter number derived from recent chapters (got ${ourGuildsIdol?.latestChapterNumber})`
  );
  assert(!!ourGuildsIdol?.latestChapterDate, "latest chapter date is present for sort-by-recent");

  console.log("\n--- fetchSeriesDetails ---");
  const details = await fetchSeriesDetails("comic", "our-guilds-idol");
  assert(details.title === "Our Guild's Idol", `title: "${details.title}"`);
  assert(details.chapters.length === 51, `parsed ${details.chapters.length} chapters (expected 51)`);
  assert(details.cover.startsWith("http"), `cover is absolute: ${details.cover}`);

  // Regression check: an earlier version read the wrong key ("genre"
  // instead of "genres") and assumed plain strings instead of {name,
  // slug, color} objects, silently producing an empty array with no
  // visible error.
  assert(Array.isArray(details.genres), "genres is an array");
  assert(details.genres.length > 0, `genres is non-empty (got ${details.genres.length} entries)`);
  assert(
    details.genres.every((g) => typeof g === "string"),
    `every genre is a plain string (got: ${JSON.stringify(details.genres.slice(0, 3))})`
  );
  assert(details.genres.includes("Romance"), `genres includes "Romance" (got: ${JSON.stringify(details.genres)})`);

  console.log("\n--- fetchChapterPages ---");
  const pages = await fetchChapterPages("comic", "our-guilds-idol", 1);
  assert(pages.length === 48, `parsed ${pages.length} pages (expected 48)`);
  assert(
    pages[0] === "https://media.valirscans.org/series/our-guilds-idol/0001/p-bcaa5a76-8669-442e-ad9b-2755a7dfce5f.webp",
    `first page URL matches known value: ${pages[0]}`
  );

  console.log("\n--- fetchAvailableGenres ---");
  const genres = await fetchAvailableGenres();
  assert(genres.length > 0, `fetched ${genres.length} available genres`);
  assert(
    genres.some((g) => g.name === "Romance" && g.slug === "romance"),
    `genre list includes Romance (got ${genres.length} total)`
  );
  assert(
    genres.every((g) => typeof g.name === "string" && typeof g.slug === "string"),
    "every genre has both name and slug"
  );
  // Regression check: this list must NOT be confused with any single
  // series' own (much shorter) genre tag list.
  assert(genres.length > 10, `genre list is the full site-wide list, not one series' tags (got ${genres.length})`);

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
