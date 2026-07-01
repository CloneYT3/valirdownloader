/**
 * Verifies server/watchlist.js: adding/removing series, notification
 * generation, marking-as-seen, and the actual update-detection logic
 * (checkWatchlistForUpdates) against real captured fixture data.
 *
 * Uses a throwaway temp directory for all reads/writes (via VS_DATA_DIR)
 * so this never touches the real project's data/ folder.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-watchlist-test-"));
process.env.VS_DATA_DIR = tmpDataDir;

const FIXTURES = path.join(__dirname, "test-fixtures");
const seriesHTML = fs.readFileSync(path.join(FIXTURES, "series.html"), "utf-8");

global.fetch = async (url) => {
  const urlStr = String(url);
  if (urlStr.includes("/series/comic/our-guilds-idol")) {
    return { ok: true, status: 200, text: async () => seriesHTML };
  }
  if (urlStr.includes("/series/comic/nonexistent-series")) {
    // Simulate a series that's gone 404 / can't be fetched, to verify
    // checkWatchlistForUpdates skips it gracefully instead of crashing.
    return { ok: false, status: 404, text: async () => "<html>not found</html>" };
  }
  throw new Error(`Unmocked URL: ${urlStr}`);
};

const watchlist = require("./server/watchlist");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ FAIL: ${msg}`);
    failures++;
  }
}

(async () => {
  console.log("\n--- add / get / remove ---");
  assert(Object.keys(watchlist.getWatchlist()).length === 0, "watchlist starts empty");

  watchlist.addToWatchlist("comic/our-guilds-idol", {
    title: "Our Guild's Idol",
    urlType: "comic",
    slug: "our-guilds-idol",
    lastSeenChapter: 49, // pretend we last saw up through chapter 49
  });

  const afterAdd = watchlist.getWatchlist();
  assert(Object.keys(afterAdd).length === 1, "watchlist has 1 entry after adding");
  assert(afterAdd["comic/our-guilds-idol"]?.lastSeenChapter === 49, "stored lastSeenChapter correctly");

  watchlist.removeFromWatchlist("comic/our-guilds-idol");
  assert(Object.keys(watchlist.getWatchlist()).length === 0, "watchlist empty again after removal");

  console.log("\n--- notifications: add / get / mark seen ---");
  assert(watchlist.getNotifications().length === 0, "notifications start empty");

  watchlist.addNotification({
    seriesId: "comic/our-guilds-idol",
    title: "Our Guild's Idol",
    cover: "https://example.com/cover.webp",
    newChapterCount: 2,
    latestChapterNumber: 51,
  });

  const notifs = watchlist.getNotifications();
  assert(notifs.length === 1, "1 notification after adding");
  assert(notifs[0].seenAt === null, "new notification starts unseen (seenAt is null)");

  await watchlist.markNotificationsSeen();
  const notifsAfterSeen = watchlist.getNotifications();
  assert(notifsAfterSeen[0].seenAt !== null, "notification marked seen after markNotificationsSeen");

  console.log("\n--- checkWatchlistForUpdates: detects new chapters ---");
  // Re-add to watchlist with lastSeenChapter behind the real fixture's
  // latest chapter (51), so the check should detect 2 "new" chapters
  // (50 and 51) and fire a notification.
  watchlist.addToWatchlist("comic/our-guilds-idol", {
    title: "Our Guild's Idol",
    urlType: "comic",
    slug: "our-guilds-idol",
    lastSeenChapter: 49,
  });

  const logs = [];
  await watchlist.checkWatchlistForUpdates((msg) => logs.push(msg));

  const updatedEntry = watchlist.getWatchlist()["comic/our-guilds-idol"];
  assert(updatedEntry.lastSeenChapter === 51, `lastSeenChapter updated to 51 (got ${updatedEntry.lastSeenChapter})`);

  const allNotifs = watchlist.getNotifications();
  const newNotif = allNotifs.find((n) => n.latestChapterNumber === 51);
  assert(!!newNotif, "a notification was created for the new chapters");
  assert(newNotif?.newChapterCount === 2, `notification reports 2 new chapters (got ${newNotif?.newChapterCount})`);
  assert(logs.some((l) => l.includes("New chapter")), "a log message was emitted for the update");

  console.log("\n--- checkWatchlistForUpdates: no-op when already up to date ---");
  const notifCountBefore = watchlist.getNotifications().length;
  await watchlist.checkWatchlistForUpdates(() => {});
  const notifCountAfter = watchlist.getNotifications().length;
  assert(
    notifCountAfter === notifCountBefore,
    `no new notification when lastSeenChapter already matches latest (before: ${notifCountBefore}, after: ${notifCountAfter})`
  );

  console.log("\n--- checkWatchlistForUpdates: failing series doesn't crash the whole check ---");
  watchlist.addToWatchlist("comic/nonexistent-series", {
    title: "Ghost Series",
    urlType: "comic",
    slug: "nonexistent-series",
    lastSeenChapter: 0,
  });

  let threw = false;
  const failLogs = [];
  try {
    await watchlist.checkWatchlistForUpdates((msg) => failLogs.push(msg));
  } catch {
    threw = true;
  }
  assert(!threw, "checkWatchlistForUpdates did not throw despite one series failing");
  assert(
    failLogs.some((l) => l.includes("failed")),
    "a failure was logged for the broken series"
  );

  console.log(`\n${failures === 0 ? "✅ All tests passed" : `❌ ${failures} test(s) failed`}`);
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();
