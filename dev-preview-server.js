/**
 * DEV-ONLY: boots the real server/index.js with global.fetch mocked
 * against captured fixtures, so we can screenshot a populated UI without
 * needing real network access. Not part of the shipped product.
 */
const fs = require("fs");
const path = require("path");

const FIXTURES = path.join(__dirname, "test-fixtures");
const listingHTML = fs.readFileSync(path.join(FIXTURES, "listing.html"), "utf-8");
const seriesHTML = fs.readFileSync(path.join(FIXTURES, "series.html"), "utf-8");
const chapterHTML = fs.readFileSync(path.join(FIXTURES, "chapter.html"), "utf-8");

const realFetch = global.fetch;

global.fetch = async (url, ...rest) => {
  const urlStr = String(url);
  if (urlStr.startsWith("http://localhost")) return realFetch(url, ...rest);

  if (urlStr.includes("media.valirscans.org") || urlStr.includes("/uploads/")) {
    // Let real cover-image URLs through to the real CDN so screenshots
    // show actual cover art instead of broken image icons.
    return realFetch(url, ...rest);
  }
  if (urlStr.includes("/chapter/")) return { ok: true, status: 200, text: async () => chapterHTML };
  if (urlStr.includes("/series/comic/our-guilds-idol")) return { ok: true, status: 200, text: async () => seriesHTML };
  if (urlStr.includes("/series")) {
    const pageMatch = urlStr.match(/page=(\d+)/);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    return { ok: true, status: 200, text: async () => (page === 1 ? listingHTML : "<html><body></body></html>") };
  }
  throw new Error(`Unmocked URL in dev preview: ${urlStr}`);
};

require("./server/index.js");
