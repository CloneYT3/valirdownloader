# The Shelf — ValirScans Downloader

A self-hosted web app for browsing every series on [valirscans.org](https://valirscans.org),
picking a chapter range, and downloading it as a CBZ file — ready to add
to Suwatte (or any other comic reader).

Runs as a small local server on your Mac. Open it in your Mac's browser,
or on your iPhone over the same Wi-Fi network.

## What it does

- **Browse the shelf** — every series on ValirScans, with cover art and descriptions
- **Pick a chapter range** — select individual chapters or a whole run, download as one combined CBZ or separate files per chapter
- **Watchlist + notifications** — mark series you want to keep up with; while the server is running, it checks periodically for new chapters and shows a badge

## Requirements

- A Mac with [Node.js](https://nodejs.org) installed (v18 or newer — the LTS download from nodejs.org is fine)
- That's it. No database, no separate services.

## Setup

1. Unzip this project somewhere on your Mac (e.g. `~/Documents/valirscans-downloader`)
2. Open Terminal, navigate to the folder:
   ```bash
   cd ~/Documents/valirscans-downloader
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```

You'll see something like:

```
ValirScans Downloader running at:
  http://localhost:4173

On your iPhone (same Wi-Fi), open:
  http://192.168.1.42:4173
```

- On your **Mac**: open the `localhost` link in any browser
- On your **iPhone**: open the second link in Safari, as long as your phone is on the same Wi-Fi network as your Mac

Leave the Terminal window open — closing it stops the server. To stop it
deliberately, press `Ctrl+C` in that Terminal window.

## Where files go

Downloaded CBZ files land in:

```
~/Downloads/ValirScans CBZ/
```

From there, AirDrop them to your phone, add them to Suwatte's local
storage, or move them anywhere you like.

## Filtering, sorting, and chapter order

The shelf supports filtering by genre, type (manhwa/manga/manhua/web
novel), and status, plus sorting by name, chapter count, rating, or
recently updated. On a series page, a button next to "Select all" flips
chapter order between oldest-first and newest-first — handy for jumping
to the newest chapters on a long-running series.

## Getting files onto your phone

Click **My Files** in the top bar to see every CBZ you've downloaded.
Open the same page in Safari on your phone (using the LAN link the
server printed on startup) and tap any file to save it directly — no
AirDrop or cable needed, as long as both devices are on the same Wi-Fi.

## Settings

Click **Settings** to adjust how many cover images load ahead of view
(1–5). Saved on the server, so it persists across restarts.

## Novels export as EPUB

Novel chapters download as EPUB files instead of CBZ, since they're text
rather than page images. Same chapter-selection flow as comics — select
a range, hit download.

One honest caveat: ValirScans' exact field name for chapter text wasn't
verified against a real captured page (only comics were, throughout this
whole project). The code tries several plausible field names and, if
none match, throws an error listing the actual keys it found nearby — if
that happens, sharing that error message makes a fix quick.

## Splitting long series into multiple files

Next to "Combine into one CBZ" (or for novels, just on its own) is a
"Split every ___ chapters" field. Leave it blank for one file as before,
or enter a number (e.g. 15) to get separate files of that many chapters
each — handy since some readers struggle to load a single file with
thousands of pages. Works for both CBZ and EPUB downloads.

## Downloading multiple files at once

In **My Files**, check the boxes next to whichever files you want and
click **Download selected** — they're bundled into one zip so you only
need one tap/transfer instead of several.

## Jumping to a specific page

Click the "Page X of Y" text in the shelf's pagination bar to type in a
page number directly, instead of clicking Next repeatedly.

## CBZ thumbnails

Each downloaded CBZ now includes the series cover as its very first
image, so readers like Suwatte that thumbnail a file by its first page
show the actual cover instead of a random comic page.

## Novel page parsing

`fetchSeriesDetails` now tries a few plausible field names for novel
series pages (not just the "series" key comics use), and if none match,
throws an error listing the actual keys found on the page — paste that
error here if it ever comes up and it's a fast fix.

## Performance: caching and pagination

- **The series listing is cached on disk too** (`data/series-cache.json`),
  not just in memory — restarting the server (e.g. after closing
  Terminal) reuses this instead of re-scraping everything from scratch.
  It still refreshes automatically every 15 minutes, or any time you
  click **Refresh Library**.
- **Cover images are cached on disk** the first time they're loaded (in
  `data/image-cache/`), so revisiting the shelf is much faster after the
  first load — no need to re-download the same covers from ValirScans
  every time.
- **The shelf loads 30 series per page** instead of all of them at once,
  so your browser isn't trying to load hundreds of images simultaneously.
  Search still looks across every series, not just the current page.

## Image quality note

Some covers may look softer/lower-resolution than others, especially on
a larger screen (like a Mac) compared to a phone. This reflects the
actual source image quality on ValirScans for that series — some covers
are just uploaded at lower resolution than others — not something this
app can improve, since it always requests the original, full-size image.

## The Cloudflare thing

ValirScans sits behind a Cloudflare check that occasionally challenges
**browser** visits. This app talks to ValirScans directly over HTTP, not
through a browser, so it doesn't hit the interactive challenge the same
way — but if ValirScans ever tightens this, you'll see a clear error
message in the app telling you to open valirscans.org in a real browser
first, solve the challenge there, then try again.

The new-chapter watchlist check runs automatically once an hour, but only
while this server is actually running on your Mac. If your Mac sleeps or
the server isn't running, checks simply don't happen during that time —
this isn't a cloud service, it's only as "always on" as your Mac is.

## Running this in the background long-term

By default, `npm start` only runs while that Terminal window is open. If
you want it running continuously (so the watchlist actually checks
hourly, and so the app is always reachable from your phone), a couple of
options:

- **Simplest:** leave a Terminal tab open with `npm start` running, and let your Mac's energy settings keep it from fully sleeping.
- **More robust:** use a process manager like [pm2](https://pm2.keymetrics.dev/) (`npm install -g pm2`, then `pm2 start server/index.js --name valirscans`) so it survives Terminal closing and restarts automatically if it crashes.

## Project structure

```
server/
  index.js       — Express server & API routes
  valirscans.js  — scraping logic (same approach validated in the
                   companion Suwatte runner project)
  cbz.js         — downloads chapter images and packages them into CBZ
  watchlist.js   — tracks watched series and detects new chapters
public/
  index.html     — the app shell
  style.css      — "bookshelf" visual design
  app.js         — all frontend interaction logic
data/            — created automatically; stores watchlist.json and
                   notifications.json (not committed/shared)
test-*.js        — test suites covering each server module, run against
                   real captured ValirScans HTML in test-fixtures/
```

## Running the tests

```bash
npm test
```

Runs all four suites (scraping, CBZ creation, server routes, watchlist)
against real captured ValirScans fixtures with network calls mocked — no
internet connection needed, and nothing gets written outside temp
directories.

## How the scraping works (and what could break it)

ValirScans is a Next.js app that embeds page data as serialized React
payloads inside `<script>` tags rather than exposing a clean API. This
app extracts the relevant JSON directly out of that embedded data for
three kinds of pages:

| Feature | Source page | How it's parsed |
|---|---|---|
| Browse / search | `/series` | Real HTML markup, parsed with cheerio (DOM-aware, not regex) |
| Series details + chapters | `/series/{type}/{slug}` | Embedded JSON, extracted by locating the `"series"` and `"chapters"` keys directly |
| Chapter pages | `/series/{type}/{slug}/chapter/{n}` | Embedded JSON, extracted by locating the `"pages"` key |

This is inherently dependent on ValirScans' current page structure, which
isn't a stable public API. If the site changes its template, parsing
could break. If something stops working:

1. Run the app and see what error message comes back — `handleScrapeError`
   in `server/index.js` tries to give a specific, useful message
2. If it looks like a parsing failure rather than a network/Cloudflare
   issue, the functions in `server/valirscans.js` (`parseDirectoryHTML`,
   `fetchSeriesDetails`, `fetchChapterPages`) are where to look — compare
   a freshly-saved copy of the relevant ValirScans page's HTML against
   what these functions expect to find

## Known limitations

- Locked/paid chapters will appear in the list but will likely fail to
  download (same as visiting them in a browser while logged out) — no
  authentication is implemented
- The watchlist check is best-effort and only runs while the server is
  actively running on your Mac
- Cover images and chapter pages are fetched directly from ValirScans'
  CDN — if that CDN is ever placed behind its own access restrictions,
  downloads could start failing even though browsing still works
