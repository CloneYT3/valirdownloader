const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { fetchChapterPages } = require("./valirscans");

/**
 * Downloads every page image for a chapter and writes them, in order, into
 * a single CBZ file. CBZ is just a ZIP archive with sequentially-named
 * image files inside — readers sort by filename, so we zero-pad page
 * numbers to keep ordering correct beyond page 9.
 */
async function downloadChapterAsCBZ({
  urlType,
  slug,
  seriesTitle,
  chapterNumber,
  chapterTitle,
  seriesCover,
  outDir,
  onProgress,
}) {
  const pageUrls = await fetchChapterPages(urlType, slug, chapterNumber);

  if (pageUrls.length === 0) {
    throw new Error(`No pages found for chapter ${chapterNumber}`);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const safeTitle = sanitizeFilename(seriesTitle);
  const paddedChapter = String(chapterNumber).padStart(4, "0");
  const outPath = path.join(outDir, `${safeTitle} - Ch.${paddedChapter}.cbz`);

  const output = fs.createWriteStream(outPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const archiveDone = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);

  // Insert the series cover as page 000 — sorts before page 001, so
  // readers like Suwatte that thumbnail a CBZ by its first image show
  // the actual series cover instead of an arbitrary comic page.
  if (seriesCover) {
    try {
      const coverBuffer = await downloadImage(seriesCover);
      const coverExt = extensionFromUrl(seriesCover);
      archive.append(coverBuffer, { name: `000${coverExt}` });
    } catch (err) {
      // A failed cover fetch shouldn't sink the whole chapter download —
      // just skip the cover and continue with the actual pages.
      console.error(`Failed to fetch series cover for thumbnail: ${err.message}`);
    }
  }

  for (let i = 0; i < pageUrls.length; i++) {
    const pageUrl = pageUrls[i];
    const buffer = await downloadImage(pageUrl);
    const ext = extensionFromUrl(pageUrl);
    const pageNum = String(i + 1).padStart(3, "0");
    archive.append(buffer, { name: `${pageNum}${ext}` });

    if (onProgress) onProgress(i + 1, pageUrls.length);
  }

  await archive.finalize();
  await archiveDone;

  return outPath;
}

/**
 * Downloads multiple chapters and bundles them into ONE combined CBZ,
 * with pages namespaced by chapter so ordering stays correct across
 * chapter boundaries (e.g. "0001-001.jpg", "0002-001.jpg", ...).
 */
async function downloadChapterRangeAsCBZ({
  urlType,
  slug,
  seriesTitle,
  chapters, // array of { number, title }
  seriesCover,
  outDir,
  onProgress, // (chapterIndex, totalChapters, pageIndex, totalPages)
}) {
  fs.mkdirSync(outDir, { recursive: true });

  const safeTitle = sanitizeFilename(seriesTitle);
  const first = String(chapters[0].number).padStart(4, "0");
  const last = String(chapters[chapters.length - 1].number).padStart(4, "0");
  const rangeLabel = chapters.length === 1 ? `Ch.${first}` : `Ch.${first}-${last}`;
  const outPath = path.join(outDir, `${safeTitle} - ${rangeLabel}.cbz`);

  const output = fs.createWriteStream(outPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  const archiveDone = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);

  // Series cover goes first, once, regardless of how many chapters are
  // combined into this file — sorts before any chapter's page 001.
  if (seriesCover) {
    try {
      const coverBuffer = await downloadImage(seriesCover);
      const coverExt = extensionFromUrl(seriesCover);
      archive.append(coverBuffer, { name: `0000-000${coverExt}` });
    } catch (err) {
      console.error(`Failed to fetch series cover for thumbnail: ${err.message}`);
    }
  }

  for (let c = 0; c < chapters.length; c++) {
    const chapter = chapters[c];
    const pageUrls = await fetchChapterPages(urlType, slug, chapter.number);
    const chapterPrefix = String(chapter.number).padStart(4, "0");

    for (let i = 0; i < pageUrls.length; i++) {
      const buffer = await downloadImage(pageUrls[i]);
      const ext = extensionFromUrl(pageUrls[i]);
      const pageNum = String(i + 1).padStart(3, "0");
      archive.append(buffer, { name: `${chapterPrefix}-${pageNum}${ext}` });

      if (onProgress) onProgress(c + 1, chapters.length, i + 1, pageUrls.length);
    }
  }

  await archive.finalize();
  await archiveDone;

  return outPath;
}

async function downloadImage(url) {
  // Same reasoning as valirscans.js: no fake User-Agent, since a spoofed
  // one without matching browser signals gets a 403 here.
  const res = await fetch(url, {
    headers: {
      Referer: "https://valirscans.org/",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to download image ${url}: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function extensionFromUrl(url) {
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? `.${match[1]}` : ".jpg";
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

module.exports = {
  downloadChapterAsCBZ,
  downloadChapterRangeAsCBZ,
};
