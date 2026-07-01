const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.VS_DATA_DIR || path.join(__dirname, "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  imagePreloadCount: 2, // how many cover images to load ahead of view, 1-5
  chapterOrderDescending: false,
};

function getSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function updateSettings(patch) {
  const current = getSettings();
  const updated = { ...current, ...patch };

  // Clamp to sane bounds rather than trusting client input blindly.
  if (typeof updated.imagePreloadCount === "number") {
    updated.imagePreloadCount = Math.min(5, Math.max(1, Math.round(updated.imagePreloadCount)));
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = { getSettings, updateSettings, DEFAULTS };
