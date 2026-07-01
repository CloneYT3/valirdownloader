const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.VS_DATA_DIR || path.join(__dirname, "..", "data");
const PROGRESS_PATH = path.join(DATA_DIR, "reading-progress.json");

// Shape: { [seriesId]: { title, cover, status: "reading"|"completed" } }
function getProgress() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function setStatus(seriesId, status, meta) {
  const progress = getProgress();
  if (status === "none") {
    delete progress[seriesId];
  } else {
    progress[seriesId] = { ...meta, status };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
  return progress;
}

module.exports = { getProgress, setStatus };
