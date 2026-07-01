/**
 * Regression test for a real bug: fetchAllSeries used to check the
 * POST-novel-filter result count to decide whether a page was "full"
 * (and therefore whether to keep paginating). Since novels get filtered
 * out, a genuinely full 24-entry page containing one novel would look
 * like only 23 results — fewer than 24 — causing pagination to stop
 * after page 1 even when hundreds more series existed on later pages.
 *
 * The fix checks the RAW pre-filter count instead. This test proves it
 * by simulating two full pages (each 24 raw / 23 after filtering) plus
 * a genuinely empty third page.
 */
const fs = require("fs");
const path = require("path");

const listingHTML = fs.readFileSync(path.join(__dirname, "test-fixtures", "listing.html"), "utf-8");

let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls++;
  const urlStr = String(url);
  const pageMatch = urlStr.match(/page=(\d+)/);
  const page = pageMatch ? Number(pageMatch[1]) : 1;

  // Pages 1 and 2 both simulate a full 24-raw-entry page (23 after the
  // novel filter) — this is the exact shape that triggered the bug.
  if (page <= 2) {
    return { ok: true, status: 200, text: async () => listingHTML };
  }
  // Page 3 is genuinely past the end.
  return { ok: true, status: 200, text: async () => "<html><body></body></html>" };
};

const { fetchAllSeries } = require("./server/valirscans");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  console.log("\n--- Pagination continues past a filtered-short-looking full page ---");
  const series = await fetchAllSeries();

  assert(
    series.length === 46,
    `fetched 46 series across 2 full pages (23 each after filtering), got ${series.length}`
  );
  assert(
    fetchCalls === 3,
    `made 3 requests — page 1, page 2, and page 3 to confirm the real end (got ${fetchCalls})`
  );

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
