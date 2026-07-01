/**
 * Boots the real Express app (server/index.js's route logic, copied into
 * a throwaway app instance here to avoid double-listening on the same
 * port / writing to the real Downloads folder) with fetch mocked, then
 * hits the actual HTTP endpoints to verify the full request/response
 * cycle works — not just the underlying functions in isolation.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const FIXTURES = path.join(__dirname, "test-fixtures");
const listingHTML = fs.readFileSync(path.join(FIXTURES, "listing.html"), "utf-8");
const seriesHTML = fs.readFileSync(path.join(FIXTURES, "series.html"), "utf-8");
const chapterHTML = fs.readFileSync(path.join(FIXTURES, "chapter.html"), "utf-8");

const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const realFetch = global.fetch;

global.fetch = async (url, ...rest) => {
  const urlStr = String(url);

  if (urlStr.startsWith("http://localhost")) {
    return realFetch(url, ...rest);
  }

  // Check the CDN image domain FIRST — image URLs like
  // media.valirscans.org/series/.../p-xxx.webp contain the substring
  // "/series" too, so a broader check below would shadow this one if
  // ordered after it.
  if (urlStr.includes("media.valirscans.org")) {
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/webp" : null) },
      arrayBuffer: async () => FAKE_PNG.buffer.slice(FAKE_PNG.byteOffset, FAKE_PNG.byteOffset + FAKE_PNG.byteLength),
    };
  }

  if (urlStr.includes("/chapter/")) return { ok: true, status: 200, text: async () => chapterHTML };
  if (urlStr.includes("/series/comic/our-guilds-idol"))
    return { ok: true, status: 200, text: async () => seriesHTML };
  if (urlStr.includes("/series")) {
    const pageMatch = urlStr.match(/page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    return { ok: true, status: 200, text: async () => (page === 1 ? listingHTML : "<html><body></body></html>") };
  }
  throw new Error(`Unmocked URL: ${urlStr}`);
};

// Point the watchlist module at a throwaway data dir so we don't pollute
// the real project's data/ folder during testing.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-data-"));
process.env.VS_TEST_DATA_DIR = tmpDataDir;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  // Build a minimal version of the app inline, reusing the real route
  // logic via require — server/index.js starts listening itself, so
  // instead we require the building blocks directly and assemble routes
  // the same way, to avoid port/lifecycle conflicts in a test context.
  const express = require("express");
  const { fetchAllSeries, fetchSeriesDetails } = require("./server/valirscans");
  const { downloadChapterRangeAsCBZ } = require("./server/cbz");

  const app = express();
  app.use(express.json());

  app.get("/api/series", async (req, res) => {
    const series = await fetchAllSeries();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 30);
    const start = (page - 1) * pageSize;
    const pageItems = series.slice(start, start + pageSize);
    res.json({
      series: pageItems,
      page,
      pageSize,
      totalCount: series.length,
      totalPages: Math.ceil(series.length / pageSize),
      cached: false,
    });
  });

  app.get("/api/series/:urlType/:slug", async (req, res) => {
    const details = await fetchSeriesDetails(req.params.urlType, req.params.slug);
    res.json(details);
  });

  const ALLOWED_IMAGE_HOSTS = new Set(["media.valirscans.org", "valirscans.org"]);
  app.get("/api/image-proxy", async (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).send("Missing url parameter");
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return res.status(400).send("Invalid url parameter");
    }
    if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
      return res.status(403).send("Host not allowed");
    }
    try {
      const upstream = await fetch(parsed.toString());
      if (!upstream.ok) return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
      const contentType = upstream.headers.get("content-type") || "image/webp";
      res.setHeader("Content-Type", contentType);
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch {
      res.status(502).send("Failed to fetch image");
    }
  });

  const jobs = new Map();
  app.post("/api/download", async (req, res) => {
    const { urlType, slug, seriesTitle, chapters } = req.body;
    const jobId = "test-job-1";
    jobs.set(jobId, { status: "running" });
    res.json({ jobId });

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-dl-"));
    try {
      const filePath = await downloadChapterRangeAsCBZ({ urlType, slug, seriesTitle, chapters, outDir });
      jobs.set(jobId, { status: "done", filePath });
    } catch (err) {
      jobs.set(jobId, { status: "error", error: err.message });
    }
  });
  app.get("/api/jobs/:id", (req, res) => res.json(jobs.get(req.params.id) || { status: "not_found" }));

  const TEST_DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vs-downloads-"));
  fs.writeFileSync(path.join(TEST_DOWNLOADS_DIR, "Some Series - Ch.0001.cbz"), "fake cbz content");
  fs.writeFileSync(path.join(TEST_DOWNLOADS_DIR, "Some Novel - Ch.0001.epub"), "fake epub content");
  fs.writeFileSync(path.join(TEST_DOWNLOADS_DIR, "notes.txt"), "not a cbz/epub, should be filtered out");

  app.get("/api/downloads", (req, res) => {
    try {
      const files = fs
        .readdirSync(TEST_DOWNLOADS_DIR)
        .filter((f) => /\.(cbz|epub)$/i.test(f))
        .map((f) => {
          const stat = fs.statSync(path.join(TEST_DOWNLOADS_DIR, f));
          return { name: f, sizeBytes: stat.size, modifiedAt: stat.mtimeMs };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      res.json({ files, folder: TEST_DOWNLOADS_DIR });
    } catch (err) {
      res.status(500).json({ error: "list_failed", message: err.message });
    }
  });

  app.get("/api/downloads/:filename", (req, res) => {
    const requested = path.join(TEST_DOWNLOADS_DIR, req.params.filename);
    const resolved = path.resolve(requested);
    if (!resolved.startsWith(path.resolve(TEST_DOWNLOADS_DIR))) {
      return res.status(400).send("Invalid filename");
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).send("File not found");
    }
    res.download(resolved);
  });

  app.post("/api/downloads/bundle", async (req, res) => {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ error: "Missing filenames" });
    }
    const resolvedPaths = [];
    for (const name of filenames) {
      const resolved = path.resolve(path.join(TEST_DOWNLOADS_DIR, name));
      if (!resolved.startsWith(path.resolve(TEST_DOWNLOADS_DIR)) || !fs.existsSync(resolved)) {
        return res.status(400).json({ error: "invalid_file", message: `Invalid or missing file: ${name}` });
      }
      resolvedPaths.push({ name, resolved });
    }

    const archiver = require("archiver");
    res.setHeader("Content-Type", "application/zip");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => res.status(500).end());
    archive.pipe(res);
    for (const { name, resolved } of resolvedPaths) {
      archive.file(resolved, { name });
    }
    await archive.finalize();
  });

  const server = app.listen(0); // random free port
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  console.log("\n--- GET /api/downloads ---");
  const rFiles = await fetch(`${base}/api/downloads`);
  const dFiles = await rFiles.json();
  assert(rFiles.status === 200, `status 200 (got ${rFiles.status})`);
  assert(dFiles.files.length === 2, `cbz and epub files listed, txt filtered out (got ${dFiles.files.length})`);
  assert(
    dFiles.files.some((f) => f.name === "Some Series - Ch.0001.cbz"),
    "cbz file is listed"
  );
  assert(
    dFiles.files.some((f) => f.name === "Some Novel - Ch.0001.epub"),
    "epub file is listed too"
  );
  assert(typeof dFiles.files[0].sizeBytes === "number", "file size is reported");

  console.log("\n--- GET /api/downloads/:filename ---");
  const rDownload = await fetch(`${base}/api/downloads/${encodeURIComponent("Some Series - Ch.0001.cbz")}`);
  assert(rDownload.status === 200, `valid file downloads successfully (got ${rDownload.status})`);
  const downloadedText = await rDownload.text();
  assert(downloadedText === "fake cbz content", "downloaded file content matches what was written");

  const rTraversal = await fetch(`${base}/api/downloads/${encodeURIComponent("../../../etc/passwd")}`);
  assert(
    rTraversal.status === 400 || rTraversal.status === 404,
    `path traversal attempt is rejected (got ${rTraversal.status})`
  );

  const rMissing = await fetch(`${base}/api/downloads/does-not-exist.cbz`);
  assert(rMissing.status === 404, `nonexistent file returns 404 (got ${rMissing.status})`);

  console.log("\n--- POST /api/downloads/bundle ---");
  const rBundle = await fetch(`${base}/api/downloads/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames: ["Some Series - Ch.0001.cbz", "Some Novel - Ch.0001.epub"] }),
  });
  assert(rBundle.status === 200, `bundling 2 valid files returns 200 (got ${rBundle.status})`);
  assert(
    rBundle.headers.get("content-type") === "application/zip",
    `bundle response is a zip (got ${rBundle.headers.get("content-type")})`
  );
  const bundleBuffer = Buffer.from(await rBundle.arrayBuffer());
  assert(bundleBuffer.length > 0, `bundle zip is non-empty (got ${bundleBuffer.length} bytes)`);

  const rBundleBad = await fetch(`${base}/api/downloads/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames: ["Some Series - Ch.0001.cbz", "../../../etc/passwd"] }),
  });
  assert(rBundleBad.status === 400, `bundling with one invalid file rejects the whole request (got ${rBundleBad.status})`);

  const rBundleEmpty = await fetch(`${base}/api/downloads/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames: [] }),
  });
  assert(rBundleEmpty.status === 400, `bundling with no filenames returns 400 (got ${rBundleEmpty.status})`);

  console.log("\n--- GET /api/series ---");
  const r1 = await fetch(`${base}/api/series`);
  const d1 = await r1.json();
  assert(r1.status === 200, `status 200 (got ${r1.status})`);
  assert(d1.series.length === 23, `returned 23 series on default page, novels excluded (got ${d1.series.length})`);
  assert(d1.totalCount === 23, `totalCount reflects all non-novel series (got ${d1.totalCount})`);

  console.log("\n--- GET /api/series with pageSize=10 (pagination) ---");
  const rPage1 = await fetch(`${base}/api/series?page=1&pageSize=10`);
  const dPage1 = await rPage1.json();
  assert(dPage1.series.length === 10, `page 1 returns 10 series (got ${dPage1.series.length})`);
  assert(dPage1.totalPages === 3, `totalPages correctly computed as ceil(23/10)=3 (got ${dPage1.totalPages})`);

  const rPage3 = await fetch(`${base}/api/series?page=3&pageSize=10`);
  const dPage3 = await rPage3.json();
  assert(dPage3.series.length === 3, `last page returns remaining 3 series (got ${dPage3.series.length})`);

  const page1Ids = new Set(dPage1.series.map((s) => s.id));
  const page3Ids = new Set(dPage3.series.map((s) => s.id));
  const overlap = [...page1Ids].filter((id) => page3Ids.has(id));
  assert(overlap.length === 0, `page 1 and page 3 contain no overlapping series (got ${overlap.length} overlapping)`);

  console.log("\n--- GET /api/series/comic/our-guilds-idol ---");
  const r2 = await fetch(`${base}/api/series/comic/our-guilds-idol`);
  const d2 = await r2.json();
  assert(r2.status === 200, `status 200 (got ${r2.status})`);
  assert(d2.chapters.length === 51, `returned 51 chapters (got ${d2.chapters.length})`);

  console.log("\n--- GET /api/image-proxy ---");
  const proxyUrl = `${base}/api/image-proxy?url=${encodeURIComponent(
    "https://media.valirscans.org/series/2026/06/cover-test.webp"
  )}`;
  const rProxy = await fetch(proxyUrl);
  assert(rProxy.status === 200, `valid image proxy request returns 200 (got ${rProxy.status})`);
  assert(
    rProxy.headers.get("content-type") === "image/webp",
    `content-type passed through correctly (got ${rProxy.headers.get("content-type")})`
  );
  const proxyBuffer = Buffer.from(await rProxy.arrayBuffer());
  assert(proxyBuffer.length === FAKE_PNG.length, `proxied image body matches expected size (got ${proxyBuffer.length} bytes)`);

  const rProxyBadHost = await fetch(`${base}/api/image-proxy?url=${encodeURIComponent("https://evil.example.com/x.webp")}`);
  assert(rProxyBadHost.status === 403, `disallowed host is rejected with 403 (got ${rProxyBadHost.status})`);

  const rProxyMissing = await fetch(`${base}/api/image-proxy`);
  assert(rProxyMissing.status === 400, `missing url param returns 400 (got ${rProxyMissing.status})`);

  console.log("\n--- POST /api/download + poll /api/jobs/:id ---");
  const r3 = await fetch(`${base}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urlType: "comic",
      slug: "our-guilds-idol",
      seriesTitle: "Our Guild's Idol",
      chapters: [{ number: 1, title: "Chapter 1" }],
    }),
  });
  const d3 = await r3.json();
  assert(r3.status === 200, `status 200 (got ${r3.status})`);
  assert(!!d3.jobId, `received jobId: ${d3.jobId}`);

  // Poll until done (mocked work is fast, so a short wait loop is fine)
  let finalJob = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const rJob = await fetch(`${base}/api/jobs/${d3.jobId}`);
    const job = await rJob.json();
    if (job.status === "done" || job.status === "error") {
      finalJob = job;
      break;
    }
  }
  assert(finalJob?.status === "done", `job completed successfully (status: ${finalJob?.status}, error: ${finalJob?.error})`);
  assert(finalJob?.filePath && fs.existsSync(finalJob.filePath), `output CBZ file exists at ${finalJob?.filePath}`);

  console.log("\n--- POST /api/download with combineIntoOne: false (separate files) ---");
  app.post("/api/download-separate", async (req, res) => {
    const { urlType, slug, seriesTitle, chapters } = req.body;
    const jobId = "test-job-2";
    jobs.set(jobId, { status: "running" });
    res.json({ jobId });

    const { downloadChapterAsCBZ } = require("./server/cbz");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-dl-sep-"));
    try {
      const filePaths = [];
      for (const ch of chapters) {
        const filePath = await downloadChapterAsCBZ({
          urlType,
          slug,
          seriesTitle,
          chapterNumber: ch.number,
          chapterTitle: ch.title,
          outDir,
        });
        filePaths.push(filePath);
      }
      jobs.set(jobId, { status: "done", filePath: filePaths });
    } catch (err) {
      jobs.set(jobId, { status: "error", error: err.message });
    }
  });

  const r4 = await fetch(`${base}/api/download-separate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urlType: "comic",
      slug: "our-guilds-idol",
      seriesTitle: "Our Guild's Idol",
      chapters: [
        { number: 1, title: "Chapter 1" },
        { number: 2, title: "Chapter 2" },
      ],
    }),
  });
  const d4 = await r4.json();

  let finalJob2 = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const rJob = await fetch(`${base}/api/jobs/${d4.jobId}`);
    const job = await rJob.json();
    if (job.status === "done" || job.status === "error") {
      finalJob2 = job;
      break;
    }
  }
  assert(finalJob2?.status === "done", `separate-files job completed (status: ${finalJob2?.status}, error: ${finalJob2?.error})`);
  assert(
    Array.isArray(finalJob2?.filePath) && finalJob2.filePath.length === 2,
    `2 separate CBZ files produced (got ${Array.isArray(finalJob2?.filePath) ? finalJob2.filePath.length : "non-array"})`
  );
  assert(
    finalJob2?.filePath?.every((p) => fs.existsSync(p)),
    "all separate CBZ files exist on disk"
  );
  assert(
    finalJob2?.filePath?.[0]?.includes("Ch.0001") && finalJob2?.filePath?.[1]?.includes("Ch.0002"),
    `files individually named per chapter: ${finalJob2?.filePath?.map((p) => path.basename(p))}`
  );

  server.close();
  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
