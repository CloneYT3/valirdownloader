const fs = require("fs");
const path = require("path");
const { fetchSeriesDetails } = require("./valirscans");

const DATA_DIR = process.env.VS_DATA_DIR || path.join(__dirname, "..", "data");
const WATCHLIST_PATH = path.join(DATA_DIR, "watchlist.json");
const NOTIFICATIONS_PATH = path.join(DATA_DIR, "notifications.json");

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WATCHLIST_PATH)) {
    fs.writeFileSync(WATCHLIST_PATH, JSON.stringify({}, null, 2));
  }
  if (!fs.existsSync(NOTIFICATIONS_PATH)) {
    fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify([], null, 2));
  }
}

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Watchlist shape: { [seriesId]: { title, urlType, slug, lastSeenChapter } }
 */
function getWatchlist() {
  ensureDataFiles();
  return readJSON(WATCHLIST_PATH);
}

function addToWatchlist(seriesId, { title, urlType, slug, lastSeenChapter }) {
  ensureDataFiles();
  const watchlist = readJSON(WATCHLIST_PATH);
  watchlist[seriesId] = { title, urlType, slug, lastSeenChapter };
  writeJSON(WATCHLIST_PATH, watchlist);
}

function removeFromWatchlist(seriesId) {
  ensureDataFiles();
  const watchlist = readJSON(WATCHLIST_PATH);
  delete watchlist[seriesId];
  writeJSON(WATCHLIST_PATH, watchlist);
}

function getNotifications() {
  ensureDataFiles();
  return readJSON(NOTIFICATIONS_PATH);
}

function addNotification(notification) {
  ensureDataFiles();
  const notifications = readJSON(NOTIFICATIONS_PATH);
  notifications.unshift({ ...notification, seenAt: null, createdAt: Date.now() });
  writeJSON(NOTIFICATIONS_PATH, notifications.slice(0, 100)); // cap history
}

function markNotificationsSeen() {
  ensureDataFiles();
  const notifications = readJSON(NOTIFICATIONS_PATH);
  const updated = notifications.map((n) => ({ ...n, seenAt: n.seenAt || Date.now() }));
  writeJSON(NOTIFICATIONS_PATH, updated);
}

/**
 * Checks every series on the watchlist for chapters newer than what we
 * last recorded. Designed to be called on an interval while the server
 * is running — this is NOT a background service independent of the
 * server process; if the Mac sleeps or the server isn't running, checks
 * simply don't happen during that time.
 */
async function checkWatchlistForUpdates(log) {
  const watchlist = getWatchlist();
  const seriesIds = Object.keys(watchlist);

  for (const seriesId of seriesIds) {
    const entry = watchlist[seriesId];
    try {
      const details = await fetchSeriesDetails(entry.urlType, entry.slug);
      const latestChapter = details.chapters.length
        ? Math.max(...details.chapters.map((c) => c.number))
        : 0;

      if (latestChapter > (entry.lastSeenChapter || 0)) {
        const newChapters = details.chapters.filter(
          (c) => c.number > (entry.lastSeenChapter || 0)
        );

        addNotification({
          seriesId,
          title: details.title,
          cover: details.cover,
          newChapterCount: newChapters.length,
          latestChapterNumber: latestChapter,
        });

        entry.lastSeenChapter = latestChapter;
        entry.title = details.title;
        const current = getWatchlist();
        current[seriesId] = entry;
        writeJSON(WATCHLIST_PATH, current);

        if (log) log(`New chapter(s) for "${details.title}": up to chapter ${latestChapter}`);
      }
    } catch (err) {
      if (log) log(`Watchlist check failed for ${seriesId}: ${err.message}`);
      // Keep going — one failing series (e.g. Cloudflare blip) shouldn't
      // stop the rest of the watchlist from being checked.
    }

    // Small delay between series checks to avoid hammering the site.
    await new Promise((r) => setTimeout(r, 1000));
  }
}

module.exports = {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getNotifications,
  addNotification,
  markNotificationsSeen,
  checkWatchlistForUpdates,
};
