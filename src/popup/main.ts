import { ALIEXPRESS_LOGIN_URL, MOBILE_USER_AGENT, POPUP_LOGIN_START_SEEN_KEY, POPUP_THEME_KEY, STATS_URL } from "../shared/constants";
import { isAllowedProbeUrl } from "../shared/routes";
import { TASK_CATALOG_BY_ID } from "../shared/task-catalog";
import type { AutomationLogEntry, AutomationRun, DiagnosticsSnapshot, Phase0Message, Phase0Report, Phase0Response, ProbeSession, StatsHistoryCategory, StatsSnapshot } from "../shared/types";

const statusElement = document.querySelector<HTMLElement>("#status");
const observationsElement = document.querySelector<HTMLDListElement>("#observations");
const openButton = document.querySelector<HTMLButtonElement>("#open-mobile");
const closeButton = document.querySelector<HTMLButtonElement>("#close-mobile");
const refreshButton = document.querySelector<HTMLButtonElement>("#refresh");
const copyObservationsButton = document.querySelector<HTMLButtonElement>("#copy-observations");
const probeForm = document.querySelector<HTMLFormElement>("#probe-form");
const probeUrlInput = document.querySelector<HTMLInputElement>("#probe-url");
const probeMobileInput = document.querySelector<HTMLInputElement>("#probe-mobile");
const runButton = document.querySelector<HTMLButtonElement>("#run-automation");
const stopAutomationButton = document.querySelector<HTMLButtonElement>("#stop-automation");
const runStateElement = document.querySelector<HTMLElement>("#run-state");
const automationStatusElement = document.querySelector<HTMLElement>("#automation-status");
const runProgressElement = document.querySelector<HTMLElement>("#run-progress");
const runElapsedElement = document.querySelector<HTMLElement>("#run-elapsed");
const runCurrentTaskElement = document.querySelector<HTMLElement>("#run-current-task");
const logsElement = document.querySelector<HTMLDivElement>("#automation-logs");
const logRunFilter = document.querySelector<HTMLSelectElement>("#log-run-filter");
const copyLogsButton = document.querySelector<HTMLButtonElement>("#copy-logs");
const copyAllLogsButton = document.querySelector<HTMLButtonElement>("#copy-all-logs");
const clearLogsButton = document.querySelector<HTMLButtonElement>("#clear-logs");
const statsStateElement = document.querySelector<HTMLElement>("#stats-state");
const statsBalanceElement = document.querySelector<HTMLElement>("#stats-balance");
const statsCurrentSavingsElement = document.querySelector<HTMLElement>("#stats-current-savings");
const statsLifetimeSavingsElement = document.querySelector<HTMLElement>("#stats-lifetime-savings");
const statsMetaElement = document.querySelector<HTMLElement>("#stats-meta");
const headerBalanceElement = document.querySelector<HTMLElement>("#header-balance");
const headerBalancePill = document.querySelector<HTMLElement>("#header-balance-pill");
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
const themeLabel = document.querySelector<HTMLElement>("#theme-label");
const settingsButton = document.querySelector<HTMLButtonElement>("#settings-button");
const historyFilter = document.querySelector<HTMLSelectElement>("#history-filter");
const historyListElement = document.querySelector<HTMLDivElement>("#history-list");
const historyEmptyElement = document.querySelector<HTMLElement>("#history-empty");
const liveAnnouncementElement = document.querySelector<HTMLElement>("#live-announcement");
const diagnosticsSummaryElement = document.querySelector<HTMLElement>("#diagnostics-summary");
const diagnosticsTasksElement = document.querySelector<HTMLDivElement>("#diagnostics-tasks");
const diagnosticsMismatchesElement = document.querySelector<HTMLElement>("#diagnostics-mismatches");
const exportDiagnosticsButton = document.querySelector<HTMLButtonElement>("#export-diagnostics");
const topbar = document.querySelector<HTMLElement>("#topbar");
const loginScreen = document.querySelector<HTMLElement>("#login-screen");
const dashboard = document.querySelector<HTMLElement>("#dashboard");
const loginButton = document.querySelector<HTMLButtonElement>("#login-to-aliexpress");
const alreadyLoggedInButton = document.querySelector<HTMLButtonElement>("#already-logged-in");
const authBanner = document.querySelector<HTMLElement>("#auth-banner");
const authSignInButton = document.querySelector<HTMLButtonElement>("#auth-sign-in");
const authDismissButton = document.querySelector<HTMLButtonElement>("#auth-dismiss");
let latestLogs: AutomationLogEntry[] = [];
let latestRun: AutomationRun | undefined;
let selectedLogRunId: string | undefined;
let logRunSelectionTouched = false;
let latestStats: StatsSnapshot | undefined;
let lastRunState = "";
let lastStatsState = "";
let authBannerDismissed = false;

type PopupTheme = "light" | "dark";

function send(message: Phase0Message): Promise<Phase0Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: Phase0Response | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from service worker" });
    });
  });
}

function applyTheme(theme: PopupTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const nextTheme = theme === "dark" ? "light" : "dark";
  if (themeLabel) themeLabel.textContent = nextTheme === "dark" ? "Dark" : "Light";
  themeToggle?.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  themeToggle?.setAttribute("title", `Switch to ${nextTheme} mode`);
  themeToggle?.setAttribute("aria-checked", String(theme === "dark"));
}

async function initializeTheme(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(POPUP_THEME_KEY);
    applyTheme(result[POPUP_THEME_KEY] === "dark" ? "dark" : "light");
  } catch {
    applyTheme("light");
  }
}

async function openSettings(): Promise<void> {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    window.open(chrome.runtime.getURL("options/index.html"), "_blank");
  }
}

function showLoginScreen(): void {
  if (topbar) topbar.hidden = true;
  if (loginScreen) loginScreen.hidden = false;
  if (dashboard) dashboard.hidden = true;
  if (authBanner) authBanner.hidden = true;
}

function showDashboard(): void {
  if (topbar) topbar.hidden = false;
  if (loginScreen) loginScreen.hidden = true;
  if (dashboard) dashboard.hidden = false;
}

async function openAliExpressPage(button: HTMLButtonElement, url: string): Promise<void> {
  button.disabled = true;
  try {
    await chrome.tabs.create({ url });
  } catch {
    button.disabled = false;
  }
}

function renderAuthBanner(snapshot: StatsSnapshot | undefined): void {
  if (!authBanner || !dashboard || dashboard.hidden) return;
  if (snapshot?.accountState === "authenticated") {
    authBannerDismissed = false;
    authBanner.hidden = true;
    return;
  }
  if (snapshot?.accountState === "logged-out") {
    authBanner.hidden = authBannerDismissed;
  }
}

function addObservation(label: string, value: string): void {
  if (!observationsElement) return;
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  const row = document.createElement("div");
  row.className = "observation";
  row.append(term, description);
  observationsElement.append(row);
}

function latestReport(reports: Phase0Report[] | undefined, sessions: ProbeSession[] | undefined): Phase0Report | undefined {
  if (!reports?.length) return undefined;
  const preferredTabIds = new Set(
    (sessions ?? [])
      .filter((session) => session.owner === "automation" && session.role === "main")
      .map((session) => session.tabId)
  );
  const controlled = reports.filter((report) => report.tabId !== undefined && preferredTabIds.has(report.tabId));
  return (controlled.length ? controlled : reports).slice().sort((left, right) => right.at - left.at)[0];
}

function isRunTerminal(run: AutomationRun | undefined): boolean {
  return Boolean(!run || ["succeeded", "partially_succeeded", "failed_retryable", "failed_terminal", "cancelled", "interrupted"].includes(run.state));
}

function hasOwnedAutomationSession(run: AutomationRun | undefined, automationSessionActive: boolean | undefined): boolean {
  return Boolean(run && automationSessionActive);
}

function announce(message: string): void {
  if (liveAnnouncementElement) liveAnnouncementElement.textContent = message;
}

function readableState(state: string): string {
  return state.replaceAll("_", " ");
}

function formatLogEntry(entry: AutomationLogEntry): string {
  const details = Object.entries(entry.data ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const scope = [entry.taskId, entry.tabId === undefined ? undefined : `tab=${entry.tabId}`].filter(Boolean).join(" ");
  return `${new Date(entry.at).toLocaleTimeString()} [${entry.level.toUpperCase()}] ${entry.event}${scope ? ` ${scope}` : ""}: ${entry.message}${details ? ` (${details})` : ""}`;
}

function logsAsText(logs: AutomationLogEntry[]): string {
  return logs.slice().sort((left, right) => left.at - right.at).map(formatLogEntry).join("\n");
}

function logsForRun(logs: AutomationLogEntry[], runId: string | undefined): AutomationLogEntry[] {
  return runId ? logs.filter((entry) => entry.runId === runId) : [];
}

function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

function formatRunDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderLogRunFilter(run: AutomationRun | undefined, logs: AutomationLogEntry[]): void {
  if (!logRunFilter) return;
  const rangeByRun = new Map<string, { first: number; latest: number }>();
  for (const entry of logs) {
    if (!entry.runId) continue;
    const range = rangeByRun.get(entry.runId);
    if (range) {
      range.first = Math.min(range.first, entry.at);
      range.latest = Math.max(range.latest, entry.at);
    } else {
      rangeByRun.set(entry.runId, { first: entry.at, latest: entry.at });
    }
  }
  if (run?.id) {
    const range = rangeByRun.get(run.id);
    rangeByRun.set(run.id, {
      first: range?.first ?? run.createdAt,
      latest: Math.max(range?.latest ?? 0, run.updatedAt)
    });
  }
  const runIds = [...rangeByRun.keys()].sort((left, right) => (rangeByRun.get(right)?.latest ?? 0) - (rangeByRun.get(left)?.latest ?? 0));
  const preferredRunId = logRunSelectionTouched && selectedLogRunId && runIds.includes(selectedLogRunId)
    ? selectedLogRunId
    : run?.id ?? runIds[0];
  selectedLogRunId = preferredRunId;
  logRunFilter.replaceChildren();
  for (const runId of runIds) {
    const option = document.createElement("option");
    option.value = runId;
    const range = rangeByRun.get(runId);
    const date = range ? formatRunDate(range.first) : "unknown date";
    option.textContent = `${runId === run?.id ? "Current" : "Run"} ${date} (${shortRunId(runId)})`;
    option.title = runId;
    option.selected = runId === selectedLogRunId;
    logRunFilter.append(option);
  }
  if (!runIds.length) {
    const option = document.createElement("option");
    option.textContent = "No runs";
    option.disabled = true;
    option.selected = true;
    logRunFilter.append(option);
  }
}

function renderLogEntries(logs: AutomationLogEntry[]): void {
  if (!logsElement) return;
  logsElement.replaceChildren();
  for (const entry of logs) {
    const item = document.createElement("div");
    item.className = `log-${entry.level}`;
    item.textContent = formatLogEntry(entry);
    logsElement.append(item);
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function formatElapsed(run: AutomationRun | undefined): string {
  if (!run) return "--";
  const end = run.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - run.createdAt) / 1_000));
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function updateElapsed(): void {
  if (runElapsedElement) runElapsedElement.textContent = formatElapsed(latestRun);
}

function readableCategory(category: StatsHistoryCategory): string {
  return category === "unknown" ? "Uncategorized" : `${category[0].toLocaleUpperCase()}${category.slice(1)}`;
}

function cleanLifetimeSavings(value: string | undefined): string | undefined {
  return value?.replace(/^Coins have saved\s+/u, "");
}

function renderStats(snapshot: StatsSnapshot | undefined, refreshing: boolean | undefined): void {
  latestStats = snapshot;
  renderAuthBanner(snapshot);
  const balance = snapshot?.coinCountRaw ?? "--";
  if (headerBalanceElement) headerBalanceElement.textContent = balance;
  headerBalancePill?.setAttribute("aria-label", `Current balance: ${balance === "--" ? "unavailable" : `${balance} coins`}`);
  if (!snapshot) {
    if (statsStateElement) statsStateElement.textContent = refreshing ? "Refreshing" : "Unavailable";
    if (statsBalanceElement) statsBalanceElement.textContent = "--";
    if (statsCurrentSavingsElement) statsCurrentSavingsElement.textContent = "--";
    if (statsLifetimeSavingsElement) statsLifetimeSavingsElement.textContent = "--";
    if (statsMetaElement) statsMetaElement.textContent = "Stats have not been collected.";
    renderHistory(undefined);
    return;
  }

  if (statsStateElement) {
    statsStateElement.textContent = snapshot.accountState.replaceAll("-", " ");
    statsStateElement.classList.toggle("active", !snapshot.stale && snapshot.accountState === "authenticated");
  }
  if (statsBalanceElement) statsBalanceElement.textContent = snapshot.coinCountRaw ?? "--";
  if (statsCurrentSavingsElement) statsCurrentSavingsElement.textContent = snapshot.currentSavingsRaw ?? "--";
  if (statsLifetimeSavingsElement) statsLifetimeSavingsElement.textContent = cleanLifetimeSavings(snapshot.lifetimeSavingsRaw) ?? "--";
  if (statsMetaElement) {
    const freshness = snapshot.stale ? "Stale" : "Updated";
    statsMetaElement.textContent = `${freshness} ${new Date(snapshot.source.observedAt).toLocaleTimeString()} via ${snapshot.source.kind} · ${snapshot.history.length} stored entries`;
  }
  renderHistory(snapshot);
  const state = `${snapshot.accountState}:${snapshot.stale}`;
  if (state !== lastStatsState) {
    lastStatsState = state;
    announce(`Stats ${snapshot.accountState}${snapshot.stale ? ", showing stale values" : " updated"}.`);
  }
}

function renderHistory(snapshot: StatsSnapshot | undefined): void {
  if (!historyListElement || !historyEmptyElement) return;
  const selected = (historyFilter?.value ?? "all") as StatsHistoryCategory | "all";
  const entries = (snapshot?.history ?? [])
    .filter((entry) => selected === "all" || entry.category === selected)
    .slice(0, 12);
  historyListElement.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.setAttribute("role", "listitem");
    const details = document.createElement("div");
    const title = document.createElement("span");
    title.className = "history-row-title";
    title.textContent = entry.title;
    const meta = document.createElement("span");
    meta.className = "history-row-meta";
    meta.textContent = `${entry.dateLabel ?? entry.dateKey ?? "Undated"} · ${readableCategory(entry.category)}`;
    details.append(title, meta);
    const amount = document.createElement("strong");
    amount.className = "history-row-amount";
    amount.textContent = entry.amountRaw;
    row.append(details, amount);
    historyListElement.append(row);
  }
  historyEmptyElement.hidden = entries.length > 0;
}

function renderDiagnostics(diagnostics: DiagnosticsSnapshot | undefined): void {
  if (!diagnosticsSummaryElement || !diagnosticsTasksElement || !diagnosticsMismatchesElement) return;
  diagnosticsTasksElement.replaceChildren();
  if (!diagnostics?.run) {
    diagnosticsSummaryElement.textContent = "No run diagnostics are available.";
  } else {
    const run = diagnostics.run;
    diagnosticsSummaryElement.textContent = `${readableState(run.state)} · attempt ${run.attempt} · ${run.tasks.length} enabled tasks · updated ${new Date(run.updatedAt).toLocaleTimeString()}`;
    for (const task of run.tasks) {
      const row = document.createElement("div");
      row.className = "diagnostic-task";
      row.setAttribute("role", "listitem");
      const details = document.createElement("div");
      const title = document.createElement("span");
      title.className = "diagnostic-task-title";
      title.textContent = TASK_CATALOG_BY_ID[task.id]?.title ?? task.id;
      const detail = document.createElement("span");
      detail.className = "diagnostic-task-detail";
      detail.textContent = task.error ?? task.completionEvidence?.detail ?? `${task.attempts} attempt${task.attempts === 1 ? "" : "s"}`;
      details.append(title, detail);
      const state = document.createElement("strong");
      state.className = `diagnostic-task-state ${task.state}`;
      state.textContent = readableState(task.state);
      row.append(details, state);
      diagnosticsTasksElement.append(row);
    }
  }
  diagnosticsMismatchesElement.textContent = diagnostics?.selectorMismatches.length
    ? `${diagnostics.selectorMismatches.length} selector contract mismatch${diagnostics.selectorMismatches.length === 1 ? "" : "es"}: ${diagnostics.selectorMismatches.map((mismatch) => `${mismatch.route}/${mismatch.contract}`).join(", ")}`
    : "No selector contract mismatches detected in stored reports.";
}

function observationsAsText(): string {
  if (!observationsElement) return "";
  return [...observationsElement.querySelectorAll<HTMLElement>(".observation")]
    .map((row) => {
      const label = row.querySelector("dt")?.textContent?.trim() ?? "";
      const value = row.querySelector("dd")?.textContent?.trim() ?? "";
      return `${label}: ${value}`;
    })
    .filter((line) => !line.startsWith(": "))
    .join("\n");
}

function describeAutomation(run: AutomationRun | undefined, logs: AutomationLogEntry[] | undefined, automationSessionActive: boolean | undefined): void {
  if (!runStateElement || !automationStatusElement || !logsElement) return;
  const owned = hasOwnedAutomationSession(run, automationSessionActive);
  const active = Boolean(run && !isRunTerminal(run) && owned);
  const stale = Boolean(run && !isRunTerminal(run) && !owned);
  latestRun = run;
  runStateElement.textContent = run ? readableState(run.state) : "Idle";
  runStateElement.classList.toggle("active", active);
  automationStatusElement.textContent = run
    ? `${run.executionMode} ${run.trigger} run ${run.id.slice(0, 8)}${stale ? " (session missing; start will recover it)" : ""}${run.lastError ? `: ${run.lastError}` : ""}`
    : "No automation run has started.";
  if (runButton) runButton.disabled = active;
  if (stopAutomationButton) stopAutomationButton.disabled = isRunTerminal(run);
  if (runProgressElement) {
      const tasks = run?.taskOrder.map((taskId) => run.tasks[taskId]) ?? [];
      const completed = tasks.filter((task) => task.state === "complete").length;
      runProgressElement.textContent = run ? `${completed}/${tasks.length} completed` : "Idle";
  }
  if (runCurrentTaskElement) {
    runCurrentTaskElement.textContent = run?.currentTaskId
      ? TASK_CATALOG_BY_ID[run.currentTaskId]?.title ?? run.currentTaskId
      : "--";
  }
  updateElapsed();
  if (run && run.state !== lastRunState) {
    lastRunState = run.state;
    announce(`Automation ${readableState(run.state)}.`);
  }

  latestLogs = logs ?? [];
  renderLogRunFilter(run, latestLogs);
  const selectedLogs = logsForRun(latestLogs, selectedLogRunId);
  if (copyLogsButton) copyLogsButton.disabled = selectedLogs.length === 0;
  if (copyAllLogsButton) copyAllLogsButton.disabled = latestLogs.length === 0;
  renderLogEntries(selectedLogs);
}

function describeReport(report: Phase0Report | undefined, sessions: ProbeSession[] | undefined): void {
  if (!statusElement || !observationsElement) return;
  observationsElement.replaceChildren();

  if (!report) {
    statusElement.textContent = sessions?.length
      ? `${sessions.length} probe window${sessions.length === 1 ? "" : "s"} open; waiting for a report.`
      : "No probe window has reported yet.";
    return;
  }

  statusElement.textContent = `Last report: ${new Date(report.at).toLocaleTimeString()} (${report.route})`;
  if (report.tabId !== undefined) addObservation("Report tab", String(report.tabId));
  addObservation("Page", report.url);
  addObservation("Document", `${report.page.readyState} / ${report.page.bodyTextLength} text chars`);
  addObservation("#root", report.page.rootFound ? "present" : "missing");
  addObservation("#signButton", report.page.signButtonFound ? "present" : "missing");
  addObservation("Compact viewport", `${report.environment.innerWidth} x ${report.environment.innerHeight}`);
  addObservation("Device pixel ratio", String(report.environment.devicePixelRatio));
  addObservation("Touch points", String(report.environment.maxTouchPoints));
  addObservation("Touch event API", report.environment.hasTouchEvent ? "present" : "absent");
  addObservation("DNR target UA (verify Network)", MOBILE_USER_AGENT);
  addObservation("JavaScript UA", report.environment.navigatorUserAgent);
  addObservation(
    "UA-CH mobile",
    report.environment.userAgentData?.mobile === undefined ? "unavailable" : String(report.environment.userAgentData.mobile)
  );
  if (report.environment.userAgentData?.platform) {
    addObservation("UA-CH platform", report.environment.userAgentData.platform);
  }

  if (report.coinIndex) {
    addObservation(
      "Coin button",
      `${report.coinIndex.buttonText || "(empty)"} / ${report.coinIndex.state} / visible ${report.coinIndex.buttonVisible} / geometry ${report.coinIndex.buttonHasGeometry}`
    );
  }
  if (report.taskDrawer) {
    addObservation("Task drawer", report.taskDrawer.found ? `${report.taskDrawer.rowCount} rows` : "not detected");
  }
  if (report.surprise) {
    addObservation("Surprise grid", report.surprise.found ? `${report.surprise.cardIds.length} cards` : "not detected");
  }
  if (report.quiz) {
    addObservation("Quiz", report.quiz.found ? `${report.quiz.options.length} options` : "not detected");
  }
  if (report.stats) {
    addObservation("Stats", report.stats.found ? `${report.stats.historyEntryCount} history entries` : "not detected");
  }
  if (report.overlays.length) {
    addObservation("Visible overlays", report.overlays.map((overlay) => overlay.phrase).join(", "));
  }
}

function describeStats(snapshot: StatsSnapshot | undefined, refreshing: boolean | undefined): void {
  if (!snapshot) {
    addObservation("Stats cache", refreshing ? "refreshing" : "not available");
    return;
  }
  const freshness = snapshot.stale ? "stale" : "fresh";
  const values = snapshot.coinCountRaw ? `${snapshot.coinCountRaw} coins` : "no balance";
  addObservation("Stats cache", `${snapshot.accountState} / ${freshness} / ${values}`);
  addObservation("Stats source", snapshot.source.url ?? snapshot.source.kind);
  addObservation("Stats checked", new Date(snapshot.source.observedAt).toLocaleTimeString());
  if (snapshot.warnings.length) addObservation("Stats warnings", snapshot.warnings.join("; "));
}

async function refresh(requestStats = false, forceStats = false): Promise<void> {
  if (requestStats) await send({ type: "STATS_REFRESH", force: forceStats });
  const response = await send({ type: "PHASE0_GET_STATE" });
  if (!response.ok) {
    if (statusElement) statusElement.textContent = response.error ?? "Unable to read probe state";
    return;
  }
  describeReport(latestReport(response.reports, response.sessions), response.sessions);
  renderStats(response.stats, response.statsRefreshing);
  describeStats(response.stats, response.statsRefreshing);
  describeAutomation(response.run, response.logs, response.automationSessionActive);
  renderDiagnostics(response.diagnostics);
}

runButton?.addEventListener("click", async () => {
  runButton.disabled = true;
  if (automationStatusElement) automationStatusElement.textContent = "Starting controlled automation...";
  const response = await send({ type: "AUTOMATION_START", trigger: "manual" });
  if (!response.ok && automationStatusElement) automationStatusElement.textContent = response.error ?? "Unable to start automation";
  await refresh();
});

stopAutomationButton?.addEventListener("click", async () => {
  stopAutomationButton.disabled = true;
  if (automationStatusElement) automationStatusElement.textContent = "Stopping automation...";
  const response = await send({ type: "AUTOMATION_STOP" });
  if (!response.ok && automationStatusElement) automationStatusElement.textContent = response.error ?? "Unable to stop automation";
  await refresh();
});

clearLogsButton?.addEventListener("click", async () => {
  clearLogsButton.disabled = true;
  await send({ type: "AUTOMATION_CLEAR_LOGS" });
  clearLogsButton.disabled = false;
  await refresh();
});

logRunFilter?.addEventListener("change", () => {
  selectedLogRunId = logRunFilter.value || undefined;
  logRunSelectionTouched = true;
  const selectedLogs = logsForRun(latestLogs, selectedLogRunId);
  if (copyLogsButton) copyLogsButton.disabled = selectedLogs.length === 0;
  renderLogEntries(selectedLogs);
});

copyLogsButton?.addEventListener("click", async () => {
  const text = logsAsText(logsForRun(latestLogs, selectedLogRunId));
  if (!text) return;
  await copyText(text);
  copyLogsButton.textContent = "Copied";
  window.setTimeout(() => { copyLogsButton.textContent = "Copy run"; }, 1_500);
});

copyAllLogsButton?.addEventListener("click", async () => {
  const text = logsAsText(latestLogs);
  if (!text) return;
  await copyText(text);
  copyAllLogsButton.textContent = "Copied";
  window.setTimeout(() => { copyAllLogsButton.textContent = "Copy all"; }, 1_500);
});

copyObservationsButton?.addEventListener("click", async () => {
  const text = observationsAsText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  copyObservationsButton.textContent = "Copied";
  window.setTimeout(() => { copyObservationsButton.textContent = "Copy results"; }, 1_500);
});

exportDiagnosticsButton?.addEventListener("click", async () => {
  const response = await send({ type: "DIAGNOSTICS_EXPORT" });
  const text = response.diagnosticsExport;
  if (!response.ok || !text) {
    announce(response.error ?? "Diagnostics export is unavailable.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  exportDiagnosticsButton.textContent = "Copied";
  announce("Redacted diagnostics JSON copied.");
  window.setTimeout(() => { exportDiagnosticsButton.textContent = "Copy JSON"; }, 1_500);
});

openButton?.addEventListener("click", async () => {
  openButton.disabled = true;
  if (statusElement) statusElement.textContent = "Installing the tab-scoped mobile rule before navigation...";
  const response = await send({ type: "PHASE0_OPEN_MOBILE" });
  openButton.disabled = false;
  if (!response.ok && statusElement) statusElement.textContent = response.error ?? "Unable to open probe";
  await refresh();
});

closeButton?.addEventListener("click", async () => {
  closeButton.disabled = true;
  await send({ type: "PHASE0_CLOSE_MOBILE" });
  closeButton.disabled = false;
  await refresh();
});

probeForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = probeUrlInput?.value.trim() ?? "";
  const mobile = probeMobileInput?.checked ?? false;
  if (!isAllowedProbeUrl(url)) {
    if (statusElement) statusElement.textContent = "Use an HTTPS AliExpress coin/task/stats/item URL.";
    return;
  }
  if (statusElement) statusElement.textContent = "Opening the validated probe URL...";
  const response = await send({ type: "PHASE0_OPEN_URL", url, mobile, compact: mobile });
  if (!response.ok && statusElement) statusElement.textContent = response.error ?? "Unable to open probe URL";
  await refresh();
});

historyFilter?.addEventListener("change", () => renderHistory(latestStats));
settingsButton?.addEventListener("click", () => void openSettings());
loginButton?.addEventListener("click", () => void openAliExpressPage(loginButton, ALIEXPRESS_LOGIN_URL));
alreadyLoggedInButton?.addEventListener("click", () => void openAliExpressPage(alreadyLoggedInButton, STATS_URL));
authSignInButton?.addEventListener("click", () => void openAliExpressPage(authSignInButton, ALIEXPRESS_LOGIN_URL));
authDismissButton?.addEventListener("click", () => {
  authBannerDismissed = true;
  renderAuthBanner(latestStats);
});
themeToggle?.addEventListener("click", async () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next: PopupTheme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.local.set({ [POPUP_THEME_KEY]: next });
});
refreshButton?.addEventListener("click", () => void refresh(true, true));
chrome.storage.onChanged.addListener(() => void refresh());
window.setInterval(updateElapsed, 1_000);

async function initializePopup(): Promise<void> {
  await initializeTheme();
  let loginStartSeen = false;
  try {
    const result = await chrome.storage.local.get(POPUP_LOGIN_START_SEEN_KEY);
    loginStartSeen = result[POPUP_LOGIN_START_SEEN_KEY] === true;
  } catch {
    // Keep the login gate visible when storage is unavailable.
  }

  if (!loginStartSeen) {
    showLoginScreen();
    try {
      await chrome.storage.local.set({ [POPUP_LOGIN_START_SEEN_KEY]: true });
    } catch {
      // The gate remains usable even if its one-time state cannot be persisted.
    }
    return;
  }

  showDashboard();
  await refresh(true, true);
}

void initializePopup();
