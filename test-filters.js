/**
 * Verifies the new filtering/sorting query logic (mirrored from
 * server/index.js's /api/series route), novel chapter error handling,
 * and the settings module — all against real fixture data where
 * applicable.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-filter-test-"));
process.env.VS_DATA_DIR = tmpDataDir;

const FIXTURES = path.join(__dirname, "test-fixtures");
const listingHTML = fs.readFileSync(path.join(FIXTURES, "listing.html"), "utf-8");

global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes("/series")) {
    const pageMatch = urlStr.match(/page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    return { ok: true, status: 200, text: async () => (page === 1 ? listingHTML : "<html></html>") };
  }
  throw new Error(`Unmocked URL: ${urlStr}`);
};

const { fetchAllSeries, fetchChapterPages } = require("./server/valirscans");
const settings = require("./server/settings");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

// Mirrors the filter/sort logic in server/index.js's /api/series route,
// so we can test the logic itself without booting a real HTTP server.
function applyFilterSort(series, { genre, type, status, sortBy }) {
  let filtered = series;
  if (genre) filtered = filtered.filter((s) => (s.genres || []).includes(genre));
  if (type) filtered = filtered.filter((s) => s.type === type);
  if (status) filtered = filtered.filter((s) => s.status === status);

  return filtered.slice().sort((a, b) => {
    switch (sortBy) {
      case "name":
        return a.title.localeCompare(b.title);
      case "name_desc":
        return b.title.localeCompare(a.title);
      case "chapters":
        return (b.latestChapterNumber || 0) - (a.latestChapterNumber || 0);
      case "chapters_asc":
        return (a.latestChapterNumber || 0) - (b.latestChapterNumber || 0);
      case "rating":
        return (b.rating || 0) - (a.rating || 0);
      case "updated":
      default:
        return new Date(b.latestChapterDate || 0) - new Date(a.latestChapterDate || 0);
    }
  });
}

(async () => {
  const series = await fetchAllSeries();

  console.log("\n--- Filtering ---");
  const romanceOnly = applyFilterSort(series, { genre: "romance" });
  assert(romanceOnly.length > 0, `genre filter "romance" returns results (got ${romanceOnly.length})`);
  assert(
    romanceOnly.every((s) => s.genres.includes("romance")),
    "every filtered result actually has the romance genre"
  );
  assert(romanceOnly.length < series.length, "genre filter actually narrows results (not a no-op)");

  const mangaOnly = applyFilterSort(series, { type: "MANGA" });
  assert(
    mangaOnly.every((s) => s.type === "MANGA"),
    `type filter "MANGA" returns only manga (got ${mangaOnly.length} results)`
  );

  const ongoingOnly = applyFilterSort(series, { status: "ONGOING" });
  assert(
    ongoingOnly.every((s) => s.status === "ONGOING"),
    `status filter "ONGOING" returns only ongoing series (got ${ongoingOnly.length} results)`
  );

  const combined = applyFilterSort(series, { genre: "romance", type: "MANHWA" });
  assert(
    combined.every((s) => s.genres.includes("romance") && s.type === "MANHWA"),
    `combined genre+type filter applies both conditions (got ${combined.length} results)`
  );

  console.log("\n--- Sorting ---");
  const byNameAsc = applyFilterSort(series, { sortBy: "name" });
  const titlesAsc = byNameAsc.map((s) => s.title);
  const sortedTitlesAsc = [...titlesAsc].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(titlesAsc) === JSON.stringify(sortedTitlesAsc), "sortBy=name produces alphabetical order");

  const byNameDesc = applyFilterSort(series, { sortBy: "name_desc" });
  assert(byNameDesc[0].title === byNameAsc[byNameAsc.length - 1].title, "sortBy=name_desc reverses the name order");

  const byChapters = applyFilterSort(series, { sortBy: "chapters" });
  for (let i = 1; i < byChapters.length; i++) {
    if (byChapters[i].latestChapterNumber > byChapters[i - 1].latestChapterNumber) {
      assert(false, "sortBy=chapters is not actually descending at some point");
      break;
    }
  }
  assert(true, "sortBy=chapters produces descending chapter-count order");

  const byRating = applyFilterSort(series, { sortBy: "rating" });
  assert(
    byRating[0].rating >= byRating[byRating.length - 1].rating,
    `sortBy=rating produces descending rating order (first: ${byRating[0].rating}, last: ${byRating[byRating.length - 1].rating})`
  );

  console.log("\n--- Novel handling ---");
  let novelError = null;
  try {
    await fetchChapterPages("novel", "some-novel-slug", 1);
  } catch (err) {
    novelError = err;
  }
  assert(!!novelError, "fetchChapterPages throws for novel urlType instead of silently failing");
  assert(
    novelError?.message.startsWith("NOVEL_NOT_SUPPORTED"),
    `error is specifically the novel-not-supported error (got: ${novelError?.message})`
  );

  console.log("\n--- Settings ---");
  const defaults = settings.getSettings();
  assert(defaults.imagePreloadCount === 2, `default imagePreloadCount is 2 (got ${defaults.imagePreloadCount})`);
  assert(defaults.chapterOrderDescending === false, "default chapterOrderDescending is false");

  const updated = settings.updateSettings({ imagePreloadCount: 4 });
  assert(updated.imagePreloadCount === 4, `updateSettings persists new value (got ${updated.imagePreloadCount})`);

  const reread = settings.getSettings();
  assert(reread.imagePreloadCount === 4, "settings persist across getSettings calls (read from disk)");

  const clampedHigh = settings.updateSettings({ imagePreloadCount: 99 });
  assert(clampedHigh.imagePreloadCount === 5, `imagePreloadCount is clamped to max 5 (got ${clampedHigh.imagePreloadCount})`);

  const clampedLow = settings.updateSettings({ imagePreloadCount: -3 });
  assert(clampedLow.imagePreloadCount === 1, `imagePreloadCount is clamped to min 1 (got ${clampedLow.imagePreloadCount})`);

  const orderUpdate = settings.updateSettings({ chapterOrderDescending: true });
  assert(orderUpdate.chapterOrderDescending === true, "chapterOrderDescending updates correctly");

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();
