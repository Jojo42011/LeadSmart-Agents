(function () {
  const PAGE_TITLES = {
    overview: "Overview",
    scrubs: "Recent Scrubs",
  };

  const els = {
    pageTitle: document.getElementById("pageTitle"),
    refreshBtn: document.getElementById("refreshBtn"),
    loadError: document.getElementById("loadError"),
    navLinks: document.querySelectorAll(".nav-link"),
    pages: document.querySelectorAll(".page"),
    sidebar: document.getElementById("sidebar"),
    menuToggle: document.getElementById("menuToggle"),
    overlay: document.getElementById("overlay"),
    totalScrubs: document.getElementById("totalScrubs"),
    totalPayoutVoided: document.getElementById("totalPayoutVoided"),
    totalRevenueVoided: document.getElementById("totalRevenueVoided"),
    lastRunTime: document.getElementById("lastRunTime"),
    lastRunBadge: document.getElementById("lastRunBadge"),
    lastVoided: document.getElementById("lastVoided"),
    lastSkipped: document.getElementById("lastSkipped"),
    lastErrors: document.getElementById("lastErrors"),
    nextRunCountdown: document.getElementById("nextRunCountdown"),
    runNowBtn: document.getElementById("runNowBtn"),
    lastRunNote: document.getElementById("lastRunNote"),
    scrubsBody: document.getElementById("scrubsBody"),
    scrubsEmpty: document.getElementById("scrubsEmpty"),
  };

  let currentPage = "overview";
  let nextRunAtMs = null;

  function formatCountdown(ms) {
    if (ms <= 0) return "DUE NOW";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return h + "h " + String(m).padStart(2, "0") + "m " + String(s).padStart(2, "0") + "s";
  }

  function tickCountdown() {
    if (!els.nextRunCountdown) return;
    if (nextRunAtMs == null) {
      els.nextRunCountdown.textContent = "—";
      return;
    }
    els.nextRunCountdown.textContent = formatCountdown(nextRunAtMs - Date.now());
  }

  function formatMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatTs(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function statusClass(status) {
    if (status === "success") return "status-pill--success";
    if (status === "error" || status === "void_success_approve_failed") {
      return "status-pill--error";
    }
    if (status === "dry_run") return "status-pill--dry_run";
    return "status-pill--skipped";
  }

  function isExpandableStatus(status) {
    return status === "error" || status === "void_success_approve_failed";
  }

  function formatErrorDetail(message) {
    if (message == null || String(message).trim() === "") {
      return "No error details available";
    }
    return String(message);
  }

  function renderRows(tbody, rows) {
    tbody.innerHTML = "";
    for (const row of rows) {
      const expandable = isExpandableStatus(row.status);
      const amount =
        row.amountVoided != null
          ? "$" + formatMoney(row.amountVoided)
          : "—";

      const mainTr = document.createElement("tr");
      mainTr.className = expandable
        ? "scrub-row scrub-row--expandable"
        : "scrub-row";

      const chevronCell = expandable
        ? '<td class="data-table__chevron-col"><span class="scrub-chevron" aria-hidden="true"></span></td>'
        : '<td class="data-table__chevron-col"></td>';

      mainTr.innerHTML =
        "<td>" +
        formatTs(row.createdAt) +
        "</td>" +
        "<td>" +
        escapeHtml(row.publisherName || "—") +
        "</td>" +
        "<td>" +
        amount +
        "</td>" +
        "<td><span class=\"status-pill " +
        statusClass(row.status) +
        "\">" +
        escapeHtml(row.status) +
        "</span></td>" +
        chevronCell;

      tbody.appendChild(mainTr);

      if (!expandable) {
        continue;
      }

      const detailTr = document.createElement("tr");
      detailTr.className = "scrub-row__detail";
      const detailText = formatErrorDetail(row.errorMessage);
      detailTr.innerHTML =
        '<td colspan="5">' +
        '<div class="scrub-detail__wrap">' +
        '<div class="scrub-detail__inner">' +
        '<p class="scrub-detail__text mono">' +
        escapeHtml(detailText) +
        "</p>" +
        "</div>" +
        "</div>" +
        "</td>";

      mainTr.addEventListener("click", function () {
        const isOpen = mainTr.classList.toggle("scrub-row--expanded");
        detailTr.classList.toggle("scrub-row__detail--open", isOpen);
      });

      tbody.appendChild(detailTr);
    }
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function setError(msg) {
    els.loadError.hidden = !msg;
    els.loadError.textContent = msg || "";
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function renderOverview(data) {
    els.totalScrubs.textContent = String(data.totalScrubs ?? 0);
    els.totalPayoutVoided.textContent = formatMoney(data.totalPayoutVoided);
    els.totalRevenueVoided.textContent = formatMoney(data.totalRevenueVoided);

    const run = data.lastRun || {};
    if (!run.timestamp) {
      els.lastRunTime.textContent = "No poll recorded";
      els.lastRunBadge.textContent = "IDLE";
      els.lastRunBadge.className = "panel__badge";
      els.lastVoided.textContent = "0";
      els.lastErrors.textContent = "0";
      els.lastRunNote.textContent = "";
      nextRunAtMs = null;
      tickCountdown();
      return;
    }

    nextRunAtMs = data.nextRunAt ? new Date(data.nextRunAt).getTime() : null;
    tickCountdown();

    els.lastRunTime.textContent = formatTs(run.timestamp);
    els.lastVoided.textContent = String(run.voided ?? 0);
    els.lastErrors.textContent = String(run.errors ?? 0);

    const errCount = run.errors ?? 0;
    if (errCount > 0) {
      els.lastRunBadge.textContent = "ERRORS";
      els.lastRunBadge.className = "panel__badge panel__badge--warn";
    } else {
      els.lastRunBadge.textContent = "OK";
      els.lastRunBadge.className = "panel__badge panel__badge--ok";
    }

    const parts = [];
    if (data.pollIntervalMs) {
      const intervalH = data.pollIntervalMs / 3600000;
      parts.push("Poll every " + intervalH + "h");
    }
    if (run.dryRuns > 0) parts.push(run.dryRuns + " dry run");
    els.lastRunNote.textContent =
      parts.length > 0
        ? parts.join(" · ") +
          " · Skipped jobs are not written to scrub_log"
        : "Counts from scrub_log in ~11m window before last poll · Skipped not logged";
  }

  async function loadOverview() {
    const data = await fetchJson("/api/overview");
    renderOverview(data);
  }

  async function loadScrubs() {
    const rows = await fetchJson("/api/scrubs?limit=100");
    renderRows(els.scrubsBody, rows);
    els.scrubsEmpty.hidden = rows.length > 0;
  }

  async function refresh() {
    setError("");
    try {
      await loadOverview();
      await loadScrubs();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    }
  }

  function showPage(page) {
    currentPage = page;
    const hash = page === "overview" ? "overview" : page;
    if (location.hash.replace("#", "") !== hash) {
      history.replaceState(null, "", "#" + hash);
    }

    els.pageTitle.textContent = PAGE_TITLES[page] || "Dashboard";

    els.navLinks.forEach(function (link) {
      link.classList.toggle(
        "nav-link--active",
        link.getAttribute("data-page") === page
      );
    });

    els.pages.forEach(function (section) {
      const active = section.getAttribute("data-page") === page;
      section.hidden = !active;
      section.classList.toggle("page--active", active);
    });

    closeSidebar();
  }

  function parseHash() {
    const h = (location.hash || "#overview").replace("#", "");
    if (h === "scrubs" || h === "overview") return h;
    if (h === "errors") return "scrubs";
    return "overview";
  }

  function closeSidebar() {
    els.sidebar.classList.remove("sidebar--open");
    els.overlay.hidden = true;
  }

  function openSidebar() {
    els.sidebar.classList.add("sidebar--open");
    els.overlay.hidden = false;
  }

  els.navLinks.forEach(function (link) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      showPage(link.getAttribute("data-page"));
    });
  });

  els.menuToggle.addEventListener("click", function () {
    if (els.sidebar.classList.contains("sidebar--open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  els.overlay.addEventListener("click", closeSidebar);

  els.refreshBtn.addEventListener("click", function () {
    refresh();
  });

  if (els.runNowBtn) {
    els.runNowBtn.addEventListener("click", async function () {
      els.runNowBtn.disabled = true;
      setError("");
      try {
        const res = await fetch("/api/run-now", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || res.statusText);
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Run now failed");
      } finally {
        els.runNowBtn.disabled = false;
      }
    });
  }

  window.addEventListener("hashchange", function () {
    showPage(parseHash());
  });

  showPage(parseHash());
  refresh();
  setInterval(refresh, 30000);
  setInterval(tickCountdown, 1000);
})();
