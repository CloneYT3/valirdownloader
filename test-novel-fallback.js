/**
 * Verifies fetchSeriesDetails' fallback parsing for pages that don't use
 * the "series" key (e.g. unverified novel page structures), and the
 * diagnostic error when no candidate key matches at all.
 */
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  console.log("\n--- fetchSeriesDetails: alternate top-level key fallback ---");
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      '{\\"novel\\":{\\"title\\":\\"Test Novel\\",\\"coverImage\\":\\"/x.webp\\",\\"status\\":\\"ONGOING\\",\\"type\\":\\"WEB_NOVEL\\",\\"chapters\\":[{\\"id\\":\\"a\\",\\"number\\":1,\\"title\\":\\"Ch1\\",\\"isLocked\\":false}]}}',
  });
  delete require.cache[require.resolve("./server/valirscans")];
  const { fetchSeriesDetails: fetchSeriesDetails1 } = require("./server/valirscans");
  const details = await fetchSeriesDetails1("novel", "test-novel");
  assert(details.title === "Test Novel", `title extracted via fallback key (got "${details.title}")`);
  assert(details.chapters.length === 1, `chapters extracted via series.chapters fallback (got ${details.chapters.length})`);
  assert(details.cover.includes("x.webp"), `cover URL resolved (got "${details.cover}")`);

  console.log("\n--- fetchSeriesDetails: no matching key at all -> diagnostic error ---");
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '{\\"somethingElse\\":{\\"weirdField\\":\\"x\\"}}',
  });
  delete require.cache[require.resolve("./server/valirscans")];
  const { fetchSeriesDetails: fetchSeriesDetails2 } = require("./server/valirscans");
  let caught = null;
  try {
    await fetchSeriesDetails2("novel", "test-novel");
  } catch (err) {
    caught = err;
  }
  assert(!!caught, "throws instead of crashing with an unrelated TypeError");
  assert(
    caught?.message.startsWith("SERIES_FIELD_NOT_FOUND"),
    `error is the specific diagnostic error (got: ${caught?.message})`
  );
  assert(
    caught?.message.includes("weirdField"),
    `diagnostic error lists actual nearby keys found (got: ${caught?.message})`
  );

  console.log("\n--- fetchSeriesDetails: REAL captured novel page (Golden Chevalier) ---");
  const fs = require("fs");
  const path = require("path");
  const realNovelHTML = fs.readFileSync(path.join(__dirname, "test-fixtures", "novel-series.html"), "utf-8");
  global.fetch = async () => ({ ok: true, status: 200, text: async () => realNovelHTML });
  delete require.cache[require.resolve("./server/valirscans")];
  const { fetchSeriesDetails: fetchSeriesDetails3 } = require("./server/valirscans");
  const realDetails = await fetchSeriesDetails3("novel", "golden-chevalier");
  assert(realDetails.title === "Golden Chevalier", `real novel title parsed correctly (got "${realDetails.title}")`);
  assert(realDetails.chapters.length === 100, `all 100 real chapters parsed (got ${realDetails.chapters.length})`);
  assert(realDetails.cover.includes("cover-d061d9781f31f85a7102508754f2d5db"), "real cover URL resolved correctly");

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
