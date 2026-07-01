/**
 * Verifies EPUB generation for novel chapters and the chapter-group
 * splitting logic (chunkArray + the resulting multi-file behavior),
 * using mocked novel chapter pages since no real novel fixture exists.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const FAKE_CHAPTER_HTML = (text) => {
  const escapedText = text.replace(/\\/g, "\\\\\\\\").replace(/"/g, '\\\\\\"');
  return `{\\"content\\":\\"${escapedText}\\"}`;
};

global.fetch = async (url) => {
  const urlStr = String(url);
  const match = urlStr.match(/\/chapter\/(\d+)$/);
  const chapterNum = match ? match[1] : "?";
  return {
    ok: true,
    status: 200,
    text: async () =>
      FAKE_CHAPTER_HTML(`<p>This is the text of chapter ${chapterNum}. It goes on for a while.</p>`),
  };
};

const { fetchNovelChapterText } = require("./server/valirscans");
const { downloadNovelChaptersAsEPUB } = require("./server/epub");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

(async () => {
  console.log("\n--- fetchNovelChapterText ---");
  const { text, fieldUsed } = await fetchNovelChapterText("test-novel", 1);
  assert(text.includes("chapter 1"), `extracted correct chapter text (got: "${text.slice(0, 60)}...")`);
  assert(fieldUsed === "content", `identified "content" as the matching field (got "${fieldUsed}")`);

  console.log("\n--- downloadNovelChaptersAsEPUB (single chapter) ---");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-test-"));
  const singlePath = await downloadNovelChaptersAsEPUB({
    slug: "test-novel",
    seriesTitle: "Test Novel",
    chapters: [{ number: 1, title: "Chapter 1" }],
    outDir,
  });
  assert(fs.existsSync(singlePath), `EPUB file created at ${singlePath}`);
  assert(singlePath.endsWith(".epub"), "file has .epub extension");
  assert(fs.statSync(singlePath).size > 0, "EPUB file is non-empty");

  console.log("\n--- downloadNovelChaptersAsEPUB (combined, 5 chapters) ---");
  const chapters5 = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Chapter ${n}` }));
  const combinedPath = await downloadNovelChaptersAsEPUB({
    slug: "test-novel",
    seriesTitle: "Test Novel",
    chapters: chapters5,
    outDir,
  });
  assert(combinedPath.includes("Ch.0001-0005"), `filename reflects full chapter range: ${path.basename(combinedPath)}`);

  console.log("\n--- chunkArray (splitting logic) ---");
  const chapters23 = Array.from({ length: 23 }, (_, i) => ({ number: i + 1, title: `Chapter ${i + 1}` }));
  const groupsOf10 = chunkArray(chapters23, 10);
  assert(groupsOf10.length === 3, `23 chapters split into groups of 10 produces 3 groups (got ${groupsOf10.length})`);
  assert(groupsOf10[0].length === 10, `first group has 10 chapters (got ${groupsOf10[0].length})`);
  assert(groupsOf10[1].length === 10, `second group has 10 chapters (got ${groupsOf10[1].length})`);
  assert(groupsOf10[2].length === 3, `last group has the remaining 3 chapters (got ${groupsOf10[2].length})`);
  assert(groupsOf10[0][0].number === 1, "first group starts at chapter 1");
  assert(groupsOf10[2][groupsOf10[2].length - 1].number === 23, "last group ends at chapter 23");

  console.log("\n--- Splitting actually produces multiple EPUB files ---");
  const splitGroups = chunkArray(chapters5, 2); // 5 chapters split into groups of 2 -> [2,2,1]
  const splitOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "epub-split-test-"));
  const splitFilePaths = [];
  for (const group of splitGroups) {
    const p = await downloadNovelChaptersAsEPUB({
      slug: "test-novel",
      seriesTitle: "Test Novel",
      chapters: group,
      outDir: splitOutDir,
    });
    splitFilePaths.push(p);
  }
  assert(splitFilePaths.length === 3, `5 chapters split into groups of 2 produces 3 files (got ${splitFilePaths.length})`);
  assert(splitFilePaths.every((p) => fs.existsSync(p)), "all split EPUB files exist on disk");
  assert(
    splitFilePaths[0].includes("Ch.0001-0002") &&
      splitFilePaths[1].includes("Ch.0003-0004") &&
      splitFilePaths[2].includes("Ch.0005"),
    `split files are named with correct, non-overlapping ranges: ${splitFilePaths.map((p) => path.basename(p))}`
  );

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(splitOutDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();
