/**
 * ValirScans scraping module.
 *
 * This reuses the exact extraction approach validated in the Suwatte
 * runner project: ValirScans (Next.js App Router) embeds page data as
 * escaped JSON inside <script> tags rather than exposing a clean API.
 * See that project's README for the full writeup of why this approach
 * works and what's fragile about it.
 */
const BASE_URL = "https://valirscans.org";

// A realistic browser User-Agent reduces (but does not eliminate) the
// chance of tripping Cloudflare's challenge on every single request.
// NOTE: We deliberately do NOT set a fake browser User-Agent here.
// Testing showed ValirScans/Cloudflare returns 403 for requests with a
// spoofed Chrome User-Agent but no other matching browser signals (TLS
// fingerprint, full header set, cookies, etc.) — a plain request with no
// User-Agent override gets through fine, so we leave it to Node's
// default.
const DEFAULT_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/**
 * Finds the value belonging to `"key":` (in its escaped form, as it
 * appears literally in the raw document) and extracts just that value's
 * JSON span — whether it's an object or an array.
 */
function extractJSONValueForKey(html, key) {
  const marker = `\\"${key}\\":`;
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`Key "${key}" not found in page — site layout may have changed`);
  }

  const valueStart = markerIdx + marker.length;
  const firstChar = html[valueStart];
  if (firstChar !== "{" && firstChar !== "[") {
    throw new Error(
      `Expected key "${key}" to map to an object/array, found "${firstChar}" instead`
    );
  }

  const rawSlice = extractBalancedJSON(html, valueStart);
  const cleaned = unescapeEmbeddedJSON(rawSlice);
  return JSON.parse(cleaned);
}

/**
 * Like extractJSONValueForKey, but for plain string values rather than
 * objects/arrays — e.g. `"content":"<p>Some text...</p>"`. Needed for
 * novel chapter text, which is a string field, not a nested structure.
 */
function extractStringValueForKey(html, key) {
  const marker = `\\"${key}\\":`;
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`Key "${key}" not found in page`);
  }

  const valueStart = markerIdx + marker.length;
  if (html.slice(valueStart, valueStart + 2) !== '\\"') {
    throw new Error(`Expected key "${key}" to map to a string`);
  }

  // Scan forward from right after the opening \" for the matching
  // closing \" — distinguishing a real string-ending \" from a \\\"
  // (an escaped literal backslash followed by a quote that's actually
  // string content) by counting backslashes immediately preceding it.
  let i = valueStart + 2;
  while (i < html.length) {
    if (html[i] === "\\" && html[i + 1] === '"') {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && html[j] === "\\") {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) break;
    }
    i++;
  }

  const rawValue = html.slice(valueStart + 2, i);
  return unescapeEmbeddedJSON(rawValue);
}

function extractBalancedJSON(source, startIdx) {
  // Braces/brackets are never backslash-escaped in this format, only
  // quotes are — so plain counting works here (see runner README for why
  // string-aware counting actually breaks on this specific format).
  let depth = 0;
  let end = -1;

  for (let i = startIdx; i < source.length; i++) {
    const char = source[i];
    if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) {
    throw new Error("Could not find balanced JSON in source document");
  }

  return source.slice(startIdx, end);
}

function unescapeEmbeddedJSON(raw) {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

async function fetchHTML(url) {
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`Request to ${url} failed with status ${res.status}`);
  }
  const html = await res.text();

  // Cloudflare's interactive challenge page has a recognizable title; if
  // we land on it, every parse below will fail anyway, so surface a
  // clear, specific error instead of a confusing JSON parse error.
  if (html.includes("Just a moment...") || html.includes("cf-challenge")) {
    throw new Error(
      "CLOUDFLARE_CHALLENGE: ValirScans returned a Cloudflare challenge page instead of real content. Open https://valirscans.org in a real browser, solve the challenge, then try again."
    );
  }

  return html;
}

/**
 * Fetches every series across all listing pages. ValirScans paginates at
 * 24 results per page; we keep requesting subsequent pages until a short
 * page tells us we've reached the end.
 */
async function fetchAllSeries(onProgress) {
  const all = [];
  let page = 1;

  while (true) {
    const url = `${BASE_URL}/series?page=${page}`;
    const html = await fetchHTML(url);
    const { results, rawCount } = parseDirectoryHTML(html);

    all.push(...results);
    if (onProgress) onProgress(all.length);

    // Check the RAW count from ValirScans (before novel-filtering) to
    // decide whether this was the last page — filtering can make a
    // full 24-entry page look like only 23 results, which would
    // otherwise be mistaken for "fewer than a full page = the end."
    if (rawCount === 0 || rawCount < 24) break;
    page++;

    // Be a polite scraper — small delay between listing page requests.
    await sleep(400);
  }

  return all;
}

function parseDirectoryHTML(html) {
  let rawSeries;
  try {
    rawSeries = extractJSONValueForKey(html, "initialSeries");
  } catch (err) {
    if (err.message.includes("not found")) {
      // A page with no initialSeries data (e.g. past the last page) just
      // means there's nothing here — treat as an empty result, not an
      // error, so pagination terminates naturally.
      return { results: [], rawCount: 0 };
    }
    throw new Error(`Failed to parse directory listing: ${err.message}`);
  }

  const results = rawSeries
    .filter((s) => s.type !== "WEB_NOVEL") // Novels aren't supported — excluded from the shelf entirely.
    .map((s) => {
      const urlType = "comic"; // novels are filtered out above, so this is always comic now
      const cover = s.coverImage.startsWith("http") ? s.coverImage : `${BASE_URL}${s.coverImage}`;
      const genres = (s.genres || []).map((g) => g.genre?.slug).filter(Boolean);

      // The listing only includes each series' 3 most recent chapters,
      // not the full list — good enough to derive "latest chapter" (for
      // sort by recently updated) and an approximate chapter count,
      // without needing a separate request per series just to populate
      // filters.
      const recentChapters = s.chapters || [];
      const latestChapterNumber = recentChapters.length
        ? Math.max(...recentChapters.map((c) => c.number))
        : 0;
      const latestChapterDate = recentChapters.length
        ? recentChapters.reduce(
            (latest, c) => (!latest || new Date(c.publishedAt) > new Date(latest) ? c.publishedAt : latest),
            null
          )
        : null;

      return {
        id: `${urlType}/${s.slug}`,
        slug: s.slug,
        urlType,
        title: s.title,
        cover,
        type: s.type,
        status: s.status || null,
        rating: typeof s.rating === "number" ? s.rating : null,
        genres,
        latestChapterNumber,
        latestChapterDate,
        webUrl: `${BASE_URL}/series/${urlType}/${s.slug}`,
      };
    });

  // rawSeries.length (BEFORE the novel filter) is what tells us whether
  // this was a full page from ValirScans — using the post-filter count
  // here would make a full page that happens to contain a novel look
  // like a short/last page, prematurely stopping pagination.
  return { results, rawCount: rawSeries.length };
}

/**
 * Fetches full details + chapter list for one series.
 */
async function fetchSeriesDetails(urlType, slug) {
  const url = `${BASE_URL}/series/${urlType}/${slug}`;
  const html = await fetchHTML(url);

  // Comic pages use "series" as the top-level key (verified against real
  // captured pages). Novel pages weren't verified the same way, so if
  // "series" isn't found, try a few plausible alternates before giving
  // up with a diagnostic error instead of a confusing crash.
  let series;
  const candidateKeys = ["series", "novel", "novelSeries", "book"];
  let matchedKey = null;
  for (const key of candidateKeys) {
    try {
      series = extractJSONValueForKey(html, key);
      matchedKey = key;
      break;
    } catch {
      // try the next candidate
    }
  }

  if (!series) {
    // The useful data on these pages tends to live deep in the document
    // (tens to hundreds of KB in), not near the top — scanning the first
    // few KB (as an earlier version did) finds nothing useful. Anchor
    // near the "chapters" key instead, since that's present on both
    // comic and novel pages we've seen, and is a good proxy for "near
    // the actual series data."
    const chaptersIdx = html.indexOf('\\"chapters\\":');
    const windowStart = chaptersIdx !== -1 ? Math.max(0, chaptersIdx - 3000) : 0;
    const windowEnd = chaptersIdx !== -1 ? chaptersIdx : Math.min(html.length, 5000);
    const keysFound = [...html.slice(windowStart, windowEnd).matchAll(/\\"([a-zA-Z]+)\\":/g)].map((m) => m[1]);
    const uniqueKeys = [...new Set(keysFound)].slice(0, 30);
    throw new Error(
      `SERIES_FIELD_NOT_FOUND: Couldn't find series data on this ${urlType} page using any known field name. ` +
        `Keys found nearby: ${uniqueKeys.length ? uniqueKeys.join(", ") : "(none — the page may be empty or blocked; check for a Cloudflare challenge)"}. ` +
        `If you can identify which holds the series title/cover/chapters, that'll let this get fixed quickly.`
    );
  }

  let rawChapters;
  try {
    rawChapters = extractJSONValueForKey(html, "chapters");
  } catch {
    rawChapters = series.chapters || [];
  }

  const chapters = rawChapters
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((ch) => ({
      id: ch.id,
      number: ch.number,
      title: ch.title,
      isLocked: !!ch.isLocked,
      publishedAt: ch.publishedAt,
    }));

  return {
    id: `${urlType}/${slug}`,
    slug,
    urlType,
    title: series.title,
    cover: (series.coverImage || "").startsWith("http")
      ? series.coverImage
      : `${BASE_URL}${series.coverImage || ""}`,
    description: series.description || "",
    status: series.status,
    type: series.type,
    genres: (series.genres || []).map((g) => g.name || g.genre?.name || g),
    chapters,
  };
}

/**
 * Fetches the text content of a novel chapter.
 *
 * We don't have a captured novel chapter page to verify the exact field
 * name ValirScans uses for chapter text (everything else in this file
 * was built against real captured HTML — this wasn't). Rather than
 * guess once and risk silently breaking, this tries several plausible
 * field names a Next.js novel-reading page might use, and if none of
 * them match, throws a diagnostic error showing what keys WERE found
 * near the chapter's number in the page — enough to identify the real
 * field name from a single failed attempt instead of blind guessing
 * repeatedly.
 */
async function fetchNovelChapterText(slug, chapterNumber) {
  const url = `${BASE_URL}/series/novel/${slug}/chapter/${chapterNumber}`;
  const html = await fetchHTML(url);

  const candidateKeys = ["content", "htmlContent", "body", "text", "chapterContent", "novelContent"];
  for (const key of candidateKeys) {
    try {
      const value = extractStringValueForKey(html, key);
      if (typeof value === "string" && value.trim().length > 0) {
        return { text: value, fieldUsed: key };
      }
    } catch {
      // This key wasn't found or wasn't a string — try the next one.
    }
  }

  // None of our guesses matched. Surface a few candidate key names that
  // actually exist nearby in the document, scoped to a reasonable window
  // so the error stays short, to make it fast to pinpoint the real key.
  const anchorIdx = html.indexOf(`\\"number\\":${chapterNumber}`);
  const nearbyWindow = anchorIdx !== -1 ? html.slice(anchorIdx, anchorIdx + 2000) : html.slice(0, 2000);
  const keysFound = [...nearbyWindow.matchAll(/\\"([a-zA-Z]+)\\":/g)].map((m) => m[1]);
  const uniqueKeys = [...new Set(keysFound)].slice(0, 25);

  throw new Error(
    `NOVEL_TEXT_FIELD_NOT_FOUND: Couldn't find chapter text using any known field name. ` +
      `Keys found nearby in the page: ${uniqueKeys.join(", ")}. ` +
      `If you can identify which of these holds the chapter text, that'll let this get fixed quickly.`
  );
}

/**
 * Fetches the ordered list of page image URLs for one chapter.
 *
 * NOTE: Novel chapters are text, not page images — there's no images
 * array on those pages at all. Use fetchNovelChapterText for those.
 */
async function fetchChapterPages(urlType, slug, chapterNumber) {
  if (urlType === "novel") {
    throw new Error(
      "NOVEL_NOT_SUPPORTED: Novel chapters are text, not images — use fetchNovelChapterText for EPUB export instead of CBZ."
    );
  }

  const url = `${BASE_URL}/series/${urlType}/${slug}/chapter/${chapterNumber}`;
  const html = await fetchHTML(url);

  const rawPages = extractJSONValueForKey(html, "pages");

  return rawPages
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((p) => p.imageUrl);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts the full site-wide genre list (used to populate a filter
 * dropdown) from the listing page's filter-widget data. This is a
 * different, larger list than any single series' own genre tags — it's
 * every genre the site supports filtering by.
 *
 * NOTE: We can't just search for `"genres":[` directly — that key also
 * appears once per series card (each card's own genre tags), so a plain
 * first-match search is ambiguous. Instead we anchor on "showSaleFilter",
 * a sibling key in the same filter-widget object that's unique on the
 * page, and walk backward to find the genres array that precedes it.
 */
function parseAvailableGenres(html) {
  const anchor = '\\"showSaleFilter\\"';
  const anchorIdx = html.indexOf(anchor);
  if (anchorIdx === -1) return [];

  const genresMarker = '\\"genres\\":';
  // lastIndexOf's second argument searches backward FROM that position,
  // so this finds the nearest "genres": key before the anchor without
  // needing to guess a window size — the real gap between them can be
  // tens of thousands of characters since the genre list itself is long.
  const absoluteIdx = html.lastIndexOf(genresMarker, anchorIdx);
  if (absoluteIdx === -1) return [];

  try {
    const valueStart = absoluteIdx + genresMarker.length;
    const rawSlice = extractBalancedJSON(html, valueStart);
    const cleaned = unescapeEmbeddedJSON(rawSlice);
    const rawGenres = JSON.parse(cleaned);
    return rawGenres.map((g) => ({ name: g.name, slug: g.slug })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function fetchAvailableGenres() {
  const html = await fetchHTML(`${BASE_URL}/series`);
  return parseAvailableGenres(html);
}

module.exports = {
  fetchAllSeries,
  fetchSeriesDetails,
  fetchChapterPages,
  fetchNovelChapterText,
  fetchAvailableGenres,
  fetchHTML,
  BASE_URL,
};
