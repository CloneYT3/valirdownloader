/**
 * Verifies server/cbz.js actually produces a valid, correctly-ordered
 * ZIP/CBZ file, using mocked fetch for both the chapter-page HTML and the
 * individual image downloads (small synthetic PNGs, not real network
 * calls).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const FIXTURES = path.join(__dirname, "test-fixtures");
const chapterHTML = fs.readFileSync(path.join(FIXTURES, "chapter.html"), "utf-8");

// A minimal valid 1x1 PNG, used as a stand-in for real page images.
const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

global.fetch = async (url) => {
  if (url.includes("/chapter/2")) {
    // Reuse the same fixture for a second "chapter" to test multi-chapter
    // combining — the actual chapter number in the URL doesn't need to
    // match content for this test, we just need a second distinct fetch.
    return { ok: true, status: 200, text: async () => chapterHTML };
  }
  if (url.includes("/chapter/")) {
    return { ok: true, status: 200, text: async () => chapterHTML };
  }
  if (url.includes("media.valirscans.org")) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => FAKE_PNG.buffer.slice(FAKE_PNG.byteOffset, FAKE_PNG.byteOffset + FAKE_PNG.byteLength),
    };
  }
  throw new Error(`Unmocked URL: ${url}`);
};

const { downloadChapterAsCBZ, downloadChapterRangeAsCBZ } = require("./server/cbz");
const AdmZip = (() => {
  try {
    return require("adm-zip");
  } catch {
    return null;
  }
})();

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbz-test-"));

  console.log("\n--- downloadChapterAsCBZ (single chapter) ---");
  const singlePath = await downloadChapterAsCBZ({
    urlType: "comic",
    slug: "our-guilds-idol",
    seriesTitle: "Our Guild's Idol",
    chapterNumber: 1,
    chapterTitle: "Chapter 1",
    outDir,
  });

  assert(fs.existsSync(singlePath), `CBZ file created at ${singlePath}`);
  assert(singlePath.endsWith(".cbz"), "file has .cbz extension");

  const stat = fs.statSync(singlePath);
  assert(stat.size > 0, `file is non-empty (${stat.size} bytes)`);

  if (AdmZip) {
    const zip = new AdmZip(singlePath);
    const entries = zip.getEntries();
    assert(entries.length === 48, `archive contains 48 entries (expected 48 pages, got ${entries.length})`);
    const names = entries.map((e) => e.entryName).sort();
    assert(names[0] === "001.png" || names[0].startsWith("001"), `first entry correctly named: ${names[0]}`);
  } else {
    console.log("(adm-zip not installed — skipping internal archive content checks)");
  }

  console.log("\n--- downloadChapterRangeAsCBZ (combined, 2 chapters) ---");
  const combinedPath = await downloadChapterRangeAsCBZ({
    urlType: "comic",
    slug: "our-guilds-idol",
    seriesTitle: "Our Guild's Idol",
    chapters: [
      { number: 1, title: "Chapter 1" },
      { number: 2, title: "Chapter 2" },
    ],
    outDir,
  });

  assert(fs.existsSync(combinedPath), `combined CBZ created at ${combinedPath}`);
  assert(combinedPath.includes("Ch.0001-0002"), `filename reflects chapter range: ${path.basename(combinedPath)}`);

  if (AdmZip) {
    const zip2 = new AdmZip(combinedPath);
    const entries2 = zip2.getEntries();
    assert(entries2.length === 96, `combined archive has 96 entries (48 pages x 2 chapters, got ${entries2.length})`);
    const names2 = entries2.map((e) => e.entryName).sort();
    assert(names2[0].startsWith("0001-"), `first entry namespaced by chapter: ${names2[0]}`);
    assert(names2.some((n) => n.startsWith("0002-")), "second chapter's pages are present and namespaced");
  }

  console.log("\n--- downloadChapterAsCBZ with seriesCover (thumbnail support) ---");
  const withCoverPath = await downloadChapterAsCBZ({
    urlType: "comic",
    slug: "our-guilds-idol",
    seriesTitle: "Cover Test",
    chapterNumber: 1,
    seriesCover: "https://media.valirscans.org/series/cover-test.webp",
    outDir,
  });

  if (AdmZip) {
    const zipCover = new AdmZip(withCoverPath);
    const entriesCover = zipCover.getEntries().map((e) => e.entryName).sort();
    assert(entriesCover.length === 49, `49 entries (48 pages + 1 cover), got ${entriesCover.length}`);
    assert(entriesCover[0].startsWith("000"), `cover sorts first as "000...": ${entriesCover[0]}`);
    assert(entriesCover[1].startsWith("001"), `first real page is still 001: ${entriesCover[1]}`);
  }

  console.log("\n--- downloadChapterRangeAsCBZ with seriesCover (combined, cover appears once) ---");
  const combinedWithCoverPath = await downloadChapterRangeAsCBZ({
    urlType: "comic",
    slug: "our-guilds-idol",
    seriesTitle: "Cover Test",
    chapters: [
      { number: 1, title: "Chapter 1" },
      { number: 2, title: "Chapter 2" },
    ],
    seriesCover: "https://media.valirscans.org/series/cover-test.webp",
    outDir,
  });

  if (AdmZip) {
    const zipCombined = new AdmZip(combinedWithCoverPath);
    const entriesCombined = zipCombined.getEntries().map((e) => e.entryName).sort();
    assert(
      entriesCombined.length === 97,
      `97 entries (96 pages across 2 chapters + 1 cover), got ${entriesCombined.length}`
    );
    const coverEntries = entriesCombined.filter((n) => n.startsWith("0000-"));
    assert(coverEntries.length === 1, `cover appears exactly once, not per-chapter (got ${coverEntries.length})`);
    assert(entriesCombined[0] === coverEntries[0], `cover sorts before all chapter pages: ${entriesCombined[0]}`);
  }

  console.log("\n--- Cover fetch failure doesn't break the whole download ---");
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.includes("broken-cover")) {
      return { ok: false, status: 404 };
    }
    return originalFetch(url);
  };
  let coverFailureThrew = false;
  try {
    await downloadChapterAsCBZ({
      urlType: "comic",
      slug: "our-guilds-idol",
      seriesTitle: "Cover Fail Test",
      chapterNumber: 1,
      seriesCover: "https://media.valirscans.org/series/broken-cover.webp",
      outDir,
    });
  } catch {
    coverFailureThrew = true;
  }
  assert(!coverFailureThrew, "a failed cover fetch doesn't crash the whole chapter download");
  global.fetch = originalFetch;

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();
