const fs = require("fs");
const path = require("path");
const epub = require("epub-gen-memory").default;
const { fetchNovelChapterText } = require("./valirscans");

/**
 * Downloads a range of novel chapters and bundles them into a single
 * EPUB file, in chapter order. Each chapter becomes its own EPUB
 * chapter/section so reading apps show a proper table of contents.
 */
async function downloadNovelChaptersAsEPUB({
  slug,
  seriesTitle,
  seriesCover,
  chapters, // array of { number, title }
  outDir,
  onProgress, // (chapterIndex, totalChapters)
}) {
  fs.mkdirSync(outDir, { recursive: true });

  const epubChapters = [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const { text } = await fetchNovelChapterText(slug, ch.number);

    epubChapters.push({
      title: ch.title || `Chapter ${ch.number}`,
      content: text,
    });

    if (onProgress) onProgress(i + 1, chapters.length);
  }

  const buffer = await epub(
    {
      title: seriesTitle,
      author: "ValirScans",
      cover: seriesCover || undefined,
      tocTitle: "Chapters",
    },
    epubChapters
  );

  const safeTitle = sanitizeFilename(seriesTitle);
  const first = String(chapters[0].number).padStart(4, "0");
  const last = String(chapters[chapters.length - 1].number).padStart(4, "0");
  const rangeLabel = chapters.length === 1 ? `Ch.${first}` : `Ch.${first}-${last}`;
  const outPath = path.join(outDir, `${safeTitle} - ${rangeLabel}.epub`);

  fs.writeFileSync(outPath, buffer);
  return outPath;
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

module.exports = { downloadNovelChaptersAsEPUB };
