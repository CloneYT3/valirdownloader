// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let currentPage = 1;
const PAGE_SIZE = 30;
let totalPages = 1;
let totalCount = 0;
let currentPageSeries = []; // series on the currently-displayed page
let searchResults = null; // set while actively searching across all series
let currentSeries = null; // full details of the open series
let selectedChapters = new Set();
let watchlistMap = {};
let chapterOrderDescending = false;
let imagePreloadCount = 2;
let readingProgress = {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * ValirScans' CDN blocks cross-origin image loads (Cross-Origin-Resource-
 * Policy), so the browser can't load these directly from our localhost
 * page. Routing through our own server's /api/image-proxy sidesteps it,
 * since the actual fetch happens server-side, not in the browser.
 */
function proxiedImage(url) {
  if (!url) return "";
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}

async function loadProgress() {
  try {
    const res = await fetch("/api/progress");
    readingProgress = await res.json();
  } catch {
    readingProgress = {};
  }
  renderProgressWidget();
}

let lastRenderedPct = 0;
let lastRenderedTallies = { reading: 0, completed: 0, remaining: 0 };
function renderProgressWidget() {
  const completed = Object.values(readingProgress).filter((p) => p.status === "completed").length;
  const reading = Object.values(readingProgress).filter((p) => p.status === "reading").length;
  const total = totalCount || completed;
  const remaining = Math.max(0, total - completed);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const radius = 27; // must match the hero SVG's circle r="27"
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const ring = $("#progressRingFill");
  if (ring) {
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${offset}`;
  }

  animateCountUp($("#progressPct"), lastRenderedPct, pct, (v) => `${v}%`);
  lastRenderedPct = pct;
  $("#progressLabel").textContent = `${completed} / ${total} read`;

  animateCountUp($("#tallyReading"), lastRenderedTallies.reading, reading, (v) => `${v}`);
  animateCountUp($("#tallyCompleted"), lastRenderedTallies.completed, completed, (v) => `${v}`);
  animateCountUp($("#tallyRemaining"), lastRenderedTallies.remaining, remaining, (v) => `${v}`);
  lastRenderedTallies = { reading, completed, remaining };

  const sub = $("#progressSublabel");
  if (pct === 0) sub.textContent = "Just getting started";
  else if (pct < 25) sub.textContent = "Keep going";
  else if (pct < 50) sub.textContent = "Making progress";
  else if (pct < 75) sub.textContent = "Over halfway there";
  else if (pct < 100) sub.textContent = "Almost there";
  else sub.textContent = "Every single one, read";
}

function animateCountUp(el, from, to, format) {
  if (!el || from === to) {
    if (el) el.textContent = format(to);
    return;
  }
  const duration = 500;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(from + (to - from) * eased);
    el.textContent = format(value);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function setSeriesStatus(series, status) {
  const current = readingProgress[series.id];
  const newStatus = current?.status === status ? "none" : status; // click again to clear
  const res = await fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seriesId: series.id, status: newStatus, title: series.title, cover: series.cover }),
  });
  readingProgress = await res.json();
  renderProgressWidget();
  if (newStatus === "completed") celebrateCompletion();
}

function celebrateCompletion() {
  const burst = document.createElement("div");
  burst.className = "completion-burst";
  burst.textContent = "Marked complete!";
  document.body.appendChild(burst);
  spawnConfetti();
  setTimeout(() => burst.remove(), 1800);
}

function spawnConfetti() {
  const colors = ["#e8604c", "#ffb088", "#5b8def", "#ede6d6"];
  const container = document.createElement("div");
  container.className = "confetti-container";
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.3}s`;
    piece.style.animationDuration = `${1.2 + Math.random() * 0.8}s`;
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  setTimeout(() => container.remove(), 2200);
}

function renderReadingPanel() {
  const body = $("#readingBody");
  const reading = Object.entries(readingProgress).filter(([, p]) => p.status === "reading");

  if (reading.length === 0) {
    body.innerHTML = `<div class="empty-state">Nothing marked as "Reading" yet.<br>Open a series and tap the Reading button.</div>`;
    return;
  }

  body.innerHTML = reading
    .map(
      ([id, p]) => `
      <div class="watch-item">
        <img src="${proxiedImage(p.cover)}" alt="" />
        <div class="watch-item-text"><strong>${escapeHTML(p.title)}</strong><span>Reading</span></div>
      </div>
    `
    )
    .join("");
}

$("#readingBtn").addEventListener("click", () => {
  renderReadingPanel();
  openPanel("readingPanel");
});

$("#moreBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#moreMenu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  const menu = $("#moreMenu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target.id !== "moreBtn") {
    menu.classList.add("hidden");
  }
});
$$(".overflow-item").forEach((btn) => {
  btn.addEventListener("click", () => $("#moreMenu").classList.add("hidden"));
});

// ---------------------------------------------------------------------
// Library view
// ---------------------------------------------------------------------
async function loadLibrary(page = 1) {
  const statusEl = $("#libraryStatus");
  statusEl.textContent = "Loading the shelf…";
  currentPage = page;

  const genre = $("#genreFilter")?.value;
  const type = $("#typeFilter")?.value;
  const status = $("#statusFilter")?.value;
  const sortBy = $("#sortSelect")?.value;
  const progressFilterValue = $("#progressFilter")?.value;

  try {
    if (progressFilterValue) {
      // Reading progress lives client-side, not on ValirScans, so the
      // server can't filter by it — fetch everything (still served from
      // its own cache, not re-scraped) and filter/paginate here instead.
      const params = new URLSearchParams({ page: 1, pageSize: 10000 });
      if (genre) params.set("genre", genre);
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (sortBy) params.set("sortBy", sortBy);

      const res = await fetch(`/api/series?${params.toString()}`);
      const data = await handleJSONResponse(res);

      const matches = data.series.filter((s) => {
        const st = readingProgress[s.id]?.status;
        if (progressFilterValue === "unread") return !st;
        return st === progressFilterValue;
      });

      totalCount = matches.length;
      totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      const start = (page - 1) * PAGE_SIZE;
      currentPageSeries = matches.slice(start, start + PAGE_SIZE);

      renderSeriesGrid(currentPageSeries);
      renderPaginationControls();
      renderProgressWidget();
      statusEl.textContent = `${totalCount} series match this filter — page ${page} of ${totalPages}`;
      return;
    }

    const params = new URLSearchParams({ page, pageSize: PAGE_SIZE });
    if (genre) params.set("genre", genre);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (sortBy) params.set("sortBy", sortBy);

    const res = await fetch(`/api/series?${params.toString()}`);
    const data = await handleJSONResponse(res);
    currentPageSeries = data.series;
    totalPages = data.totalPages;
    totalCount = data.totalCount;
    renderProgressWidget();
    renderSeriesGrid(currentPageSeries);
    renderPaginationControls();
    statusEl.textContent = `${totalCount} series on the shelf — page ${data.page} of ${data.totalPages}${
      data.cached ? " (cached)" : ""
    }`;
  } catch (err) {
    statusEl.textContent = "";
    showError(err, statusEl);
  }
}

async function refreshLibrary() {
  const statusEl = $("#libraryStatus");
  statusEl.textContent = "Refreshing the shelf…";
  try {
    const res = await fetch("/api/series/refresh", { method: "POST" });
    await handleJSONResponse(res);
    await loadLibrary(1);
  } catch (err) {
    statusEl.textContent = "";
    showError(err, statusEl);
  }
}

function renderPaginationControls() {
  let bar = $("#paginationBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "paginationBar";
    bar.className = "pagination-bar";
    $("#seriesGrid").insertAdjacentElement("afterend", bar);
  }

  if (searchResults !== null) {
    bar.innerHTML = ""; // no pagination while showing search results
    return;
  }

  bar.innerHTML = `
    <button id="prevPageBtn" ${currentPage <= 1 ? "disabled" : ""}>← Prev</button>
    <span class="pagination-label" id="pageLabel" title="Click to jump to a page">Page ${currentPage} of ${totalPages}</span>
    <button id="nextPageBtn" ${currentPage >= totalPages ? "disabled" : ""}>Next →</button>
  `;
  $("#prevPageBtn")?.addEventListener("click", () => loadLibrary(currentPage - 1));
  $("#nextPageBtn")?.addEventListener("click", () => loadLibrary(currentPage + 1));
  $("#pageLabel")?.addEventListener("click", showPageJumpInput);
}

function showPageJumpInput() {
  const label = $("#pageLabel");
  if (!label) return;

  label.outerHTML = `
    <span class="pagination-label pagination-label-input">
      Page <input type="number" id="pageJumpInput" min="1" max="${totalPages}" value="${currentPage}" /> of ${totalPages}
    </span>
  `;

  const input = $("#pageJumpInput");
  input.focus();
  input.select();

  const commit = () => {
    let target = parseInt(input.value, 10);
    if (!Number.isFinite(target)) target = currentPage;
    target = Math.min(totalPages, Math.max(1, target));
    if (target !== currentPage) {
      loadLibrary(target);
    } else {
      renderPaginationControls(); // just redraw back to the plain label
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
    } else if (e.key === "Escape") {
      renderPaginationControls();
    }
  });
  input.addEventListener("blur", commit);
}

/**
 * Search needs to look across every series, not just the current page,
 * so it lazily fetches the full list (still served from the server's
 * in-memory cache, so this doesn't re-scrape) only when the person
 * actually starts typing.
 */
let fullSeriesListPromise = null;
async function getFullSeriesList() {
  if (!fullSeriesListPromise) {
    fullSeriesListPromise = fetch(`/api/series?page=1&pageSize=10000`)
      .then(handleJSONResponse)
      .then((data) => data.series);
  }
  return fullSeriesListPromise;
}

function renderSeriesGrid(list) {
  const grid = $("#seriesGrid");
  grid.innerHTML = "";

  if (list.length === 0) {
    grid.innerHTML = `<div class="empty-state empty-state-big">
      <div class="empty-state-icon">¯\\_(ツ)_/¯</div>
      <p>Nothing here matches that.</p>
      <span class="empty-state-hint">Try a different search, or clear your filters.</span>
    </div>`;
    return;
  }

  list.forEach((series, idx) => {
    const card = document.createElement("div");
    card.className = "series-card";
    card.style.position = "relative";
    card.style.animationDelay = `${Math.min(idx * 30, 300)}ms`;
    const status = readingProgress[series.id]?.status;
    const statusClass = status === "completed" ? "status-completed" : status === "reading" ? "status-reading" : "";
    const statusText = status === "completed" ? "Completed" : status === "reading" ? "Reading" : "";
    card.innerHTML = `
      ${statusText ? `<span class="series-status-badge ${statusClass}">${statusText}</span>` : ""}
      <img class="series-cover" src="${proxiedImage(series.cover)}" alt="${escapeHTML(series.title)}" loading="lazy" />
      <div class="series-card-meta">
        <p class="series-card-title">${escapeHTML(series.title)}</p>
        <span class="series-card-type">${series.type || ""}</span>
        <div class="card-quick-actions">
          <button class="quick-action-btn ${status === "reading" ? "active-reading" : ""}" data-action="reading">Reading</button>
          <button class="quick-action-btn ${status === "completed" ? "active-completed" : ""}" data-action="completed">Completed</button>
        </div>
      </div>
    `;
    const img = card.querySelector(".series-cover");
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.classList.add("loaded"));
    card.addEventListener("click", () => openSeries(series.urlType, series.slug));
    card.querySelectorAll(".quick-action-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await setSeriesStatus(series, btn.dataset.action);
        renderSeriesGrid(searchResults !== null ? searchResults : currentPageSeries);
      });
    });
    grid.appendChild(card);
  });
}

let searchDebounceTimer = null;
$("#searchInput").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  clearTimeout(searchDebounceTimer);

  if (!q) {
    searchResults = null;
    renderSeriesGrid(currentPageSeries);
    renderPaginationControls();
    return;
  }

  searchDebounceTimer = setTimeout(async () => {
    const statusEl = $("#libraryStatus");
    statusEl.textContent = "Searching the shelf…";
    const full = await getFullSeriesList();
    searchResults = full.filter((s) => s.title.toLowerCase().includes(q));
    renderSeriesGrid(searchResults);
    renderPaginationControls();
    statusEl.textContent = `${searchResults.length} match${searchResults.length === 1 ? "" : "es"} for "${q}"`;
  }, 250);
});

$("#refreshBtn").addEventListener("click", () => {
  fullSeriesListPromise = null; // invalidate the cached full list too
  refreshLibrary();
});

$("#surpriseBtn").addEventListener("click", async () => {
  const btn = $("#surpriseBtn");
  btn.classList.add("rolling");
  try {
    const full = await getFullSeriesList();
    if (full.length === 0) return;
    const pick = full[Math.floor(Math.random() * full.length)];
    setTimeout(() => openSeries(pick.urlType, pick.slug), 250);
  } finally {
    setTimeout(() => btn.classList.remove("rolling"), 400);
  }
});

["#genreFilter", "#typeFilter", "#statusFilter", "#sortSelect", "#progressFilter"].forEach((sel) => {
  $(sel).addEventListener("change", () => {
    searchResults = null;
    $("#searchInput").value = "";
    loadLibrary(1);
  });
});

async function loadGenreOptions() {
  try {
    const res = await fetch("/api/genres");
    const data = await handleJSONResponse(res);
    const select = $("#genreFilter");
    for (const g of data.genres) {
      const opt = document.createElement("option");
      opt.value = g.slug;
      opt.textContent = g.name;
      select.appendChild(opt);
    }
  } catch {
    // Genre filter just stays at "All genres" if this fails — not worth
    // blocking the rest of the page over it.
  }
}

// ---------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------
function renderSettingsPanel() {
  const slider = $("#preloadCount");
  slider.value = imagePreloadCount;
  $("#preloadCountValue").textContent = imagePreloadCount;

  slider.oninput = () => {
    $("#preloadCountValue").textContent = slider.value;
  };
  slider.onchange = async () => {
    imagePreloadCount = Number(slider.value);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagePreloadCount }),
    });
  };
}

$("#settingsBtn").addEventListener("click", () => {
  renderSettingsPanel();
  openPanel("settingsPanel");
});

// ---------------------------------------------------------------------
// Files panel (for grabbing finished CBZs from another device)
// ---------------------------------------------------------------------
async function loadFilesPanel() {
  const listEl = $("#filesList");
  listEl.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const res = await fetch("/api/downloads");
    const data = await handleJSONResponse(res);

    if (data.files.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No downloaded files yet.</div>`;
      return;
    }

    listEl.innerHTML = `
      <div class="files-bulk-bar">
        <button id="filesSelectAllBtn">Select all</button>
        <button id="filesDownloadSelectedBtn" class="btn-primary" disabled>Download selected (.zip)</button>
      </div>
      <div id="filesRows"></div>
    `;

    const rowsEl = $("#filesRows");
    for (const f of data.files) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `
        <input type="checkbox" class="file-checkbox" data-filename="${escapeAttr(f.name)}" />
        <a class="file-name" href="/api/downloads/${encodeURIComponent(f.name)}" download>${escapeHTML(f.name)}</a>
        <span class="file-size">${formatFileSize(f.sizeBytes)}</span>
      `;
      rowsEl.appendChild(row);
    }

    const updateBulkButton = () => {
      const checked = $$(".file-checkbox").filter((c) => c.checked);
      $("#filesDownloadSelectedBtn").disabled = checked.length === 0;
      $("#filesDownloadSelectedBtn").textContent =
        checked.length > 0 ? `Download ${checked.length} selected (.zip)` : "Download selected (.zip)";
    };

    $$(".file-checkbox").forEach((cb) => cb.addEventListener("change", updateBulkButton));

    $("#filesSelectAllBtn").addEventListener("click", () => {
      const checkboxes = $$(".file-checkbox");
      const allChecked = checkboxes.every((c) => c.checked);
      checkboxes.forEach((c) => (c.checked = !allChecked));
      updateBulkButton();
    });

    $("#filesDownloadSelectedBtn").addEventListener("click", async () => {
      const filenames = $$(".file-checkbox")
        .filter((c) => c.checked)
        .map((c) => c.dataset.filename);
      if (filenames.length === 0) return;

      // A single file just downloads directly rather than bothering
      // with a one-item zip.
      if (filenames.length === 1) {
        window.location.href = `/api/downloads/${encodeURIComponent(filenames[0])}`;
        return;
      }

      const res2 = await fetch("/api/downloads/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames }),
      });
      if (!res2.ok) {
        const err = await res2.json().catch(() => ({}));
        alert(`Couldn't bundle files: ${err.message || "unknown error"}`);
        return;
      }
      const blob = await res2.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ValirScans Files.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state">${escapeHTML(err.message)}</div>`;
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

$("#filesBtn").addEventListener("click", () => {
  loadFilesPanel();
  openPanel("filesPanel");
});

// ---------------------------------------------------------------------
// Series detail view
// ---------------------------------------------------------------------
async function openSeries(urlType, slug) {
  showView("series");
  $("#seriesDetail").innerHTML = `<div class="empty-state">Loading series…</div>`;
  selectedChapters = new Set();

  try {
    const res = await fetch(`/api/series/${urlType}/${slug}`);
    const details = await handleJSONResponse(res);
    currentSeries = details;
    renderSeriesDetail(details);
  } catch (err) {
    showError(err, $("#seriesDetail"));
  }
}

function renderSeriesDetail(details) {
  const isWatched = !!watchlistMap[details.id];
  const isNovel = details.urlType === "novel";

  $("#seriesDetail").innerHTML = `
    <div class="detail-header">
      <img class="detail-cover" src="${proxiedImage(details.cover)}" alt="${escapeHTML(details.title)}" />
      <div class="detail-info">
        <h1 class="detail-title">${escapeHTML(details.title)}</h1>
        <div class="detail-tags">
          <span class="tag">${details.type || "—"}</span>
          <span class="tag">${details.status || "—"}</span>
          ${details.genres.map((g) => `<span class="tag">${escapeHTML(g)}</span>`).join("")}
        </div>
        <p class="detail-description">${escapeHTML(details.description) || "No description available."}</p>
        ${
          isNovel
            ? `<p class="novel-warning">This is a text novel — downloads will be saved as EPUB instead of CBZ.</p>`
            : ""
        }
        <button id="watchToggle" class="watch-toggle ${isWatched ? "active" : ""}">
          ${isWatched ? "✓ Watching for new chapters" : "Watch for new chapters"}
        </button>
        <div class="read-status-row">
          <button id="markReadingBtn" class="read-status-btn ${
            readingProgress[details.id]?.status === "reading" ? "active-reading" : ""
          }">Reading</button>
          <button id="markCompletedBtn" class="read-status-btn ${
            readingProgress[details.id]?.status === "completed" ? "active-completed" : ""
          }">Completed</button>
        </div>
      </div>
    </div>

    <div class="chapters-toolbar">
      <div class="chapters-toolbar-left">
        <span id="selectionCount">0 selected</span>
        <button id="selectAllBtn">Select all</button>
        <button id="selectNoneBtn">Clear</button>
        <button id="reverseOrderBtn">${chapterOrderDescending ? "↓ Newest first" : "↑ Oldest first"}</button>
      </div>
      <div class="download-bar">
        ${
          isNovel
            ? ""
            : `<label class="combine-toggle">
                <input type="checkbox" id="combineToggle" checked />
                Combine into one CBZ
              </label>`
        }
        <label class="split-size-field" title="Split the selected chapters into multiple files, this many chapters each — handy for long series, since some readers struggle with one huge file.">
          Split every
          <input type="number" id="splitSizeInput" min="1" max="500" placeholder="all" />
          chapters
        </label>
        <button id="downloadBtn" class="btn-primary" disabled>Download selected</button>
      </div>
    </div>

    <div class="chapter-list" id="chapterList"></div>
  `;

  renderChapterRows(details);

  $("#selectAllBtn").addEventListener("click", () => {
    selectedChapters = new Set(details.chapters.map((c) => c.number));
    syncCheckboxes();
  });
  $("#selectNoneBtn").addEventListener("click", () => {
    selectedChapters = new Set();
    syncCheckboxes();
  });
  $("#reverseOrderBtn").addEventListener("click", async () => {
    chapterOrderDescending = !chapterOrderDescending;
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterOrderDescending }),
    });
    renderChapterRows(details);
    $("#reverseOrderBtn").textContent = chapterOrderDescending ? "↓ Newest first" : "↑ Oldest first";
  });

  $("#downloadBtn").addEventListener("click", startDownload);
  $("#watchToggle").addEventListener("click", () => toggleWatch(details));
  $("#markReadingBtn").addEventListener("click", async () => {
    await setSeriesStatus(details, "reading");
    renderSeriesDetail(details);
  });
  $("#markCompletedBtn").addEventListener("click", async () => {
    await setSeriesStatus(details, "completed");
    renderSeriesDetail(details);
  });

  updateSelectionUI();
}

function renderChapterRows(details) {
  const list = $("#chapterList");
  list.innerHTML = "";

  const orderedChapters = chapterOrderDescending
    ? details.chapters.slice().sort((a, b) => b.number - a.number)
    : details.chapters; // already ascending from the server

  for (const ch of orderedChapters) {
    const row = document.createElement("label");
    row.className = "chapter-row";
    row.dataset.chapterNumber = ch.number;
    const isSelected = selectedChapters.has(ch.number);
    if (isSelected) row.classList.add("selected");
    row.innerHTML = `
      <input type="checkbox" ${isSelected ? "checked" : ""} />
      <span class="chapter-stub">Ch. ${ch.number}</span>
      <span class="chapter-title">${escapeHTML(ch.title || "")}</span>
      ${ch.isLocked ? '<span class="chapter-locked">LOCKED</span>' : ""}
      <span class="chapter-date">${formatDate(ch.publishedAt)}</span>
    `;
    const checkbox = row.querySelector("input");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedChapters.add(ch.number);
        row.classList.add("selected");
      } else {
        selectedChapters.delete(ch.number);
        row.classList.remove("selected");
      }
      updateSelectionUI();
    });
    list.appendChild(row);
  }
}

function syncCheckboxes() {
  $$(".chapter-row").forEach((row) => {
    const num = Number(row.dataset.chapterNumber);
    const checkbox = row.querySelector("input");
    const isSelected = selectedChapters.has(num);
    checkbox.checked = isSelected;
    row.classList.toggle("selected", isSelected);
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  $("#selectionCount").textContent = `${selectedChapters.size} selected`;
  $("#downloadBtn").disabled = selectedChapters.size === 0;
}

$("#backBtn").addEventListener("click", () => showView("library"));

function showView(name) {
  $("#view-library").classList.toggle("hidden", name !== "library");
  $("#view-series").classList.toggle("hidden", name !== "series");
}

// ---------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------
async function startDownload() {
  if (!currentSeries || selectedChapters.size === 0) return;

  const chapters = currentSeries.chapters
    .filter((c) => selectedChapters.has(c.number))
    .map((c) => ({ number: c.number, title: c.title }))
    .sort((a, b) => a.number - b.number);

  const combineIntoOne = $("#combineToggle").checked;
  const splitSizeRaw = $("#splitSizeInput")?.value;
  const splitSize = splitSizeRaw ? Math.max(1, parseInt(splitSizeRaw, 10) || 0) : 0;

  showToast("Starting download…", 0);

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        urlType: currentSeries.urlType,
        slug: currentSeries.slug,
        seriesTitle: currentSeries.title,
        seriesCover: currentSeries.cover,
        chapters,
        combineIntoOne,
        splitSize,
      }),
    });
    const { jobId, error, message } = await res.json();
    if (error) throw new Error(message || error);

    pollJob(jobId);
  } catch (err) {
    showToast(`Download failed: ${cleanErrorMessage(err.message)}`, 100);
    setTimeout(hideToast, 6000);
  }
}

function pollJob(jobId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();

      if (job.status === "running") {
        const p = job.progress;
        const pct = p.total ? Math.round(((p.current - 1 + p.page / (p.pageTotal || 1)) / p.total) * 100) : 0;
        showToast(p.label || "Downloading…", pct);
      } else if (job.status === "done") {
        clearInterval(interval);
        showToast("Saved to Downloads/ValirScans CBZ ✓", 100);
        setTimeout(hideToast, 3500);
      } else if (job.status === "error") {
        clearInterval(interval);
        showToast(`Download failed: ${cleanErrorMessage(job.error)}`, 100);
        setTimeout(hideToast, 6000);
      }
    } catch {
      clearInterval(interval);
      hideToast();
    }
  }, 700);
}

function showToast(label, pct) {
  $("#downloadToast").classList.remove("hidden");
  $("#toastLabel").textContent = label;
  $("#toastBarFill").style.width = `${pct}%`;
}
function hideToast() {
  $("#downloadToast").classList.add("hidden");
}

// ---------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------
async function loadWatchlist() {
  const res = await fetch("/api/watchlist");
  watchlistMap = await res.json();
}

async function toggleWatch(details) {
  const isWatched = !!watchlistMap[details.id];
  if (isWatched) {
    await fetch(`/api/watchlist/${encodeURIComponent(details.id)}`, { method: "DELETE" });
  } else {
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urlType: details.urlType, slug: details.slug }),
    });
  }
  await loadWatchlist();
  renderSeriesDetail(details);
}

function renderWatchlistPanel() {
  const body = $("#watchlistBody");
  const entries = Object.entries(watchlistMap);

  if (entries.length === 0) {
    body.innerHTML = `<div class="empty-state">Nothing on your watchlist yet.<br>Open a series and tap "Watch for new chapters."</div>`;
    return;
  }

  body.innerHTML = entries
    .map(
      ([id, entry]) => `
      <div class="watch-item">
        <div class="watch-item-text">
          <strong>${escapeHTML(entry.title)}</strong>
          <span>Last seen: Chapter ${entry.lastSeenChapter}</span>
        </div>
        <button class="watch-remove" data-remove="${escapeAttr(id)}">Remove</button>
      </div>
    `
    )
    .join("");

  $$("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/watchlist/${encodeURIComponent(btn.dataset.remove)}`, { method: "DELETE" });
      await loadWatchlist();
      renderWatchlistPanel();
    });
  });
}

// ---------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------
async function loadNotifications() {
  const res = await fetch("/api/notifications");
  const notifications = await res.json();
  const unseenCount = notifications.filter((n) => !n.seenAt).length;

  const badge = $("#notifBadge");
  if (unseenCount > 0) {
    badge.textContent = unseenCount > 9 ? "9+" : unseenCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }

  renderNotifPanel(notifications);
}

function renderNotifPanel(notifications) {
  const list = $("#notifList");
  if (notifications.length === 0) {
    list.innerHTML = `<div class="empty-state">No new chapters yet.<br>Add series to your watchlist and check back here.</div>`;
    return;
  }

  list.innerHTML = notifications
    .map(
      (n) => `
      <div class="notif-item">
        <img src="${proxiedImage(n.cover)}" alt="" />
        <div class="notif-item-text">
          <strong>${escapeHTML(n.title)}</strong>
          <span>${n.newChapterCount} new chapter${n.newChapterCount > 1 ? "s" : ""} — up to Ch. ${n.latestChapterNumber}</span>
        </div>
      </div>
    `
    )
    .join("");
}

// ---------------------------------------------------------------------
// Panel open/close plumbing
// ---------------------------------------------------------------------
function openPanel(id) {
  $(`#${id}`).classList.remove("hidden");
  $("#overlay").classList.remove("hidden");
}
function closeAllPanels() {
  $$(".panel").forEach((p) => p.classList.add("hidden"));
  $("#overlay").classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  const isTyping = tag === "INPUT" || tag === "TEXTAREA";

  if (e.key === "/" && !isTyping) {
    e.preventDefault();
    $("#searchInput")?.focus();
  }
  if (e.key === "Escape") {
    if (isTyping) document.activeElement.blur();
    closeAllPanels();
  }
});

$("#notifBtn").addEventListener("click", async () => {
  openPanel("notifPanel");
  await fetch("/api/notifications/mark-seen", { method: "POST" });
  await loadNotifications();
});
$("#watchlistBtn").addEventListener("click", async () => {
  await loadWatchlist();
  renderWatchlistPanel();
  openPanel("watchlistPanel");
});
$("#overlay").addEventListener("click", closeAllPanels);
$$("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeAllPanels());
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function cleanErrorMessage(msg) {
  if (!msg) return "Unknown error";
  return msg.replace(/^[A-Z_]+:\s*/, "");
}

async function handleJSONResponse(res) {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showError(err, container) {
  container.innerHTML = `<div class="empty-state">${escapeHTML(cleanErrorMessage(err.message))}</div>`;
}

function escapeHTML(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
(async function init() {
  await loadSettings();
  await loadWatchlist();
  await loadProgress();
  await loadNotifications();
  await loadGenreOptions();
  await loadLibrary();

  // Re-poll notification count periodically while the tab is open.
  setInterval(loadNotifications, 5 * 60 * 1000);
})();

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    chapterOrderDescending = !!data.chapterOrderDescending;
    imagePreloadCount = data.imagePreloadCount || 2;
  } catch {
    // Fall back to defaults already set at module load — not worth
    // blocking the rest of the app over a settings fetch failure.
  }
}
