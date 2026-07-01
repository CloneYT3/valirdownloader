const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const archiver = require("archiver");

const { fetchAllSeries, fetchSeriesDetails, fetchAvailableGenres } = require("./valirscans");
const { downloadChapterAsCBZ, downloadChapterRangeAsCBZ } = require("./cbz");
const { downloadNovelChaptersAsEPUB } = require("./epub");
const watchlist = require("./watchlist");
const settings = require("./settings");
const progress = require("./progress");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads", "ValirScans CBZ");
const TMP_DIR = path.join(__dirname, "..", "data", "tmp");
const SERIES_CACHE_PATH = path.join(__dirname, "..", "data", "series-cache.json");

// ---- Series cache (avoid re-scraping the listing on every load) ----
// Kept in memory for fast access, but also persisted to disk so a
// server restart doesn't force a full re-scrape — only the TTL expiring
// does that.
let seriesCache = null;
let seriesCacheTime = 0;
const SERIES_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function loadSeriesCacheFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(SERIES_CACHE_PATH, "utf-8"));
    seriesCache = raw.series;
    seriesCacheTime = raw.cachedAt;
    console.log(`Loaded cached series list from disk (${seriesCache.length} series, cached ${new Date(seriesCacheTime).toLocaleString()})`);
  } catch {
    // No cache on disk yet, or it's corrupt — fine, a normal scrape will populate it.
  }
}

function saveSeriesCacheToDisk(series, cachedAt) {
  try {
    fs.mkdirSync(path.dirname(SERIES_CACHE_PATH), { recursive: true });
    fs.writeFileSync(SERIES_CACHE_PATH, JSON.stringify({ series, cachedAt }));
  } catch (err) {
    console.error("Failed to write series cache to disk:", err.message);
  }
}

loadSeriesCacheFromDisk();

// ---------------------------------------------------------------------
// Image proxy
//
// ValirScans' CDN (media.valirscans.org) sends a Cross-Origin-Resource-
// Policy header that blocks browsers from loading its images when
// embedded in a page on a different origin (like our localhost app).
// Node's fetch isn't a browser and doesn't enforce CORP, so routing
// image requests through our own server sidesteps the block entirely.
// ---------------------------------------------------------------------
const ALLOWED_IMAGE_HOSTS = new Set(["media.valirscans.org", "valirscans.org"]);
const IMAGE_CACHE_DIR = path.join(__dirname, "..", "data", "image-cache");
fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });

function cacheKeyForUrl(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

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

  const cacheKey = cacheKeyForUrl(parsed.toString());
  const cachePath = path.join(IMAGE_CACHE_DIR, cacheKey);
  const cacheMetaPath = `${cachePath}.json`;

  // Serve straight from disk if we've already fetched this exact image —
  // skips the network entirely on repeat visits to the shelf.
  if (fs.existsSync(cachePath) && fs.existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf-8"));
      res.setHeader("Content-Type", meta.contentType || "image/webp");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Cache", "HIT");
      return res.send(fs.readFileSync(cachePath));
    } catch {
      // Corrupt cache entry — fall through and re-fetch from network.
    }
  }

  try {
    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type") || "image/webp";
    const buffer = Buffer.from(await upstream.arrayBuffer());

    // Write to cache (best-effort — a failed write shouldn't break the
    // response the user is actually waiting on).
    try {
      fs.writeFileSync(cachePath, buffer);
      fs.writeFileSync(cacheMetaPath, JSON.stringify({ contentType, cachedAt: Date.now() }));
    } catch (cacheErr) {
      console.error("Image cache write failed:", cacheErr.message);
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // images don't change once published
    res.setHeader("X-Cache", "MISS");
    res.send(buffer);
  } catch (err) {
    res.status(502).send("Failed to fetch image");
  }
});

// ---- In-memory job tracking for download progress ----
const jobs = new Map(); // jobId -> { status, progress, error, filePath }

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: "pending", progress: { current: 0, total: 0 }, error: null, filePath: null });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) jobs.set(id, { ...job, ...patch });
}

// ---------------------------------------------------------------------
// Series listing (browse all)
// ---------------------------------------------------------------------
app.get("/api/series", async (req, res) => {
  try {
    const now = Date.now();
    let series;
    if (seriesCache && now - seriesCacheTime < SERIES_CACHE_TTL_MS) {
      series = seriesCache;
    } else {
      series = await fetchAllSeries();
      seriesCache = series;
      seriesCacheTime = now;
      saveSeriesCacheToDisk(series, now);
    }

    let filtered = series;

    if (req.query.genre) {
      filtered = filtered.filter((s) => (s.genres || []).includes(req.query.genre));
    }
    if (req.query.type) {
      // Frontend sends the same display values stored on each series
      // (MANHWA / MANGA / MANHUA / WEB NOVEL), so this is a direct match.
      filtered = filtered.filter((s) => s.type === req.query.type);
    }
    if (req.query.status) {
      filtered = filtered.filter((s) => s.status === req.query.status);
    }

    const sortBy = req.query.sortBy || "updated";
    const sorted = filtered.slice().sort((a, b) => {
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

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(req.query.pageSize, 10) || 30);
    const start = (page - 1) * pageSize;
    const pageItems = sorted.slice(start, start + pageSize);

    res.json({
      series: pageItems,
      page,
      pageSize,
      totalCount: sorted.length,
      totalPages: Math.ceil(sorted.length / pageSize) || 1,
      cached: seriesCache === series,
    });
  } catch (err) {
    handleScrapeError(res, err);
  }
});

// ---------------------------------------------------------------------
// Downloaded files (for grabbing finished CBZs from another device,
// e.g. your phone, over the same Wi-Fi — no cable or AirDrop needed)
// ---------------------------------------------------------------------
app.get("/api/downloads", (req, res) => {
  try {
    const files = fs
      .readdirSync(DOWNLOADS_DIR)
      .filter((f) => /\.(cbz|epub)$/i.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
        return { name: f, sizeBytes: stat.size, modifiedAt: stat.mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    res.json({ files, folder: DOWNLOADS_DIR });
  } catch (err) {
    res.status(500).json({ error: "list_failed", message: err.message });
  }
});

app.get("/api/downloads/:filename", (req, res) => {
  // Resolve and verify the path stays inside DOWNLOADS_DIR — without
  // this check, a crafted filename like "../../../etc/passwd" could
  // walk outside the intended folder.
  const requested = path.join(DOWNLOADS_DIR, req.params.filename);
  const resolved = path.resolve(requested);
  if (!resolved.startsWith(path.resolve(DOWNLOADS_DIR))) {
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

  // Validate every requested file stays inside DOWNLOADS_DIR and
  // actually exists before bundling — same path-traversal protection as
  // the single-file route, applied to each entry.
  const resolvedPaths = [];
  for (const name of filenames) {
    const resolved = path.resolve(path.join(DOWNLOADS_DIR, name));
    if (!resolved.startsWith(path.resolve(DOWNLOADS_DIR)) || !fs.existsSync(resolved)) {
      return res.status(400).json({ error: "invalid_file", message: `Invalid or missing file: ${name}` });
    }
    resolvedPaths.push({ name, resolved });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="ValirScans Files.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    console.error("Bundle zip error:", err.message);
    res.status(500).end();
  });
  archive.pipe(res);

  for (const { name, resolved } of resolvedPaths) {
    archive.file(resolved, { name });
  }
  await archive.finalize();
});

app.get("/api/genres", async (req, res) => {
  try {
    const genres = await fetchAvailableGenres();
    res.json({ genres });
  } catch (err) {
    handleScrapeError(res, err);
  }
});

app.get("/api/progress", (req, res) => {
  res.json(progress.getProgress());
});

app.post("/api/progress", (req, res) => {
  const { seriesId, status, title, cover } = req.body || {};
  if (!seriesId || !status) {
    return res.status(400).json({ error: "Missing seriesId or status" });
  }
  const updated = progress.setStatus(seriesId, status, { title, cover });
  res.json(updated);
});

app.get("/api/settings", (req, res) => {
  res.json(settings.getSettings());
});

app.post("/api/settings", (req, res) => {
  const updated = settings.updateSettings(req.body || {});
  res.json(updated);
});

app.post("/api/series/refresh", async (req, res) => {
  try {
    const series = await fetchAllSeries();
    seriesCache = series;
    seriesCacheTime = Date.now();
    saveSeriesCacheToDisk(series, seriesCacheTime);
    res.json({ ok: true, totalCount: series.length });
  } catch (err) {
    handleScrapeError(res, err);
  }
});

// ---------------------------------------------------------------------
// Series details + chapter list
// ---------------------------------------------------------------------
app.get("/api/series/:urlType/:slug", async (req, res) => {
  try {
    const { urlType, slug } = req.params;
    const details = await fetchSeriesDetails(urlType, slug);
    res.json(details);
  } catch (err) {
    handleScrapeError(res, err);
  }
});

// ---------------------------------------------------------------------
// Download a chapter range as CBZ (async job + polling for progress)
// ---------------------------------------------------------------------
app.post("/api/download", async (req, res) => {
  const { urlType, slug, seriesTitle, seriesCover, chapters, combineIntoOne, splitSize } = req.body;

  if (!urlType || !slug || !seriesTitle || !Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: "Missing or invalid download parameters" });
  }

  const jobId = createJob();
  res.json({ jobId });

  // Split the selected chapters into groups, each becoming its own
  // output file. splitSize of 0/undefined means "one group" (i.e.
  // respect combineIntoOne/separate-files as before); a positive
  // splitSize groups N chapters per file regardless of combineIntoOne.
  const sortedChapters = chapters.slice().sort((a, b) => a.number - b.number);
  const groups =
    splitSize && splitSize > 0 ? chunkArray(sortedChapters, splitSize) : [sortedChapters];

  // Run the actual download in the background; client polls /api/jobs/:id
  (async () => {
    try {
      updateJob(jobId, { status: "running" });
      const filePaths = [];

      if (urlType === "novel") {
        for (let g = 0; g < groups.length; g++) {
          const group = groups[g];
          const filePath = await downloadNovelChaptersAsEPUB({
            slug,
            seriesTitle,
            seriesCover,
            chapters: group,
            outDir: DOWNLOADS_DIR,
            onProgress: (cIdx, cTotal) => {
              updateJob(jobId, {
                progress: {
                  current: g + 1,
                  total: groups.length,
                  page: cIdx,
                  pageTotal: cTotal,
                  label: `File ${g + 1}/${groups.length} — chapter ${cIdx}/${cTotal}`,
                },
              });
            },
          });
          filePaths.push(filePath);
        }
        updateJob(jobId, { status: "done", filePath: filePaths.length === 1 ? filePaths[0] : filePaths });
        return;
      }

      for (let g = 0; g < groups.length; g++) {
        const group = groups[g];

        if (combineIntoOne || group.length === 1) {
          const filePath = await downloadChapterRangeAsCBZ({
            urlType,
            slug,
            seriesTitle,
            chapters: group,
            seriesCover,
            outDir: DOWNLOADS_DIR,
            onProgress: (cIdx, cTotal, pIdx, pTotal) => {
              updateJob(jobId, {
                progress: {
                  current: g + 1,
                  total: groups.length,
                  page: pIdx,
                  pageTotal: pTotal,
                  label: `File ${g + 1}/${groups.length} — chapter ${cIdx}/${cTotal}, page ${pIdx}/${pTotal}`,
                },
              });
            },
          });
          filePaths.push(filePath);
        } else {
          for (let i = 0; i < group.length; i++) {
            const ch = group[i];
            const filePath = await downloadChapterAsCBZ({
              urlType,
              slug,
              seriesTitle,
              chapterNumber: ch.number,
              chapterTitle: ch.title,
              seriesCover,
              outDir: DOWNLOADS_DIR,
              onProgress: (pIdx, pTotal) => {
                updateJob(jobId, {
                  progress: {
                    current: i + 1,
                    total: group.length,
                    page: pIdx,
                    pageTotal: pTotal,
                    label: `Chapter ${i + 1}/${group.length} — page ${pIdx}/${pTotal}`,
                  },
                });
              },
            });
            filePaths.push(filePath);
          }
        }
      }

      updateJob(jobId, { status: "done", filePath: filePaths.length === 1 ? filePaths[0] : filePaths });
    } catch (err) {
      updateJob(jobId, { status: "error", error: err.message });
    }
  })();
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ---------------------------------------------------------------------
// Watchlist + notifications
// ---------------------------------------------------------------------
app.get("/api/watchlist", (req, res) => {
  res.json(watchlist.getWatchlist());
});

app.post("/api/watchlist", async (req, res) => {
  try {
    const { urlType, slug } = req.body;
    const details = await fetchSeriesDetails(urlType, slug);
    const latestChapter = details.chapters.length
      ? Math.max(...details.chapters.map((c) => c.number))
      : 0;

    watchlist.addToWatchlist(details.id, {
      title: details.title,
      urlType,
      slug,
      lastSeenChapter: latestChapter,
    });

    res.json({ ok: true });
  } catch (err) {
    handleScrapeError(res, err);
  }
});

app.delete("/api/watchlist/:seriesId", (req, res) => {
  watchlist.removeFromWatchlist(decodeURIComponent(req.params.seriesId));
  res.json({ ok: true });
});

app.get("/api/notifications", (req, res) => {
  res.json(watchlist.getNotifications());
});

app.post("/api/notifications/mark-seen", (req, res) => {
  watchlist.markNotificationsSeen();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
function handleScrapeError(res, err) {
  if (err.message && err.message.startsWith("CLOUDFLARE_CHALLENGE")) {
    return res.status(503).json({
      error: "cloudflare",
      message:
        "ValirScans is showing a Cloudflare challenge page. Open valirscans.org in your regular browser, solve the challenge, then try again here.",
    });
  }
  if (err.message && /failed with status 403/i.test(err.message)) {
    return res.status(503).json({
      error: "blocked",
      message:
        "ValirScans rejected this request (403). This usually means Cloudflare is blocking it. Try again in a minute — if it keeps happening, open valirscans.org in your regular browser first.",
    });
  }
  if (err.message && /failed with status|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(err.message)) {
    return res.status(503).json({
      error: "network",
      message:
        "Couldn't reach ValirScans. Check your internet connection, or that valirscans.org isn't down, then try again.",
    });
  }
  console.error(err);
  res.status(500).json({ error: "scrape_failed", message: err.message });
}

// ---------------------------------------------------------------------
const PORT = process.env.PORT || 4173;

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

app.listen(PORT, () => {
  console.log(`\nValirScans Downloader running at:`);
  console.log(`  http://localhost:${PORT}\n`);
  printLANAddress(PORT);

  // Background watchlist polling — only while this process is alive.
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
  setInterval(() => {
    watchlist.checkWatchlistForUpdates((msg) => console.log(`[watchlist] ${msg}`));
  }, CHECK_INTERVAL_MS);
});

function printLANAddress(port) {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`On your iPhone (same Wi-Fi), open:`);
        console.log(`  http://${iface.address}:${port}\n`);
      }
    }
  }
}
