import { POPUP_THEME_KEY } from "../shared/constants";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { TASK_CATALOG } from "../shared/task-catalog";
import type { AutomationSettings, Phase0Message, Phase0Response } from "../shared/types";

const saved = document.querySelector<HTMLElement>("#saved");
const scheduleEnabled = document.querySelector<HTMLInputElement>("#schedule-enabled");
const scheduleTime = document.querySelector<HTMLInputElement>("#schedule-time");
const scheduleCatchUp = document.querySelector<HTMLSelectElement>("#schedule-catch-up");
const executionMode = document.querySelector<HTMLSelectElement>("#execution-mode");
const compactWindow = document.querySelector<HTMLInputElement>("#compact-window");
const focusManualRuns = document.querySelector<HTMLInputElement>("#focus-manual-runs");
const focusScheduledRuns = document.querySelector<HTMLInputElement>("#focus-scheduled-runs");
const stopUnknownState = document.querySelector<HTMLInputElement>("#stop-unknown-state");
const taskSettings = document.querySelector<HTMLElement>("#task-settings");
const selectAllTasks = document.querySelector<HTMLButtonElement>("#select-all-tasks");
const selectNoneTasks = document.querySelector<HTMLButtonElement>("#select-none-tasks");
const resetSettings = document.querySelector<HTMLButtonElement>("#reset-settings");
const statsEnabled = document.querySelector<HTMLInputElement>("#stats-enabled");
const statsRefreshMinutes = document.querySelector<HTMLInputElement>("#stats-refresh-minutes");
const notificationsEnabled = document.querySelector<HTMLInputElement>("#notifications-enabled");
const notificationLogin = document.querySelector<HTMLInputElement>("#notification-login");
const notificationComplete = document.querySelector<HTMLInputElement>("#notification-complete");
const notificationPartial = document.querySelector<HTMLInputElement>("#notification-partial");
const notificationFailure = document.querySelector<HTMLInputElement>("#notification-failure");
const historyRetentionMonths = document.querySelector<HTMLInputElement>("#history-retention-months");
const diagnosticsRetentionDays = document.querySelector<HTMLInputElement>("#diagnostics-retention-days");
const clearHistory = document.querySelector<HTMLButtonElement>("#clear-history");
const clearDiagnostics = document.querySelector<HTMLButtonElement>("#clear-diagnostics");
const dataStatus = document.querySelector<HTMLElement>("#data-status");
const credentialUsername = document.querySelector<HTMLInputElement>("#credentials-username");
const credentialPassword = document.querySelector<HTMLInputElement>("#credentials-password");
const credentialBadge = document.querySelector<HTMLElement>("#credentials-badge");
const credentialStatus = document.querySelector<HTMLElement>("#credentials-status");
const credentialSave = document.querySelector<HTMLButtonElement>("#credentials-save");
const credentialClear = document.querySelector<HTMLButtonElement>("#credentials-clear");
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
const themeLabel = document.querySelector<HTMLElement>("#theme-label");
let currentSettings: AutomationSettings = DEFAULT_SETTINGS;

type SettingsTheme = "light" | "dark";

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

function applyTheme(theme: SettingsTheme): void {
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

function renderTaskSettings(settings: AutomationSettings): void {
  if (!taskSettings) return;
  taskSettings.replaceChildren();
  for (const task of TASK_CATALOG) {
    const label = document.createElement("label");
    label.className = "task-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.task = task.id;
    checkbox.checked = settings.automation.enabledTaskIds.includes(task.id);
    const copy = document.createElement("span");
    copy.className = "task-copy";
    const title = document.createElement("strong");
    title.className = "task-title";
    title.textContent = task.title;
    const meta = document.createElement("span");
    meta.className = "task-meta";
    const mode = task.policy === "assisted" ? "Manual finish" : task.policy === "quiz" ? "Daily quiz" : "Automatic";
    const creditLabel = task.goal === 1 ? "credit" : "credits";
    meta.textContent = `${mode} · ${task.goal} ${creditLabel}`;
    copy.append(title, meta);
    label.append(checkbox, copy);
    taskSettings.append(label);
  }
}

function readSettings(base: AutomationSettings): AutomationSettings {
  const enabledTaskIds = [...document.querySelectorAll<HTMLInputElement>("input[data-task]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.task)
    .filter((id): id is AutomationSettings["automation"]["enabledTaskIds"][number] => Boolean(id));
  return {
    ...base,
    schedule: {
      ...base.schedule,
      enabled: scheduleEnabled?.checked ?? base.schedule.enabled,
      localTime: scheduleTime?.value || base.schedule.localTime,
      catchUp: (scheduleCatchUp?.value as AutomationSettings["schedule"]["catchUp"] | undefined) ?? base.schedule.catchUp
    },
    automation: {
      ...base.automation,
      executionMode: (executionMode?.value as AutomationSettings["automation"]["executionMode"] | undefined) ?? base.automation.executionMode,
      enabledTaskIds,
      compactWindow: compactWindow?.checked ?? base.automation.compactWindow,
      focusManualRuns: focusManualRuns?.checked ?? base.automation.focusManualRuns,
      focusScheduledRuns: focusScheduledRuns?.checked ?? base.automation.focusScheduledRuns,
      stopOnUnknownTaskState: stopUnknownState?.checked ?? base.automation.stopOnUnknownTaskState
    },
    stats: {
      ...base.stats,
      enabled: statsEnabled?.checked ?? base.stats.enabled,
      refreshMinutes: numericValue(statsRefreshMinutes, base.stats.refreshMinutes)
    },
    notifications: {
      ...base.notifications,
      enabled: notificationsEnabled?.checked ?? base.notifications.enabled,
      loginRequired: notificationLogin?.checked ?? base.notifications.loginRequired,
      runCompleted: notificationComplete?.checked ?? base.notifications.runCompleted,
      partialRun: notificationPartial?.checked ?? base.notifications.partialRun,
      failures: notificationFailure?.checked ?? base.notifications.failures
    },
    privacy: {
      ...base.privacy,
      historyRetentionMonths: numericValue(historyRetentionMonths, base.privacy.historyRetentionMonths),
      diagnosticsRetentionDays: numericValue(diagnosticsRetentionDays, base.privacy.diagnosticsRetentionDays)
    },
    timeouts: {
      ...base.timeouts,
      pageLoadMs: numericValue(document.querySelector<HTMLInputElement>("#page-load-timeout"), base.timeouts.pageLoadMs),
      childCommitMs: numericValue(document.querySelector<HTMLInputElement>("#child-commit-timeout"), base.timeouts.childCommitMs),
      passiveDwellMs: numericValue(document.querySelector<HTMLInputElement>("#passive-dwell-timeout"), base.timeouts.passiveDwellMs),
      assistedDwellMs: numericValue(document.querySelector<HTMLInputElement>("#assisted-dwell-timeout"), base.timeouts.assistedDwellMs)
    }
  };
}

function setTaskSelection(checked: boolean): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-task]")) input.checked = checked;
}

function numericValue(input: HTMLInputElement | null, fallback: number): number {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function setNumber(input: HTMLInputElement | null, value: number): void {
  if (input) input.value = String(value);
}

async function saveSettings(settings: AutomationSettings): Promise<void> {
  const response = await send({ type: "AUTOMATION_SAVE_SETTINGS", settings });
  if (response.ok && response.settings) currentSettings = response.settings;
  if (saved) saved.textContent = response.ok ? `Settings saved ${new Date().toLocaleTimeString()}` : response.error ?? "Could not save settings";
}

async function loadSettings(): Promise<void> {
  const response = await send({ type: "AUTOMATION_GET_STATE" });
  const settings = response.settings ?? DEFAULT_SETTINGS;
  currentSettings = settings;
  if (scheduleEnabled) scheduleEnabled.checked = settings.schedule.enabled;
  if (scheduleTime) scheduleTime.value = settings.schedule.localTime;
  if (scheduleCatchUp) scheduleCatchUp.value = settings.schedule.catchUp;
  if (executionMode) executionMode.value = settings.automation.executionMode;
  if (compactWindow) compactWindow.checked = settings.automation.compactWindow;
  if (focusManualRuns) focusManualRuns.checked = settings.automation.focusManualRuns;
  if (focusScheduledRuns) focusScheduledRuns.checked = settings.automation.focusScheduledRuns;
  if (stopUnknownState) stopUnknownState.checked = settings.automation.stopOnUnknownTaskState;
  if (statsEnabled) statsEnabled.checked = settings.stats.enabled;
  setNumber(statsRefreshMinutes, settings.stats.refreshMinutes);
  if (notificationsEnabled) notificationsEnabled.checked = settings.notifications.enabled;
  if (notificationLogin) notificationLogin.checked = settings.notifications.loginRequired;
  if (notificationComplete) notificationComplete.checked = settings.notifications.runCompleted;
  if (notificationPartial) notificationPartial.checked = settings.notifications.partialRun;
  if (notificationFailure) notificationFailure.checked = settings.notifications.failures;
  setNumber(historyRetentionMonths, settings.privacy.historyRetentionMonths);
  setNumber(diagnosticsRetentionDays, settings.privacy.diagnosticsRetentionDays);
  setNumber(document.querySelector<HTMLInputElement>("#page-load-timeout"), settings.timeouts.pageLoadMs);
  setNumber(document.querySelector<HTMLInputElement>("#child-commit-timeout"), settings.timeouts.childCommitMs);
  setNumber(document.querySelector<HTMLInputElement>("#passive-dwell-timeout"), settings.timeouts.passiveDwellMs);
  setNumber(document.querySelector<HTMLInputElement>("#assisted-dwell-timeout"), settings.timeouts.assistedDwellMs);
  renderTaskSettings(settings);
  const saveCurrent = () => void saveSettings(readSettings(currentSettings));
  scheduleEnabled?.addEventListener("change", saveCurrent);
  scheduleTime?.addEventListener("change", saveCurrent);
  scheduleCatchUp?.addEventListener("change", saveCurrent);
  executionMode?.addEventListener("change", saveCurrent);
  compactWindow?.addEventListener("change", saveCurrent);
  focusManualRuns?.addEventListener("change", saveCurrent);
  focusScheduledRuns?.addEventListener("change", saveCurrent);
  stopUnknownState?.addEventListener("change", saveCurrent);
  statsEnabled?.addEventListener("change", saveCurrent);
  statsRefreshMinutes?.addEventListener("change", saveCurrent);
  notificationsEnabled?.addEventListener("change", saveCurrent);
  notificationLogin?.addEventListener("change", saveCurrent);
  notificationComplete?.addEventListener("change", saveCurrent);
  notificationPartial?.addEventListener("change", saveCurrent);
  notificationFailure?.addEventListener("change", saveCurrent);
  historyRetentionMonths?.addEventListener("change", saveCurrent);
  diagnosticsRetentionDays?.addEventListener("change", saveCurrent);
  for (const input of document.querySelectorAll<HTMLInputElement>("input[data-timeout]")) input.addEventListener("change", saveCurrent);
  taskSettings?.addEventListener("change", saveCurrent);
  await loadCredentialStatus();
  credentialSave?.addEventListener("click", () => void saveCredentials());
  credentialClear?.addEventListener("click", () => void clearCredentials());
  selectAllTasks?.addEventListener("click", () => {
    setTaskSelection(true);
    void saveCurrent();
  });
  selectNoneTasks?.addEventListener("click", () => {
    setTaskSelection(false);
    void saveCurrent();
  });
  resetSettings?.addEventListener("click", () => {
    if (scheduleEnabled) scheduleEnabled.checked = DEFAULT_SETTINGS.schedule.enabled;
    if (scheduleTime) scheduleTime.value = DEFAULT_SETTINGS.schedule.localTime;
    if (scheduleCatchUp) scheduleCatchUp.value = DEFAULT_SETTINGS.schedule.catchUp;
    if (executionMode) executionMode.value = DEFAULT_SETTINGS.automation.executionMode;
    if (compactWindow) compactWindow.checked = DEFAULT_SETTINGS.automation.compactWindow;
    if (focusManualRuns) focusManualRuns.checked = DEFAULT_SETTINGS.automation.focusManualRuns;
    if (focusScheduledRuns) focusScheduledRuns.checked = DEFAULT_SETTINGS.automation.focusScheduledRuns;
    if (stopUnknownState) stopUnknownState.checked = DEFAULT_SETTINGS.automation.stopOnUnknownTaskState;
    if (statsEnabled) statsEnabled.checked = DEFAULT_SETTINGS.stats.enabled;
    setNumber(statsRefreshMinutes, DEFAULT_SETTINGS.stats.refreshMinutes);
    if (notificationsEnabled) notificationsEnabled.checked = DEFAULT_SETTINGS.notifications.enabled;
    if (notificationLogin) notificationLogin.checked = DEFAULT_SETTINGS.notifications.loginRequired;
    if (notificationComplete) notificationComplete.checked = DEFAULT_SETTINGS.notifications.runCompleted;
    if (notificationPartial) notificationPartial.checked = DEFAULT_SETTINGS.notifications.partialRun;
    if (notificationFailure) notificationFailure.checked = DEFAULT_SETTINGS.notifications.failures;
    setNumber(historyRetentionMonths, DEFAULT_SETTINGS.privacy.historyRetentionMonths);
    setNumber(diagnosticsRetentionDays, DEFAULT_SETTINGS.privacy.diagnosticsRetentionDays);
    setNumber(document.querySelector<HTMLInputElement>("#page-load-timeout"), DEFAULT_SETTINGS.timeouts.pageLoadMs);
    setNumber(document.querySelector<HTMLInputElement>("#child-commit-timeout"), DEFAULT_SETTINGS.timeouts.childCommitMs);
    setNumber(document.querySelector<HTMLInputElement>("#passive-dwell-timeout"), DEFAULT_SETTINGS.timeouts.passiveDwellMs);
    setNumber(document.querySelector<HTMLInputElement>("#assisted-dwell-timeout"), DEFAULT_SETTINGS.timeouts.assistedDwellMs);
    renderTaskSettings(DEFAULT_SETTINGS);
    currentSettings = DEFAULT_SETTINGS;
    void saveSettings(DEFAULT_SETTINGS);
  });
}

async function loadCredentialStatus(): Promise<void> {
  const response = await send({ type: "CREDENTIALS_GET_STATUS" });
  const savedCredential = response.credentialStatus?.saved === true;
  if (credentialUsername) credentialUsername.value = savedCredential ? response.credentialStatus?.username ?? "" : "";
  if (credentialPassword) credentialPassword.value = "";
  if (credentialBadge) credentialBadge.textContent = !response.ok ? "Needs attention" : savedCredential ? "Saved" : "Not saved";
  if (credentialClear) credentialClear.disabled = response.ok && !savedCredential;
  if (credentialStatus) {
    credentialStatus.textContent = response.ok
      ? savedCredential ? "Saved credentials are ready for an automation sign-in." : "No credentials saved. Automation will pause for manual sign-in."
      : response.error ?? "Could not read saved credential status.";
  }
}

async function saveCredentials(): Promise<void> {
  const username = credentialUsername?.value.trim() ?? "";
  let password = credentialPassword?.value ?? "";
  if (!username || !password) {
    if (credentialStatus) credentialStatus.textContent = "Enter both your AliExpress account and password to save them.";
    return;
  }
  if (credentialSave) credentialSave.disabled = true;
  if (credentialStatus) credentialStatus.textContent = "Encrypting and saving credentials…";
  try {
    const response = await send({ type: "CREDENTIALS_SAVE", username, password });
    if (!response.ok) {
      if (credentialStatus) credentialStatus.textContent = response.error ?? "Credentials could not be saved.";
      return;
    }
    if (credentialUsername) credentialUsername.value = response.credentialStatus?.username ?? username;
    if (credentialPassword) credentialPassword.value = "";
    if (credentialBadge) credentialBadge.textContent = "Saved";
    if (credentialClear) credentialClear.disabled = false;
    if (credentialStatus) credentialStatus.textContent = "Credentials encrypted and saved in this Chrome profile.";
  } finally {
    password = "";
    if (credentialPassword) credentialPassword.value = "";
    if (credentialSave) credentialSave.disabled = false;
  }
}

async function clearCredentials(): Promise<void> {
  if (!window.confirm("Clear the saved AliExpress sign-in details from this Chrome profile?")) return;
  if (credentialClear) credentialClear.disabled = true;
  const response = await send({ type: "CREDENTIALS_CLEAR" });
  if (!response.ok) {
    if (credentialStatus) credentialStatus.textContent = response.error ?? "Saved credentials could not be cleared.";
    if (credentialClear) credentialClear.disabled = false;
    return;
  }
  if (credentialUsername) credentialUsername.value = "";
  if (credentialPassword) credentialPassword.value = "";
  if (credentialBadge) credentialBadge.textContent = "Not saved";
  if (credentialStatus) credentialStatus.textContent = "Saved credentials cleared.";
}

async function clearLocalData(message: Phase0Message, label: string): Promise<void> {
  const response = await send(message);
  if (dataStatus) dataStatus.textContent = response.ok ? `${label} cleared ${new Date().toLocaleTimeString()}` : response.error ?? `Could not clear ${label.toLocaleLowerCase()}`;
}

themeToggle?.addEventListener("click", async () => {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next: SettingsTheme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.local.set({ [POPUP_THEME_KEY]: next });
});
clearHistory?.addEventListener("click", () => void clearLocalData({ type: "STATS_CLEAR_HISTORY" }, "History"));
clearDiagnostics?.addEventListener("click", () => void clearLocalData({ type: "DIAGNOSTICS_CLEAR" }, "Diagnostics"));
void initializeTheme();
void loadSettings();
