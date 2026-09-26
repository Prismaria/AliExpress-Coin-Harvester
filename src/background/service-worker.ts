import {
  ACTION_ICON_PATHS,
  ALIEXPRESS_RESOURCE_TYPES,
  AUTOMATION_POPUP_HEIGHT,
  AUTOMATION_POPUP_WIDTH,
  AUTOMATION_WINDOW_GAP,
  AUTOMATION_LEASE_KEY,
  AUTOMATION_LOGS_KEY,
  AUTOMATION_RUN_KEY,
  AUTOMATION_SESSION_KEY,
  AUTOMATION_SETTINGS_KEY,
  AUTOMATION_POLL_INTERVAL_MS,
  CHILD_CLOSE_ALARM_PREFIX,
  CHILD_READY_WATCHDOG_PREFIX,
  COIN_INDEX_URL,
  CONTROLLED_CHILD_LAUNCH_DELAY_MS,
  CONTROLLED_CHILD_LAUNCH_PREFIX,
  DAILY_COLLECT_RETRY_DELAY_MS,
  DAILY_ALARM_NAME,
  MAX_STORED_REPORTS,
  MAX_AUTOMATION_LOGS,
  MOBILE_RULE_ID_START,
  MOBILE_SESSION_KEY,
  MOBILE_USER_AGENT,
  OPTIONAL_NAVIGATION_GRACE_PREFIX,
  NAVIGATION_WATCHDOG_PREFIX,
  NOTIFICATION_ICON_URL,
  OPTIONAL_CHILD_CLOSE_MS,
  POST_CHILD_RESUME_DELAY_MS,
  PHASE0_REPORTS_KEY,
  POPUP_THEME_KEY,
  RECONCILE_ALARM_NAME,
  RETRY_ALARM_PREFIX,
  STATS_CACHE_KEY,
  STATS_HISTORY_KEY,
  STATS_REFRESH_ALARM_NAME,
  TASK_DRAWER_CONFIRMATION_WAIT_MS,
  STATS_URL,
  TASK_OUTCOME_CHECK_PREFIX,
  TASK_ROW_WAIT_MS
} from "../shared/constants";
import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/settings";
import {
  TASK_CATALOG,
  TASK_CATALOG_BY_ID,
  mostAdvancedTaskProgress,
  taskActionAttemptLimit,
  taskAllowsRoute,
  taskClicksRemaining,
  taskChildDwellMs,
  taskDestinationMatters,
  taskDestinationMatches,
  taskOutcomeWaitMs,
  taskRowDisappearsOnCompletion,
  taskRetriesUntilComplete,
  taskRequiresChildNavigation
} from "../shared/task-catalog";
import { classifyRoute, isAliExpressPageUrl, isAllowedProbeUrl, safeUrl } from "../shared/routes";
import { cacheStatsSnapshot, createRefreshCoalescer, formatCoinBadge, isStatsCacheFresh, isStatsCacheRecord, isStatsHistoryCacheRecord, markStatsCacheStale, STATS_HISTORY_CACHE_SCHEMA_VERSION } from "../shared/stats-cache";
import { MAX_STORED_HISTORY_ENTRIES, mergeHistory } from "../shared/stats-history";
import { notificationForRun } from "../shared/notifications";
import { buildDiagnostics, diagnosticsJson } from "../shared/diagnostics";
import type {
  AutomationChildTab,
  AutomationContentCommand,
  AutomationContentResponse,
  AutomationLease,
  AutomationLogEntry,
  AutomationRun,
  AutomationSession,
  AutomationSettings,
  AutomationResult,
  ExpectedNavigation,
  Phase0Message,
  Phase0Report,
  Phase0Response,
  ProbeSession,
  RouteKind,
  RunState,
  RunTrigger,
  StatsCacheRecord,
  StatsHistoryCacheRecord,
  StatsSnapshot,
  TaskId,
  TaskRun
} from "../shared/types";

type SessionMap = Record<string, ProbeSession>;

let mutationQueue = Promise.resolve();
const activeMainDrives = new Set<string>();
const pendingMainDrives = new Set<string>();
const activeChildControllers = new Set<number>();
const activeTaskOutcomeWaits = new Set<string>();
const statsRefreshCoalescer = createRefreshCoalescer<StatsSnapshot | undefined>();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function getSessionMap(): Promise<SessionMap> {
  const [sessionResult, localResult] = await Promise.all([
    chrome.storage.session.get(MOBILE_SESSION_KEY),
    chrome.storage.local.get(MOBILE_SESSION_KEY)
  ]);
  return (sessionResult[MOBILE_SESSION_KEY] as SessionMap | undefined)
    ?? (localResult[MOBILE_SESSION_KEY] as SessionMap | undefined)
    ?? {};
}

async function setSessionMap(sessions: SessionMap): Promise<void> {
  await Promise.all([
    chrome.storage.session.set({ [MOBILE_SESSION_KEY]: sessions }),
    chrome.storage.local.set({ [MOBILE_SESSION_KEY]: sessions })
  ]);
}

async function getReports(): Promise<Phase0Report[]> {
  const result = await chrome.storage.local.get(PHASE0_REPORTS_KEY);
  return (result[PHASE0_REPORTS_KEY] as Phase0Report[] | undefined) ?? [];
}

async function storeReport(report: Phase0Report, tabId?: number): Promise<void> {
  const reports = await getReports();
  const stored = tabId === undefined || report.tabId === tabId ? report : { ...report, tabId };
  const next = [stored, ...reports.filter((existing) => {
    if (existing.tabId !== undefined || stored.tabId !== undefined) return existing.tabId !== stored.tabId;
    return existing.url !== stored.url;
  })].slice(0, MAX_STORED_REPORTS);
  await chrome.storage.local.set({ [PHASE0_REPORTS_KEY]: next });
}

async function getStatsCache(): Promise<StatsCacheRecord | undefined> {
  const result = await chrome.storage.local.get(STATS_CACHE_KEY);
  const cache = result[STATS_CACHE_KEY];
  return isStatsCacheRecord(cache) ? cache : undefined;
}

async function setStatsCache(cache: StatsCacheRecord | undefined): Promise<void> {
  if (cache) await chrome.storage.local.set({ [STATS_CACHE_KEY]: cache });
  else await chrome.storage.local.remove(STATS_CACHE_KEY);
  await syncStatsBadge(cache?.snapshot);
}

async function syncStatsBadge(snapshot: StatsSnapshot | undefined): Promise<void> {
  const exactBalance = snapshot?.coinCountRaw;
  const badgeText = formatCoinBadge(exactBalance);
  try {
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setTitle({
      title: exactBalance ? `Ali Coin Harvester · ${exactBalance} coins` : "Ali Coin Harvester"
    });
  } catch (error) {
    console.warn("Could not update the coin balance badge", error);
  }
}

async function getStatsHistoryCache(): Promise<StatsHistoryCacheRecord | undefined> {
  const result = await chrome.storage.local.get(STATS_HISTORY_KEY);
  const cache = result[STATS_HISTORY_KEY];
  return isStatsHistoryCacheRecord(cache) ? cache : undefined;
}

async function setStatsHistoryCache(cache: StatsHistoryCacheRecord | undefined): Promise<void> {
  if (cache) await chrome.storage.local.set({ [STATS_HISTORY_KEY]: cache });
  else await chrome.storage.local.remove(STATS_HISTORY_KEY);
}

async function getSettings(): Promise<AutomationSettings> {
  const result = await chrome.storage.sync.get(AUTOMATION_SETTINGS_KEY);
  if (result[AUTOMATION_SETTINGS_KEY] === undefined) {
    await chrome.storage.sync.set({ [AUTOMATION_SETTINGS_KEY]: DEFAULT_SETTINGS });
    return normalizeSettings(DEFAULT_SETTINGS);
  }
  const stored = result[AUTOMATION_SETTINGS_KEY];
  const normalized = normalizeSettings(stored);
  const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : undefined;
  if (value?.schemaVersion !== normalized.schemaVersion || !value?.stats || !value?.notifications || !value?.privacy) {
    await chrome.storage.sync.set({ [AUTOMATION_SETTINGS_KEY]: normalized });
  }
  return normalized;
}

async function setSettings(settings: AutomationSettings): Promise<AutomationSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [AUTOMATION_SETTINGS_KEY]: normalized });
  return normalized;
}

async function syncActionIcon(rawTheme?: unknown): Promise<void> {
  let themeValue = rawTheme;
  if (themeValue === undefined) {
    const stored = await chrome.storage.local.get(POPUP_THEME_KEY);
    themeValue = stored[POPUP_THEME_KEY];
  }
  const theme = themeValue === "dark" ? "dark" : "light";
  try {
    await chrome.action.setIcon({ path: ACTION_ICON_PATHS[theme] });
    await chrome.action.setBadgeBackgroundColor({ color: theme === "dark" ? "#ffcc66" : "#ff7341" });
    await chrome.action.setBadgeTextColor({ color: theme === "dark" ? "#17130a" : "#fff9ef" });
  } catch (error) {
    console.warn("Could not update the extension icon", error);
  }
}

async function getRun(): Promise<AutomationRun | undefined> {
  const result = await chrome.storage.local.get(AUTOMATION_RUN_KEY);
  const stored = result[AUTOMATION_RUN_KEY] as (Omit<AutomationRun, "executionMode"> & {
    executionMode?: AutomationRun["executionMode"];
  }) | undefined;
  if (!stored) return undefined;
  if (stored.executionMode === "parallel" || stored.executionMode === "sequential") return stored as AutomationRun;
  const migrated = { ...stored, executionMode: "sequential" as const };
  await chrome.storage.local.set({ [AUTOMATION_RUN_KEY]: migrated });
  return migrated;
}

async function setRun(run: AutomationRun | undefined): Promise<void> {
  if (run) await chrome.storage.local.set({ [AUTOMATION_RUN_KEY]: run });
  else await chrome.storage.local.remove(AUTOMATION_RUN_KEY);
}

async function getLogs(): Promise<AutomationLogEntry[]> {
  const result = await chrome.storage.local.get(AUTOMATION_LOGS_KEY);
  return (result[AUTOMATION_LOGS_KEY] as AutomationLogEntry[] | undefined) ?? [];
}

async function cleanupDiagnostics(settings: AutomationSettings): Promise<void> {
  const cutoff = Date.now() - settings.privacy.diagnosticsRetentionDays * 24 * 60 * 60_000;
  const [reports, logs] = await Promise.all([getReports(), getLogs()]);
  const retainedReports = reports.filter((report) => report.at >= cutoff);
  const retainedLogs = logs.filter((entry) => entry.at >= cutoff);
  if (retainedReports.length !== reports.length) await chrome.storage.local.set({ [PHASE0_REPORTS_KEY]: retainedReports });
  if (retainedLogs.length !== logs.length) await chrome.storage.local.set({ [AUTOMATION_LOGS_KEY]: retainedLogs });
}

function sanitizedLogData(data: Record<string, string | number | boolean | null> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 240) : value
    ])
  );
}

async function appendLog(entry: Omit<AutomationLogEntry, "at">): Promise<void> {
  const next: AutomationLogEntry[] = [
    { ...entry, at: Date.now(), data: sanitizedLogData(entry.data) },
    ...(await getLogs())
  ].slice(0, MAX_AUTOMATION_LOGS);
  await chrome.storage.local.set({ [AUTOMATION_LOGS_KEY]: next });
  if (entry.level === "error") console.error(entry.message, entry.data);
  else if (entry.level === "warn") console.warn(entry.message, entry.data);
  else console.info(entry.message, entry.data);
}

async function notifyRunState(run: AutomationRun): Promise<void> {
  const settings = await getSettings();
  const notification = notificationForRun(run, settings);
  if (!notification) return;

  await new Promise<void>((resolve) => {
    chrome.notifications.create(`automation-${run.id}-${run.state}`, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_URL,
      title: notification.title,
      message: notification.message
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) console.warn("Could not create run notification", error.message);
      resolve();
    });
  });
}

type StoredAutomationSession = Omit<AutomationSession, "expectedNavigations"> & {
  expectedNavigations?: Record<string, ExpectedNavigation>;
  expectedNavigation?: ExpectedNavigation;
};

function isExpectedNavigation(value: unknown): value is ExpectedNavigation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.taskId === "string" &&
    Boolean(TASK_CATALOG_BY_ID[candidate.taskId as TaskId]) &&
    typeof candidate.sourceTabId === "number" &&
    Array.isArray(candidate.allowedRoutes) &&
    candidate.allowedRoutes.every((route) => typeof route === "string") &&
    typeof candidate.mobile === "boolean" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.expiresAt === "number" &&
    (candidate.status === undefined || candidate.status === "pending" || candidate.status === "direct-credited");
}

function normalizedExpectedNavigations(value: unknown): Record<string, ExpectedNavigation> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, expected]) => isExpectedNavigation(expected))
  ) as Record<string, ExpectedNavigation>;
}

async function getAutomationSession(): Promise<AutomationSession | undefined> {
  const [sessionResult, localResult] = await Promise.all([
    chrome.storage.session.get(AUTOMATION_SESSION_KEY),
    chrome.storage.local.get(AUTOMATION_SESSION_KEY)
  ]);
  const stored = (sessionResult[AUTOMATION_SESSION_KEY] ?? localResult[AUTOMATION_SESSION_KEY]) as StoredAutomationSession | undefined;
  if (!stored) return undefined;
  const expectedNavigations = normalizedExpectedNavigations(
    stored.expectedNavigations ?? (stored.expectedNavigation ? { [stored.expectedNavigation.id]: stored.expectedNavigation } : {})
  );
  if (stored.expectedNavigations && !stored.expectedNavigation && Object.keys(expectedNavigations).length === Object.keys(stored.expectedNavigations).length) {
    return { ...stored, expectedNavigations } as AutomationSession;
  }

  const { expectedNavigation, ...withoutLegacyNavigation } = stored;
  const migrated: AutomationSession = {
    ...withoutLegacyNavigation,
    expectedNavigations: expectedNavigation ? { [expectedNavigation.id]: expectedNavigation } : {}
  };
  await setAutomationSession(migrated);
  return migrated;
}

async function setAutomationSession(session: AutomationSession | undefined): Promise<void> {
  if (session) {
    await Promise.all([
      chrome.storage.session.set({ [AUTOMATION_SESSION_KEY]: session }),
      chrome.storage.local.set({ [AUTOMATION_SESSION_KEY]: session })
    ]);
  } else {
    await Promise.all([
      chrome.storage.session.remove(AUTOMATION_SESSION_KEY),
      chrome.storage.local.remove(AUTOMATION_SESSION_KEY)
    ]);
  }
}

async function getLease(): Promise<AutomationLease | undefined> {
  const [sessionResult, localResult] = await Promise.all([
    chrome.storage.session.get(AUTOMATION_LEASE_KEY),
    chrome.storage.local.get(AUTOMATION_LEASE_KEY)
  ]);
  return (sessionResult[AUTOMATION_LEASE_KEY] ?? localResult[AUTOMATION_LEASE_KEY]) as AutomationLease | undefined;
}

async function setLease(lease: AutomationLease | undefined): Promise<void> {
  if (lease) {
    await Promise.all([
      chrome.storage.session.set({ [AUTOMATION_LEASE_KEY]: lease }),
      chrome.storage.local.set({ [AUTOMATION_LEASE_KEY]: lease })
    ]);
  } else {
    await Promise.all([
      chrome.storage.session.remove(AUTOMATION_LEASE_KEY),
      chrome.storage.local.remove(AUTOMATION_LEASE_KEY)
    ]);
  }
}

async function setTrustedStorageAccess(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]).catch(() => undefined);
}

function waitForMainFrameCommit(tabId: number, timeoutMs = 30_000): { promise: Promise<void>; cancel: () => void } {
  let cancel = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      resolve();
    };
    const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
      if (details.tabId === tabId && details.frameId === 0 && details.url !== "about:blank") finish();
    };
    const timeoutId = setTimeout(finish, timeoutMs);
    cancel = finish;
    chrome.webNavigation.onCommitted.addListener(onCommitted);
  });
  return { promise, cancel };
}

async function navigateWithMobileUserAgent(tabId: number, url: string): Promise<void> {
  const target = { tabId };
  let attached = false;
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    attached = true;
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.sendCommand(target, "Emulation.setUserAgentOverride", {
        userAgent: MOBILE_USER_AGENT,
        acceptLanguage: "en-US,en;q=0.9",
        platform: "Android",
        userAgentMetadata: {
          brands: [{ brand: "Chromium", version: "140" }],
          fullVersion: "140.0.0.0",
          platform: "Android",
          platformVersion: "13",
          architecture: "arm",
          model: "Pixel 7",
          mobile: true
        }
      }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    const commit = waitForMainFrameCommit(tabId);
    try {
      await chrome.tabs.update(tabId, { url });
      await commit.promise;
    } catch (error) {
      commit.cancel();
      throw error;
    }
  } finally {
    if (attached) {
      await new Promise<void>((resolve) => {
        chrome.debugger.detach(target, () => resolve());
      });
    }
  }
}

async function removeRule(ruleId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => undefined);
}

function mobileUserAgentRule(ruleId: number, tabId: number): chrome.declarativeNetRequest.Rule {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        { header: "user-agent", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: MOBILE_USER_AGENT },
        { header: "sec-ch-ua-mobile", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "?1" },
        { header: "sec-ch-ua-platform", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: '"Android"' }
      ]
    },
    condition: {
      tabIds: [tabId],
      urlFilter: "||aliexpress.com/",
      resourceTypes: ALIEXPRESS_RESOURCE_TYPES
    }
  };
}

async function installMobileUserAgentRule(tabId: number): Promise<number> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(rules.map((rule) => rule.id));
  let ruleId = MOBILE_RULE_ID_START;
  while (used.has(ruleId)) ruleId += 1;
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [mobileUserAgentRule(ruleId, tabId)] });
  return ruleId;
}

type WindowBounds = { left: number; top: number; width: number; height: number };

function windowBounds(window: chrome.windows.Window | undefined): WindowBounds | undefined {
  if (!window || window.left === undefined || window.top === undefined || window.width === undefined || window.height === undefined) return undefined;
  return { left: window.left, top: window.top, width: window.width, height: window.height };
}

async function getDisplayWorkArea(anchor?: WindowBounds): Promise<WindowBounds> {
  try {
    const displays = await chrome.system.display.getInfo();
    const centerX = anchor ? anchor.left + anchor.width / 2 : undefined;
    const centerY = anchor ? anchor.top + anchor.height / 2 : undefined;
    const display = displays.find((candidate) => {
      if (centerX === undefined || centerY === undefined) return candidate.isPrimary;
      return centerX >= candidate.bounds.left && centerX < candidate.bounds.left + candidate.bounds.width &&
        centerY >= candidate.bounds.top && centerY < candidate.bounds.top + candidate.bounds.height;
    }) ?? displays.find((candidate) => candidate.isPrimary) ?? displays[0];
    if (display) return display.workArea;
  } catch {
    // Older or restricted Chrome environments may not expose display information.
  }
  return anchor ?? { left: 0, top: 0, width: 1920, height: 1080 };
}

async function centeredAutomationPopupBounds(): Promise<WindowBounds> {
  const anchor = windowBounds(await chrome.windows.getLastFocused().catch(() => undefined));
  const workArea = await getDisplayWorkArea(anchor);
  return {
    width: AUTOMATION_POPUP_WIDTH,
    height: AUTOMATION_POPUP_HEIGHT,
    left: Math.round(workArea.left + (workArea.width - AUTOMATION_POPUP_WIDTH) / 2),
    top: Math.round(workArea.top + (workArea.height - AUTOMATION_POPUP_HEIGHT) / 2)
  };
}

async function automationChildPopupBounds(session: AutomationSession): Promise<WindowBounds | undefined> {
  if (session.mainWindowId === undefined) return undefined;
  const mainWindow = await chrome.windows.get(session.mainWindowId).catch(() => undefined);
  const main = windowBounds(mainWindow);
  if (!main) return undefined;
  const workArea = await getDisplayWorkArea(main);
  const childWindowIds = [...new Set(Object.values(session.childTabs)
    .map((child) => child.windowId)
    .filter((windowId): windowId is number => windowId !== undefined && windowId !== session.mainWindowId))];
  const childWindows = await Promise.all(childWindowIds.map((windowId) => chrome.windows.get(windowId).catch(() => undefined)));
  const leftCount = childWindows.filter((child) => (child?.left ?? main.left) < main.left).length;
  const rightCount = childWindows.length - leftCount;
  const leftFits = main.left - AUTOMATION_WINDOW_GAP - AUTOMATION_POPUP_WIDTH >= workArea.left;
  const rightFits = main.left + main.width + AUTOMATION_WINDOW_GAP + AUTOMATION_POPUP_WIDTH <= workArea.left + workArea.width;
  const side = leftFits && (!rightFits || leftCount <= rightCount) ? "left" : "right";
  const slot = side === "left" ? leftCount : rightCount;
  const rows = Math.max(1, Math.floor((workArea.height + AUTOMATION_WINDOW_GAP) / (AUTOMATION_POPUP_HEIGHT + AUTOMATION_WINDOW_GAP)));
  const column = Math.floor(slot / rows);
  const row = slot % rows;
  const left = side === "left"
    ? main.left - AUTOMATION_WINDOW_GAP - AUTOMATION_POPUP_WIDTH - column * (AUTOMATION_POPUP_WIDTH + AUTOMATION_WINDOW_GAP)
    : main.left + main.width + AUTOMATION_WINDOW_GAP + column * (AUTOMATION_POPUP_WIDTH + AUTOMATION_WINDOW_GAP);
  return {
    width: AUTOMATION_POPUP_WIDTH,
    height: AUTOMATION_POPUP_HEIGHT,
    left,
    top: main.top + row * (AUTOMATION_POPUP_HEIGHT + AUTOMATION_WINDOW_GAP)
  };
}

async function openProbeSession(
  url: string,
  mobile: boolean,
  compact: boolean,
  owner: "manual" | "automation" = "manual",
  runId?: string,
  focused = true
): Promise<ProbeSession> {
  if (!isAllowedProbeUrl(url)) throw new Error("Probe URL is outside the allowlisted AliExpress routes");

  const mainBounds = compact ? await centeredAutomationPopupBounds() : undefined;
  const created = compact
    ? await chrome.windows.create({
      type: "popup",
      focused,
      width: AUTOMATION_POPUP_WIDTH,
      height: AUTOMATION_POPUP_HEIGHT,
      ...(mainBounds ? { left: mainBounds.left, top: mainBounds.top } : {}),
      url: "about:blank"
    })
    : undefined;
  const popupTab = created?.tabs?.[0] ??
    (created?.id !== undefined ? (await chrome.tabs.query({ windowId: created.id }))[0] : undefined);
  const tab = popupTab ?? (await chrome.tabs.create({ url: "about:blank", active: focused }));
  if (!tab?.id) throw new Error("Chrome did not return a tab for the probe window");

  const sessions = await getSessionMap();
  const session: ProbeSession = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: created?.id ?? tab.windowId,
    mobile,
    ruleId: mobile ? await installMobileUserAgentRule(tab.id) : undefined,
    createdAt: Date.now(),
    owner,
    runId,
    role: "main"
  };

  sessions[String(tab.id)] = session;
  await setSessionMap(sessions);

  try {
    if (mobile) await navigateWithMobileUserAgent(tab.id, url);
    else await chrome.tabs.update(tab.id, { url });
    return session;
  } catch (error) {
    delete sessions[String(tab.id)];
    await setSessionMap(sessions);
    if (session.ruleId !== undefined) await removeRule(session.ruleId);
    if (created?.id !== undefined) await chrome.windows.remove(created.id).catch(() => undefined);
    else await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
}

async function openMobileSession(): Promise<ProbeSession> {
  return openProbeSession(COIN_INDEX_URL, true, true);
}

async function closeMobileSessions(tabId?: number): Promise<void> {
  const sessions = await getSessionMap();
  const targets = Object.values(sessions).filter(
    (session) => session.owner !== "automation" && (tabId === undefined || session.tabId === tabId)
  );
  for (const session of targets) {
    if (session.ruleId !== undefined) await removeRule(session.ruleId);
    await chrome.tabs.remove(session.tabId).catch(() => undefined);
    delete sessions[String(session.tabId)];
  }
  await setSessionMap(sessions);
}

async function reconcileSessions(): Promise<void> {
  const sessions = await getSessionMap();
  const existingRuleIds = new Set((await chrome.declarativeNetRequest.getSessionRules()).map((rule) => rule.id));

  for (const session of Object.values(sessions)) {
    try {
      await chrome.tabs.get(session.tabId);
      if (session.mobile && (session.ruleId === undefined || !existingRuleIds.has(session.ruleId))) {
        session.ruleId = await installMobileUserAgentRule(session.tabId);
        existingRuleIds.add(session.ruleId);
      } else if (!session.mobile && session.ruleId !== undefined) {
        await removeRule(session.ruleId);
        existingRuleIds.delete(session.ruleId);
        session.ruleId = undefined;
      }
    } catch {
      delete sessions[String(session.tabId)];
      if (session.ruleId !== undefined) await removeRule(session.ruleId);
    }
  }

  const automationSession = await getAutomationSession();
  let automationSessionChanged = false;
  for (const expected of Object.values(automationSession?.expectedNavigations ?? {})) {
    if (expected.launchRuleId !== undefined) {
      await removeRule(expected.launchRuleId);
      expected.launchRuleId = undefined;
      automationSessionChanged = true;
    }
  }
  const ownedRuleIds = new Set(Object.values(sessions).flatMap((session) => session.ruleId === undefined ? [] : [session.ruleId]));
  const orphanedRuleIds = (await chrome.declarativeNetRequest.getSessionRules())
    .map((rule) => rule.id)
    .filter((id) => id >= MOBILE_RULE_ID_START && !ownedRuleIds.has(id));
  if (orphanedRuleIds.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: orphanedRuleIds });
  }
  await setSessionMap(sessions);
  if (automationSessionChanged && automationSession) await setAutomationSession(automationSession);
}

function isTerminalRunState(state: RunState): boolean {
  return ["succeeded", "partially_succeeded", "failed_retryable", "failed_terminal", "cancelled", "interrupted"].includes(state);
}

function isPausedRunState(state: RunState): boolean {
  return state === "waiting_for_login" || state === "waiting_for_manual_action";
}

function localDay(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextLocalSchedule(localTime: string, now = new Date()): number {
  const [hour, minute] = localTime.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function todayLocalSchedule(localTime: string, now = new Date()): number {
  const [hour, minute] = localTime.split(":").map(Number);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

function newTaskRun(id: TaskId): TaskRun {
  return {
    id,
    state: "pending",
    attempts: 0,
    childTabIds: [],
    selectedItemIds: []
  };
}

function createRun(trigger: RunTrigger, settings: AutomationSettings, attempt = 1): AutomationRun {
  const taskOrder = settings.automation.enabledTaskIds.filter((id) => Boolean(TASK_CATALOG_BY_ID[id]));
  const tasks = Object.fromEntries(TASK_CATALOG.map((task) => [task.id, newTaskRun(task.id)])) as Record<TaskId, TaskRun>;
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    trigger,
    logicalDay: localDay(now),
    state: "queued",
    attempt,
    executionMode: settings.automation.executionMode,
    createdAt: now,
    updatedAt: now,
    taskOrder,
    tasks,
    selectorContractVersion: 1
  };
}

async function updateRunLocked(runId: string, mutate: (run: AutomationRun) => void, allowPaused = false): Promise<AutomationRun | undefined> {
  const run = await getRun();
  if (!run || run.id !== runId || isTerminalRunState(run.state) || (isPausedRunState(run.state) && !allowPaused)) return undefined;
  const next: AutomationRun = {
    ...run,
    tasks: Object.fromEntries(
      Object.entries(run.tasks).map(([id, task]) => [id, { ...task, selectedItemIds: [...task.selectedItemIds], childTabIds: [...task.childTabIds] }])
    ) as Record<TaskId, TaskRun>
  };
  mutate(next);
  next.updatedAt = Date.now();
  await setRun(next);
  return next;
}

async function updateRun(runId: string, mutate: (run: AutomationRun) => void): Promise<AutomationRun | undefined> {
  return serialized(() => updateRunLocked(runId, mutate));
}

function recordLog(entry: Omit<AutomationLogEntry, "at">): void {
  void serialized(() => appendLog(entry)).catch((error: unknown) => console.error("Could not store automation log", error));
}

function errorResult(operation: string, error: unknown): AutomationContentResponse {
  return {
    ok: false,
    operation,
    result: "retryable_error",
    error: error instanceof Error ? error.message : String(error)
  };
}

async function sendContentCommand(tabId: number, command: AutomationContentCommand): Promise<AutomationContentResponse> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, command, (result: AutomationContentResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(errorResult("send-content-command", chrome.runtime.lastError.message));
        return;
      }
      resolve(result ?? errorResult("send-content-command", "Content script returned no response"));
    });
  });
}

function unavailableStatsSnapshot(detail: string): StatsSnapshot {
  return {
    accountState: "unavailable",
    history: [],
    source: { kind: "stats-html", url: STATS_URL, observedAt: Date.now() },
    stale: true,
    warnings: [detail]
  };
}

async function findStatsBridgeTabs(preferredTabId?: number): Promise<number[]> {
  const candidates: number[] = [];
  if (preferredTabId !== undefined) candidates.push(preferredTabId);

  const automationSession = await getAutomationSession();
  if (automationSession) candidates.push(automationSession.mainTabId);

  const sessions = await getSessionMap();
  candidates.push(
    ...Object.values(sessions)
      .filter((session) => session.owner !== "automation" && session.mobile)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((session) => session.tabId)
  );

  const openAliExpressTabs = await chrome.tabs.query({
    url: ["https://m.aliexpress.com/*", "https://www.aliexpress.com/*", "http://best.aliexpress.com/*"]
  }).catch(() => []);
  candidates.push(...openAliExpressTabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));

  const result: number[] = [];
  for (const tabId of [...new Set(candidates)]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (isAliExpressPageUrl(tab.url)) result.push(tabId);
    } catch {
      // The probe may have closed between lookup and request.
    }
  }
  return result;
}

function isMissingContentScriptError(error: string | undefined): boolean {
  return Boolean(error && /receiving end does not exist|could not establish connection|no response from service worker/iu.test(error));
}

async function injectStatsBridge(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/mtop-bridge-main.js"],
    world: "MAIN"
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/phase0-probe.js"]
  });
}

async function collectStatsFromPageContext(tabId: number): Promise<StatsSnapshot> {
  let response = await sendContentCommand(tabId, {
    type: "AUTOMATION_COMMAND",
    command: "refresh-stats"
  });
  if (response.result === "retryable_error" && isMissingContentScriptError(response.error)) {
    await injectStatsBridge(tabId);
    response = await sendContentCommand(tabId, {
      type: "AUTOMATION_COMMAND",
      command: "refresh-stats"
    });
  }
  if (response.stats && ["authenticated", "logged-out", "empty"].includes(response.stats.accountState)) return response.stats;
  throw new Error(response.error ?? "The page-context MTop bridge did not return usable stats");
}

async function collectStatsSnapshot(preferredTabId?: number): Promise<StatsSnapshot> {
  const tabIds = await findStatsBridgeTabs(preferredTabId);
  if (!tabIds.length) {
    throw new Error("No open AliExpress coin probe is available for the page-context MTop bridge");
  }
  let lastError: unknown;
  for (const tabId of tabIds) {
    try {
      return await collectStatsFromPageContext(tabId);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "No open AliExpress tab returned usable stats");
}

async function refreshStats(force = false, preferredTabId?: number): Promise<StatsSnapshot | undefined> {
  const settings = await getSettings();
  if (!settings.stats.enabled) return (await getStatsCache())?.snapshot;
  const cached = await getStatsCache();
  if (!force && isStatsCacheFresh(cached)) return cached?.snapshot;

  return statsRefreshCoalescer.run(async () => {
    const current = await getStatsCache();
    if (!force && isStatsCacheFresh(current)) return current?.snapshot;

    try {
      const snapshot = await collectStatsSnapshot(preferredTabId);
      const historyCache = await getStatsHistoryCache();
      const history = mergeHistory(
        historyCache?.entries ?? current?.snapshot.history ?? [],
        snapshot.history,
        Date.now(),
        settings.privacy.historyRetentionMonths,
        MAX_STORED_HISTORY_ENTRIES
      );
      const nextSnapshot = { ...snapshot, history };
      const next = cacheStatsSnapshot(current, nextSnapshot);
      await setStatsHistoryCache({
        schemaVersion: STATS_HISTORY_CACHE_SCHEMA_VERSION,
        entries: history,
        updatedAt: Date.now()
      });
      await setStatsCache(next);
      return next.snapshot;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stale = markStatsCacheStale(current, detail);
      if (stale) {
        await setStatsCache(stale);
        return stale.snapshot;
      }
      const unavailable = cacheStatsSnapshot(undefined, unavailableStatsSnapshot(detail));
      await setStatsCache(unavailable);
      return unavailable.snapshot;
    }
  });
}

function scheduleStatsRefresh(tabId: number, rawUrl: string): void {
  if (!isAliExpressPageUrl(rawUrl)) return;
  void refreshStats(false, tabId).catch((error: unknown) => {
    console.warn("Could not refresh stats from an AliExpress tab", error);
  });
}

async function acquireLeaseLocked(runId: string): Promise<boolean> {
  const current = await getLease();
  if (current && current.expiresAt > Date.now() && current.runId !== runId) return false;
  const lease: AutomationLease = {
    runId,
    token: crypto.randomUUID(),
    expiresAt: Date.now() + 15 * 60_000
  };
  await setLease(lease);
  const verified = await getLease();
  return verified?.runId === runId && verified.token === lease.token;
}

async function pauseRunLocked(runId: string, state: "waiting_for_login" | "waiting_for_manual_action", reason: string): Promise<void> {
  const updated = await updateRunLocked(runId, (run) => {
    run.state = state;
    run.lastError = reason;
  });
  if (!updated) return;
  const session = await getAutomationSession();
  if (session?.runId === runId) await clearExpectedNavigationLocked(session);
  const lease = await getLease();
  if (lease?.runId === runId) await setLease(undefined);
  await appendLog({
    level: "warn",
    event: state === "waiting_for_login" ? "login-required" : "manual-action-required",
    message: reason,
    runId
  });
  await notifyRunState(updated);
}

async function pauseRun(runId: string, state: "waiting_for_login" | "waiting_for_manual_action", reason: string): Promise<void> {
  await serialized(() => pauseRunLocked(runId, state, reason));
}

async function failRun(runId: string, result: AutomationResult, reason: string): Promise<void> {
  const state: RunState = result === "retryable_error" ? "failed_retryable" : "failed_terminal";
  const updated = await updateRun(runId, (run) => {
    run.state = state;
    run.lastError = reason;
    run.finishedAt = Date.now();
  });
  if (!updated) return;
  recordLog({ level: state === "failed_retryable" ? "warn" : "error", event: "run-failed", message: reason, runId });
  await notifyRunState(updated);
  await closeAutomationRun(runId);
  if (state !== "failed_retryable") return;

  const settings = await getSettings();
  if (updated.attempt >= settings.schedule.maxAttemptsPerDay) return;
  const delayMinutes = settings.schedule.retryDelaysMinutes[
    Math.min(updated.attempt - 1, settings.schedule.retryDelaysMinutes.length - 1)
  ] ?? 5;
  const alarmName = `${RETRY_ALARM_PREFIX}${runId}`;
  await chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });
  recordLog({
    level: "info",
    event: "retry-scheduled",
    message: `Retry ${updated.attempt + 1} scheduled in ${delayMinutes} minutes`,
    runId,
    data: { delayMinutes, attempt: updated.attempt + 1 }
  });
}

async function clearExpectedNavigationLocked(session: AutomationSession | undefined, expectedId?: string): Promise<void> {
  if (!session) return;
  const expected = expectedId
    ? session.expectedNavigations[expectedId]
    : undefined;
  if (expectedId && !expected) return;
  const targets = expected ? [expected] : Object.values(session.expectedNavigations);
  if (!targets.length) return;

  for (const target of targets) {
    if (target.launchRuleId !== undefined) await removeRule(target.launchRuleId);
    await chrome.alarms.clear(`${NAVIGATION_WATCHDOG_PREFIX}${target.id}`).catch(() => false);
    await chrome.alarms.clear(`${OPTIONAL_NAVIGATION_GRACE_PREFIX}${target.id}`).catch(() => false);
    await chrome.alarms.clear(`${CONTROLLED_CHILD_LAUNCH_PREFIX}${target.id}`).catch(() => false);
    delete session.expectedNavigations[target.id];
  }
  await setAutomationSession(session);
}

function destinationMatchesExpected(expected: ExpectedNavigation, rawUrl: string): boolean {
  const task = TASK_CATALOG_BY_ID[expected.taskId];
  if (!taskDestinationMatters(task)) return isAliExpressPageUrl(rawUrl);
  const route = classifyRoute(rawUrl);
  if (expected.itemId) return itemDestinationMatches(expected.itemId, rawUrl);
  if (!taskAllowsRoute(task, route)) return false;
  return taskDestinationMatches(task, rawUrl);
}

function expectedRequiresChild(expected: ExpectedNavigation): boolean {
  return taskRequiresChildNavigation(TASK_CATALOG_BY_ID[expected.taskId], expected.itemId);
}

function controlledChildUrl(expected: ExpectedNavigation): string | undefined {
  if (expected.itemId && /^[A-Za-z0-9_-]+$/u.test(expected.itemId)) {
    return `https://m.aliexpress.com/item/${encodeURIComponent(expected.itemId)}.html`;
  }
  return TASK_CATALOG_BY_ID[expected.taskId].launchUrl;
}

function expectedNavigationCandidates(session: AutomationSession, sourceTabId: number): ExpectedNavigation[] {
  const now = Date.now();
  return Object.values(session.expectedNavigations).filter(
    (expected) => expected.sourceTabId === sourceTabId && expected.expiresAt > now
  );
}

function expectedForCreatedNavigation(
  session: AutomationSession,
  sourceTabId: number,
  rawUrl: string | undefined
): ExpectedNavigation | undefined {
  const candidates = expectedNavigationCandidates(session, sourceTabId);
  if (!candidates.length) return undefined;
  if (!rawUrl || rawUrl === "about:blank") return candidates.length === 1 ? candidates[0] : undefined;
  const matches = candidates.filter((expected) => destinationMatchesExpected(expected, rawUrl));
  if (matches.length === 1) return matches[0];
  const requiredMatches = matches.filter((expected) => expectedRequiresChild(expected));
  if (requiredMatches.length === 1) return requiredMatches[0];
  if (matches.length > 1 && matches.every((expected) => !expectedRequiresChild(expected))) return undefined;
  return matches.length === 1 ? matches[0] : undefined;
}

async function settleNavigationCandidatesLocked(
  run: AutomationRun,
  session: AutomationSession,
  candidates: ExpectedNavigation[],
  reason: string
): Promise<void> {
  const taskIds = [...new Set(candidates.map((candidate) => candidate.taskId))];
  for (const candidate of candidates) await clearExpectedNavigationLocked(session, candidate.id);
  await updateRunLocked(run.id, (current) => {
    for (const taskId of taskIds) {
      const task = current.tasks[taskId];
      if (task.state === "complete") continue;
      task.state = "waiting_for_manual_action";
      task.finishedAt = Date.now();
      task.outcomeCheckNotBefore = undefined;
      task.error = reason;
    }
  });
  for (const taskId of taskIds) {
    await appendLog({ level: "warn", event: "task-waiting", message: reason, runId: run.id, taskId });
  }
  queueMainDrive(run.id);
}

function itemDestinationMatches(itemId: string, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !["m.aliexpress.com", "www.aliexpress.com"].includes(url.hostname)) return false;
    const segment = decodeURIComponent(url.pathname.slice("/item/".length).split("/")[0] ?? "").toLocaleLowerCase();
    const expected = itemId.trim().toLocaleLowerCase();
    return Boolean(expected) && url.pathname.toLocaleLowerCase().startsWith("/item/") && (
      segment === expected ||
      segment.startsWith(`${expected}.`) ||
      segment.startsWith(`${expected}-`) ||
      segment.startsWith(`${expected}_`)
    );
  } catch {
    return false;
  }
}

function itemIdFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.toLocaleLowerCase().startsWith("/item/")) return undefined;
    const segment = decodeURIComponent(url.pathname.slice("/item/".length).split("/")[0] ?? "");
    const itemId = segment.replace(/\.html?$/iu, "");
    return itemId || undefined;
  } catch {
    return undefined;
  }
}

async function armNavigationLocked(runId: string, sourceTabId: number, taskId: TaskId, itemId?: string): Promise<Phase0Response> {
  const session = await getAutomationSession();
  const run = await getRun();
  if (!session || session.runId !== runId || !run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) {
    return { ok: false, error: "Automation session is not active" };
  }

  const task = TASK_CATALOG_BY_ID[taskId];
  const sourceChild = session.childTabs[String(sourceTabId)];
  const itemNavigation = taskId === "surprise_items" && sourceChild?.taskId === "surprise_items";
  const effectiveTask = itemId ? { ...task, allowedRoutes: ["item"] as const, pathPrefixes: ["/item/"] } : task;
  const now = Date.now();
  const expected: ExpectedNavigation = {
    id: crypto.randomUUID(),
    runId,
    taskId,
    sourceTabId,
    itemId,
    allowedRoutes: [...effectiveTask.allowedRoutes],
    mobile: task.requiresMobileIdentity,
    createdAt: now,
    expiresAt: now + taskOutcomeWaitMs(task, itemId),
    itemNavigation
  };

  const focusedWindow = await chrome.windows.getLastFocused().catch(() => undefined);
  const focusedTab = focusedWindow?.id === undefined
    ? undefined
    : (await chrome.tabs.query({ active: true, windowId: focusedWindow.id }).catch(() => []))[0];
  expected.returnFocusWindowId = focusedWindow?.id;
  expected.returnFocusTabId = focusedTab?.id;

  expected.status = "pending";
  session.expectedNavigations[expected.id] = expected;
  await setAutomationSession(session);
  await chrome.alarms.create(`${NAVIGATION_WATCHDOG_PREFIX}${expected.id}`, { when: expected.expiresAt });
  if (!expected.itemNavigation && !expected.itemId && expectedRequiresChild(expected) && controlledChildUrl(expected)) {
    await chrome.alarms.create(`${CONTROLLED_CHILD_LAUNCH_PREFIX}${expected.id}`, {
      when: Date.now() + CONTROLLED_CHILD_LAUNCH_DELAY_MS
    });
  }
  recordLog({
    level: "debug",
    event: "navigation-armed",
    message: `Armed ${taskId} navigation${itemId ? ` for item ${itemId}` : ""}`,
    runId,
    taskId,
    tabId: sourceTabId,
    data: { mobile: expected.mobile }
  });
  return { ok: true, expectedId: expected.id };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeAutomationTabLocked(tabId: number): Promise<ProbeSession | undefined> {
  const sessions = await getSessionMap();
  const session = sessions[String(tabId)];
  if (!session || session.owner !== "automation") return undefined;
  delete sessions[String(tabId)];
  await setSessionMap(sessions);
  if (session.ruleId !== undefined) await removeRule(session.ruleId);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  return session;
}

async function closeAutomationRunLocked(runId: string): Promise<void> {
  const session = await getAutomationSession();
  if (session?.runId === runId) await clearExpectedNavigationLocked(session);

  const sessions = await getSessionMap();
  const owned = Object.values(sessions).filter((candidate) => candidate.owner === "automation" && candidate.runId === runId);
  for (const candidate of owned) {
    delete sessions[String(candidate.tabId)];
    if (candidate.ruleId !== undefined) await removeRule(candidate.ruleId);
    const child = session?.childTabs[String(candidate.tabId)];
    if (child?.closeAlarmName) await chrome.alarms.clear(child.closeAlarmName).catch(() => false);
    if (child?.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
    await chrome.tabs.remove(candidate.tabId).catch(() => undefined);
  }
  await setSessionMap(sessions);
  if (session?.runId === runId) {
    await setAutomationSession(undefined);
    if (session.mainWindowOwned && session.mainWindowId !== undefined) {
      await chrome.windows.remove(session.mainWindowId).catch(() => undefined);
    }
  }
  const lease = await getLease();
  if (lease?.runId === runId) await setLease(undefined);
  const outcomeAlarmPrefix = `${TASK_OUTCOME_CHECK_PREFIX}${runId}:`;
  for (const alarm of await chrome.alarms.getAll()) {
    if (alarm.name.startsWith(outcomeAlarmPrefix)) await chrome.alarms.clear(alarm.name).catch(() => false);
  }
  await chrome.alarms.clear(`${NAVIGATION_WATCHDOG_PREFIX}${runId}`).catch(() => false);
}

async function closeAutomationRun(runId: string): Promise<void> {
  await serialized(() => closeAutomationRunLocked(runId));
}

async function completeRun(runId: string, state: "succeeded" | "partially_succeeded"): Promise<void> {
  const updated = await updateRun(runId, (run) => {
    run.state = state;
    run.finishedAt = Date.now();
    run.currentTaskId = undefined;
  });
  if (!updated) return;
  recordLog({
    level: state === "succeeded" ? "info" : "warn",
    event: "run-completed",
    message: state === "succeeded" ? "All enabled tasks completed with evidence" : "Run completed with partial task results",
    runId
  });

  const session = await getAutomationSession();
  const statsTabId = session?.runId === runId ? session.mainTabId : undefined;
  try {
    const snapshot = await refreshStats(true, statsTabId);
    recordLog({
      level: snapshot?.stale ? "warn" : "info",
      event: "stats-refreshed-after-run",
      message: snapshot?.stale ? "Post-run stats refresh returned stale data" : "Post-run stats refreshed through the main coin page",
      runId,
      tabId: statsTabId,
      data: {
        accountState: snapshot?.accountState ?? "unavailable",
        source: snapshot?.source.kind ?? "none",
        historyEntryCount: snapshot?.history.length ?? 0
      }
    });
  } catch (error) {
    recordLog({
      level: "warn",
      event: "stats-refresh-after-run-failed",
      message: error instanceof Error ? error.message : String(error),
      runId,
      tabId: statsTabId
    });
  }
  await closeAutomationRun(runId);
  await notifyRunState(updated);
}

async function markTaskComplete(runId: string, taskId: TaskId, completionEvidence: TaskRun["completionEvidence"]): Promise<void> {
  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  const hasAuthoritativePassiveEvidence = completionEvidence?.kind === "drawer-complete" ||
    (completionEvidence?.kind === "drawer-disappeared" && taskRowDisappearsOnCompletion(catalogEntry));
  if (catalogEntry.policy === "passive" && !hasAuthoritativePassiveEvidence) {
    recordLog({
      level: "error",
      event: "passive-completion-rejected",
      message: `${taskId} completion was rejected without authoritative drawer evidence`,
      runId,
      taskId,
      data: { evidence: completionEvidence?.kind ?? "missing" }
    });
    return;
  }
  const updated = await updateRun(runId, (run) => {
    const task = run.tasks[taskId];
    task.state = "complete";
    task.finishedAt = Date.now();
    task.completionEvidence = completionEvidence;
    task.attemptsRemaining = 0;
    task.outcomeCheckNotBefore = undefined;
    task.error = undefined;
  });
  if (!updated) return;
  await chrome.alarms.clear(`${TASK_OUTCOME_CHECK_PREFIX}${runId}:${taskId}`).catch(() => false);
  recordLog({
    level: "info",
    event: "task-completed",
    message: `${taskId} completed with observed evidence`,
    runId,
    taskId,
    data: { evidence: completionEvidence?.detail ?? "unknown" }
  });
}

async function markTaskProgress(runId: string, taskId: TaskId, progress: { current: number; total: number }): Promise<void> {
  const updated = await updateRun(runId, (run) => {
    const task = run.tasks[taskId];
    task.progressAfter = progress;
    task.optimisticProgress = progress;
    task.attemptsRemaining = Math.max(0, progress.total - progress.current);
    task.state = "pending";
    task.outcomeCheckNotBefore = undefined;
    task.completionEvidence = {
      kind: "drawer-progress",
      detail: `Drawer progress observed at ${progress.current}/${progress.total}`,
      at: Date.now()
    };
  });
  if (!updated) return;
  await chrome.alarms.clear(`${TASK_OUTCOME_CHECK_PREFIX}${runId}:${taskId}`).catch(() => false);
  recordLog({
    level: "info",
    event: "task-progress",
    message: `${taskId} progress advanced to ${progress.current}/${progress.total}`,
    runId,
    taskId,
    data: progress
  });
}

async function markTaskActionAccepted(runId: string, taskId: TaskId, detail: string): Promise<void> {
  const updated = await updateRun(runId, (run) => {
    const task = run.tasks[taskId];
    const catalogEntry = TASK_CATALOG_BY_ID[taskId];
    const baseline = task.optimisticProgress ?? task.progressAfter ?? task.progressBefore;
    const total = baseline?.total ?? catalogEntry.goal;
    const current = Math.min(total, (baseline?.current ?? 0) + 1);
    task.optimisticProgress = { current, total };
  });
  if (!updated) return;
  const optimisticProgress = updated.tasks[taskId].optimisticProgress;
  recordLog({
    level: "info",
    event: "task-action-counted",
    message: `${taskId} action cycle counted optimistically at ${optimisticProgress?.current ?? 0}/${optimisticProgress?.total ?? TASK_CATALOG_BY_ID[taskId].goal}`,
    runId,
    taskId,
    data: {
      detail,
      optimisticCurrent: optimisticProgress?.current ?? 0,
      optimisticTotal: optimisticProgress?.total ?? TASK_CATALOG_BY_ID[taskId].goal
    }
  });
}

async function markTaskWaiting(runId: string, taskId: TaskId, reason: string, state: "waiting_for_manual_action" | "skipped" = "waiting_for_manual_action"): Promise<void> {
  const updated = await updateRun(runId, (run) => {
    const task = run.tasks[taskId];
    task.state = state;
    task.finishedAt = Date.now();
    task.outcomeCheckNotBefore = undefined;
    task.error = reason;
  });
  if (!updated) return;
  await chrome.alarms.clear(`${TASK_OUTCOME_CHECK_PREFIX}${runId}:${taskId}`).catch(() => false);
  recordLog({
    level: "warn",
    event: state === "skipped" ? "task-skipped" : "task-waiting",
    message: reason,
    runId,
    taskId
  });
}

async function scheduleTaskRetry(runId: string, taskId: TaskId, reason: string): Promise<boolean> {
  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  const result = await serialized(async (): Promise<"scheduled" | "already-pending" | "rejected"> => {
    const run = await getRun();
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) return "rejected";
    const task = run.tasks[taskId];
    if (task.state === "pending") return "already-pending";
    if (task.state !== "running" || (!taskRetriesUntilComplete(catalogEntry) && task.attempts >= taskActionAttemptLimit(catalogEntry))) {
      return "rejected";
    }
    await updateRunLocked(runId, (current) => {
      current.state = "running_tasks";
      const currentTask = current.tasks[taskId];
      currentTask.state = "pending";
      currentTask.finishedAt = undefined;
      currentTask.outcomeCheckNotBefore = undefined;
      currentTask.optimisticProgress = currentTask.progressAfter ?? currentTask.progressBefore;
      currentTask.error = reason;
    });
    return "scheduled";
  });
  if (result === "rejected") return false;
  await chrome.alarms.clear(`${TASK_OUTCOME_CHECK_PREFIX}${runId}:${taskId}`).catch(() => false);
  if (result === "already-pending") return true;
  const updated = await getRun();
  if (!updated || updated.id !== runId) return false;
  recordLog({
    level: "warn",
    event: "task-retry-scheduled",
    message: `Scheduled an aggressive retry for ${taskId} after no verified drawer completion`,
    runId,
    taskId,
    data: {
      attempts: updated.tasks[taskId].attempts,
      attemptLimit: taskActionAttemptLimit(catalogEntry),
      reason
    }
  });
  return true;
}

function taskHasActiveWork(session: AutomationSession, taskId: TaskId): boolean {
  return Object.values(session.expectedNavigations).some((expected) => expected.taskId === taskId) ||
    Object.values(session.childTabs).some((child) => child.taskId === taskId);
}

function hasMainTabAction(session: AutomationSession): boolean {
  return Object.values(session.expectedNavigations).some((expected) => expected.sourceTabId === session.mainTabId);
}

function enabledTasksComplete(run: AutomationRun): boolean {
  return run.taskOrder.every((taskId) => run.tasks[taskId].state === "complete");
}

function enabledTasksSettled(run: AutomationRun): boolean {
  return run.taskOrder.every((taskId) => ["complete", "skipped", "waiting_for_manual_action", "failed"].includes(run.tasks[taskId].state));
}

type TaskWaitOutcome =
  | { kind: "credited"; drawer: NonNullable<AutomationContentResponse["taskDrawer"]> }
  | { kind: "child" }
  | { kind: "changed" }
  | { kind: "timeout" };

function drawerShowsTaskCredit(
  drawer: NonNullable<AutomationContentResponse["taskDrawer"]>,
  taskId: TaskId,
  progressBefore: TaskRun["progressBefore"]
): boolean {
  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  const row = drawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
  if (!row) return drawer.found && drawer.rowCount > 0 && taskRowDisappearsOnCompletion(catalogEntry);
  return Boolean(
    row?.completed ||
    (row?.progress && (progressBefore
      ? row.progress.current > progressBefore.current
      : row.progress.current > 0))
  );
}

async function claimExpectedNavigation(runId: string, expectedId: string, sourceTabId: number, keepOptionalGrace = false): Promise<boolean> {
  return serialized(async () => {
    const session = await getAutomationSession();
    const expected = session?.runId === runId ? session.expectedNavigations[expectedId] : undefined;
    if (!expected || expected.id !== expectedId || expected.sourceTabId !== sourceTabId) return false;
    if (keepOptionalGrace && !expectedRequiresChild(expected)) {
      if (expected.launchRuleId !== undefined) {
        await removeRule(expected.launchRuleId);
        expected.launchRuleId = undefined;
      }
      await chrome.alarms.clear(`${NAVIGATION_WATCHDOG_PREFIX}${expected.id}`).catch(() => false);
      expected.status = "direct-credited";
      expected.expiresAt = Date.now() + OPTIONAL_CHILD_CLOSE_MS;
      await setAutomationSession(session);
      await chrome.alarms.create(`${OPTIONAL_NAVIGATION_GRACE_PREFIX}${expected.id}`, { when: expected.expiresAt });
      setTimeout(() => void handleOptionalNavigationGrace(expected.id), OPTIONAL_CHILD_CLOSE_MS);
      return true;
    }
    await clearExpectedNavigationLocked(session, expectedId);
    return true;
  });
}

async function waitForTaskOutcome(runId: string, taskId: TaskId, expectedId: string, sourceTabId: number): Promise<TaskWaitOutcome> {
  const initial = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    const expected = session?.runId === runId ? Object.values(session.expectedNavigations).find((candidate) => candidate.id === expectedId) : undefined;
    if (!run || run.id !== runId || !expected || expected.id !== expectedId || expected.sourceTabId !== sourceTabId) return undefined;
    return {
      deadline: expected.expiresAt,
      progressBefore: run.tasks[taskId].progressBefore,
      requiresChild: expectedRequiresChild(expected)
    };
  });
  if (!initial) return { kind: "changed" };

  while (Date.now() < initial.deadline) {
    const state = await serialized(async () => {
      const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
      if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return "changed" as const;
      if (Object.values(session.childTabs).some((child) => child.expectedId === expectedId)) return "child" as const;
      if (!session.expectedNavigations[expectedId] || session.expectedNavigations[expectedId].status === "direct-credited") return "changed" as const;
      return "waiting" as const;
    });
    if (state === "child") return { kind: "child" };
    if (state === "changed") return { kind: "changed" };

    const drawer = await sendContentCommand(sourceTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
    if (drawer.result === "success" && drawer.taskDrawer && !initial.requiresChild && drawerShowsTaskCredit(drawer.taskDrawer, taskId, initial.progressBefore)) {
      return { kind: "credited", drawer: drawer.taskDrawer };
    }
    await delay(AUTOMATION_POLL_INTERVAL_MS);
  }
  return { kind: "timeout" };
}

function queueMainDrive(runId: string, milliseconds = 0): void {
  setTimeout(() => scheduleMainDrive(runId), milliseconds);
}

function logTaskClickResult(runId: string, taskId: TaskId, tabId: number, clickResponse: AutomationContentResponse): void {
  recordLog({
    level: clickResponse.result === "clicked" ? "info" : "warn",
    event: "task-click-result",
    message: `${taskId} click returned ${clickResponse.result}`,
    runId,
    taskId,
    tabId,
    data: {
      clicked: clickResponse.clicked ?? false,
      clickCount: clickResponse.clickCount ?? 0,
      error: clickResponse.error ?? null,
      targetTag: clickResponse.clickTarget?.tagName ?? null,
      targetClass: clickResponse.clickTarget?.className ?? null,
      targetText: clickResponse.clickTarget?.text ?? null,
      targetRole: clickResponse.clickTarget?.role ?? null
    }
  });
}

async function dispatchTrustedMouseClick(tabId: number, point: { x: number; y: number }): Promise<void> {
  if (![point.x, point.y].every((value) => Number.isFinite(value)) || point.x < 0 || point.y < 0 || point.x > 10_000 || point.y > 10_000) {
    throw new Error("Task click coordinates were invalid");
  }
  const target = { tabId };
  let attached = false;
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    attached = true;
    const dispatch = (params: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", params, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    await dispatch({ type: "mouseMoved", x: point.x, y: point.y });
    await dispatch({ type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await delay(80);
    await dispatch({ type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  } finally {
    if (attached) {
      await new Promise<void>((resolve) => {
        chrome.debugger.detach(target, () => resolve());
      });
    }
  }
}

async function clickMainTask(runId: string, taskId: TaskId, tabId: number): Promise<AutomationContentResponse> {
  const prepared = await sendContentCommand(tabId, {
    type: "AUTOMATION_COMMAND",
    command: "click-task",
    taskId,
    mode: "prepare"
  });
  if (prepared.result !== "clicked" || !prepared.clickPoint) return prepared;
  try {
    await dispatchTrustedMouseClick(tabId, prepared.clickPoint);
    return { ...prepared, clicked: true };
  } catch (error) {
    recordLog({
      level: "warn",
      event: "task-trusted-click-fallback",
      message: `Trusted click for ${taskId} failed; using the page click fallback`,
      runId,
      taskId,
      tabId,
      data: { error: error instanceof Error ? error.message : String(error) }
    });
    return sendContentCommand(tabId, {
      type: "AUTOMATION_COMMAND",
      command: "click-task",
      taskId,
      mode: "synthetic"
    });
  }
}

async function handleParallelTaskOutcome(
  runId: string,
  taskId: TaskId,
  expectedId: string,
  sourceTabId: number,
  outcome: TaskWaitOutcome
): Promise<void> {
  if (outcome.kind === "credited") {
    if (!(await claimExpectedNavigation(runId, expectedId, sourceTabId, true))) return;
    const row = outcome.drawer.tasks.find((candidate) => candidate.groupId === TASK_CATALOG_BY_ID[taskId].groupId);
    if (row?.completed) {
      await markTaskComplete(runId, taskId, {
        kind: "drawer-complete",
        detail: `${TASK_CATALOG_BY_ID[taskId].groupId} completed after direct drawer credit`,
        at: Date.now()
      });
    } else if (row?.progress) {
      await markTaskProgress(runId, taskId, row.progress);
    } else if (!row && taskRowDisappearsOnCompletion(TASK_CATALOG_BY_ID[taskId])) {
      await markTaskComplete(runId, taskId, {
        kind: "drawer-disappeared",
        detail: `${TASK_CATALOG_BY_ID[taskId].groupId} row disappeared after the verified click`,
        at: Date.now()
      });
    }
    recordLog({
      level: "info",
      event: "direct-task-credit",
      message: `${taskId} credited without child navigation`,
      runId,
      taskId,
      tabId: sourceTabId,
      data: {
        progress: row?.progress ? `${row.progress.current}/${row.progress.total}` : null,
        completed: row?.completed ?? false
      }
    });
    queueMainDrive(runId);
    return;
  }

  if (outcome.kind === "timeout") {
    await handleNavigationWatchdog(expectedId);
  }
}

function watchParallelTaskOutcome(runId: string, taskId: TaskId, expectedId: string, sourceTabId: number): void {
  const key = `${runId}:${expectedId}`;
  if (activeTaskOutcomeWaits.has(key)) return;
  activeTaskOutcomeWaits.add(key);
  void waitForTaskOutcome(runId, taskId, expectedId, sourceTabId)
    .then((outcome) => handleParallelTaskOutcome(runId, taskId, expectedId, sourceTabId, outcome))
    .catch(async (error: unknown) => {
      await claimExpectedNavigation(runId, expectedId, sourceTabId);
      await markTaskWaiting(runId, taskId, error instanceof Error ? error.message : String(error));
      queueMainDrive(runId);
    })
    .finally(() => activeTaskOutcomeWaits.delete(key));
}

async function waitForDrawerTask(
  mainTabId: number,
  initialDrawer: NonNullable<AutomationContentResponse["taskDrawer"]>,
  groupId: string,
  timeoutMs = TASK_ROW_WAIT_MS
): Promise<NonNullable<AutomationContentResponse["taskDrawer"]>> {
  let drawer = initialDrawer;
  const refreshed = await sendContentCommand(mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
  if (refreshed.result === "success" && refreshed.taskDrawer) {
    drawer = refreshed.taskDrawer;
    if (drawer.tasks.some((candidate) => candidate.groupId === groupId)) return drawer;
  } else if (drawer.tasks.some((candidate) => candidate.groupId === groupId)) {
    return drawer;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(AUTOMATION_POLL_INTERVAL_MS);
    const refreshed = await sendContentCommand(mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
    if (refreshed.result !== "success" || !refreshed.taskDrawer) continue;
    drawer = refreshed.taskDrawer;
    if (drawer.tasks.some((candidate) => candidate.groupId === groupId)) return drawer;
  }
  return drawer;
}

async function startParallelTask(
  runId: string,
  mainTabId: number,
  initialDrawer: NonNullable<AutomationContentResponse["taskDrawer"]>,
  taskId: TaskId
): Promise<void> {
  const snapshot = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return undefined;
    return { run, session };
  });
  if (!snapshot) return;

  const taskRun = snapshot.run.tasks[taskId];
  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  if (["complete", "skipped", "waiting_for_manual_action", "failed"].includes(taskRun.state)) return;
  if (taskHasActiveWork(snapshot.session, taskId)) return;
  const drawer = await waitForDrawerTask(mainTabId, initialDrawer, catalogEntry.groupId);
  const row = drawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
  if (!row) {
    recordLog({
      level: "warn",
      event: "task-row-missing",
      message: `${taskId} group ${catalogEntry.groupId} was not present after waiting for the drawer to render`,
      runId,
      taskId,
      tabId: mainTabId,
      data: { visibleGroups: drawer.tasks.map((candidate) => candidate.groupId).join(",") }
    });
    await markTaskWaiting(runId, taskId, `Task ${taskId} was not present in the live drawer`);
    return;
  }
  recordLog({
    level: "debug",
    event: "task-row-observed",
    message: `${taskId} group ${catalogEntry.groupId} observed as ${row.actionState}`,
    runId,
    taskId,
    tabId: mainTabId,
    data: {
      action: row.actionText,
      progress: row.progress ? `${row.progress.current}/${row.progress.total}` : null,
      completed: row.completed
    }
  });
  if (row.completed) {
    await markTaskComplete(runId, taskId, {
      kind: "drawer-complete",
      detail: `${catalogEntry.groupId} row reported complete`,
      at: Date.now()
    });
    return;
  }
  if (taskRun.state === "running") {
    const before = taskRun.progressBefore;
    if (row.progress && (before ? row.progress.current > before.current : row.progress.current > 0)) {
      await markTaskProgress(runId, taskId, row.progress);
      queueMainDrive(runId);
    } else if (taskRun.outcomeCheckNotBefore && taskRun.outcomeCheckNotBefore > Date.now()) {
      return;
    } else if (taskHasActiveWork(snapshot.session, taskId)) {
      return;
    } else {
      const reason = `${taskId} finished without verified drawer progress or completion evidence`;
      if (await scheduleTaskRetry(runId, taskId, reason)) queueMainDrive(runId);
      else await markTaskWaiting(runId, taskId, reason);
    }
    return;
  }

  if (row.actionState !== "active") {
    await markTaskWaiting(
      runId,
      taskId,
      `${taskId} row action was ${row.actionState}`,
      row.actionState === "unavailable" ? "skipped" : "waiting_for_manual_action"
    );
    return;
  }

  const progressBefore = mostAdvancedTaskProgress(row.progress, taskRun.progressAfter);
  const attemptsRemaining = taskClicksRemaining(catalogEntry, progressBefore);
  // Main-tab clicks stay serialized, but a successful action cycle may be
  // counted optimistically while the drawer catches up or a retry is queued.
  const actionAttemptLimit = taskActionAttemptLimit(catalogEntry);
  const claimed = await serialized(async (): Promise<boolean | "attempt-limit"> => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return false;
    const task = run.tasks[taskId];
    if (task.state !== "pending" || taskHasActiveWork(session, taskId)) return false;
    if (!taskRetriesUntilComplete(catalogEntry) && task.attempts >= actionAttemptLimit) return "attempt-limit";
    await updateRunLocked(runId, (current) => {
      const nextTask = current.tasks[taskId];
      current.state = "running_tasks";
      current.currentTaskId = taskId;
      nextTask.state = "running";
      nextTask.attempts += 1;
      nextTask.attemptsRemaining = attemptsRemaining;
      nextTask.startedAt ??= Date.now();
      nextTask.progressBefore = progressBefore;
      nextTask.outcomeCheckNotBefore = undefined;
      nextTask.error = undefined;
    });
    return true;
  });
  if (claimed === "attempt-limit") {
    await markTaskWaiting(runId, taskId, `${taskId} reached the bounded action-attempt limit`);
    return;
  }
  if (!claimed) return;
  recordLog({
    level: "info",
    event: "task-started",
    message: `Starting ${taskId} in the shared main tab`,
    runId,
    taskId,
    tabId: mainTabId,
    data: {
      progress: progressBefore ? `${progressBefore.current}/${progressBefore.total}` : null,
      attemptsRemaining,
      navigation: catalogEntry.navigation
    }
  });

  const armed = await serialized(() => armNavigationLocked(runId, mainTabId, taskId));
  if (!armed.ok || !armed.expectedId) {
    await markTaskWaiting(runId, taskId, armed.error ?? `Could not arm ${taskId}`);
    return;
  }
  const clickResponse = await clickMainTask(runId, taskId, mainTabId);
  logTaskClickResult(runId, taskId, mainTabId, clickResponse);

  if (clickResponse.result === "clicked") {
    watchParallelTaskOutcome(runId, taskId, armed.expectedId, mainTabId);
    return;
  }

  const session = await serialized(() => getAutomationSession());
  if (session?.runId === runId) await serialized(() => clearExpectedNavigationLocked(session, armed.expectedId));
  if (clickResponse.result === "already_complete") {
    await markTaskComplete(runId, taskId, {
      kind: "drawer-complete",
      detail: `${catalogEntry.groupId} completed before the click`,
      at: Date.now()
    });
    return;
  }
  if (clickResponse.result === "retryable_error" && taskRetriesUntilComplete(catalogEntry)) {
    const reason = clickResponse.error ?? `${taskId} click failed transiently`;
    if (await scheduleTaskRetry(runId, taskId, reason)) {
      queueMainDrive(runId);
      return;
    }
  }
  await markTaskWaiting(runId, taskId, clickResponse.error ?? `${taskId} could not be clicked safely`);
}

async function maybeFinalizeParallelRun(runId: string): Promise<void> {
  const snapshot = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return undefined;
    return { run, session };
  });
  if (!snapshot || !enabledTasksSettled(snapshot.run)) return;
  if (Object.values(snapshot.session.expectedNavigations).length || Object.values(snapshot.session.childTabs).length) return;

  if (enabledTasksComplete(snapshot.run)) {
    await completeRun(runId, "succeeded");
    return;
  }
  if (snapshot.run.taskOrder.some((taskId) => ["waiting_for_manual_action", "failed"].includes(snapshot.run.tasks[taskId].state))) {
    // Unverified tasks are already recorded individually. Once every task
    // has settled, finish the run with a partial result instead of leaving
    // the whole run paused behind one task.
    await completeRun(runId, "partially_succeeded");
    return;
  }
  await completeRun(runId, "partially_succeeded");
}

async function processDrawerParallel(runId: string, initialDrawer: NonNullable<AutomationContentResponse["taskDrawer"]>): Promise<void> {
  const snapshot = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return undefined;
    return { run, session };
  });
  if (!snapshot) return;

  // The shared drawer has one live pointer and rerenders after accepted clicks.
  // Main-tab actions therefore stay serialized; child tabs and controllers remain parallel.
  let drawer = initialDrawer;
  for (const taskId of snapshot.run.taskOrder) {
    const sessionBefore = await serialized(() => getAutomationSession());
    if (!sessionBefore || sessionBefore.runId !== runId || hasMainTabAction(sessionBefore)) break;
    try {
      await startParallelTask(runId, snapshot.session.mainTabId, drawer, taskId);
    } catch (error) {
      await markTaskWaiting(runId, taskId, error instanceof Error ? error.message : String(error));
    }
    const refreshed = await sendContentCommand(snapshot.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
    if (refreshed.result === "success" && refreshed.taskDrawer) drawer = refreshed.taskDrawer;
    const sessionAfter = await serialized(() => getAutomationSession());
    if (!sessionAfter || sessionAfter.runId !== runId || hasMainTabAction(sessionAfter)) break;
  }
  await maybeFinalizeParallelRun(runId);
}

async function resumeAfterTaskChild(runId: string, taskId: TaskId): Promise<void> {
  await delay(POST_CHILD_RESUME_DELAY_MS);
  const snapshot = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return undefined;
    return {
      mainTabId: session.mainTabId,
      executionMode: run.executionMode,
      progressBefore: run.tasks[taskId].progressBefore,
      deadline: run.tasks[taskId].outcomeCheckNotBefore ?? Date.now()
    };
  });
  if (!snapshot) return;

  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  let drawerResponse: AutomationContentResponse | undefined;
  while (Date.now() < snapshot.deadline) {
    const active = await serialized(async () => {
      const run = await getRun();
      return Boolean(run && run.id === runId && !isTerminalRunState(run.state) && !isPausedRunState(run.state));
    });
    if (!active) return;
    drawerResponse = await sendContentCommand(snapshot.mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
    if (drawerResponse.result !== "success") {
      drawerResponse = await sendContentCommand(snapshot.mainTabId, { type: "AUTOMATION_COMMAND", command: "open-drawer" });
    }
    const credited = Boolean(drawerResponse.taskDrawer && drawerShowsTaskCredit(drawerResponse.taskDrawer, taskId, snapshot.progressBefore));
    if (drawerResponse.result === "success" && drawerResponse.taskDrawer && credited) {
      const row = drawerResponse.taskDrawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
      if (row?.completed) {
        await markTaskComplete(runId, taskId, {
          kind: "drawer-complete",
          detail: `${catalogEntry.groupId} row reported complete after the verified child task`,
          at: Date.now()
        });
      } else if (row?.progress) {
        await markTaskProgress(runId, taskId, row.progress);
      } else if (!row && taskRowDisappearsOnCompletion(catalogEntry)) {
        await markTaskComplete(runId, taskId, {
          kind: "drawer-disappeared",
          detail: `${catalogEntry.groupId} row disappeared after the verified child task`,
          at: Date.now()
        });
      }
      if (snapshot.executionMode === "parallel") queueMainDrive(runId);
      else await processDrawer(runId, drawerResponse.taskDrawer);
      return;
    }
    await delay(AUTOMATION_POLL_INTERVAL_MS);
  }

  if (snapshot.executionMode === "parallel") {
    const reason = `No verified ${taskId} drawer completion appeared before the bounded wait expired`;
    if (await scheduleTaskRetry(runId, taskId, reason)) {
      queueMainDrive(runId);
    } else {
      await markTaskWaiting(runId, taskId, reason);
    }
    await maybeFinalizeParallelRun(runId);
    return;
  }
  const reason = `No verified ${taskId} drawer completion appeared before the bounded wait expired`;
  if (await scheduleTaskRetry(runId, taskId, reason)) {
    queueMainDrive(runId);
    return;
  }
  await pauseRun(runId, "waiting_for_manual_action", reason);
}

async function processDrawer(runId: string, initialDrawer: NonNullable<AutomationContentResponse["taskDrawer"]>): Promise<void> {
  let drawer = initialDrawer;
  const snapshot = await serialized(async () => getRun());
  if (!snapshot || snapshot.id !== runId || isTerminalRunState(snapshot.state) || isPausedRunState(snapshot.state)) return;

  for (const taskId of snapshot.taskOrder) {
    const currentRun = await serialized(async () => getRun());
    if (!currentRun || currentRun.id !== runId || isTerminalRunState(currentRun.state) || isPausedRunState(currentRun.state)) return;
    const taskRun = currentRun.tasks[taskId];
    if (["complete", "skipped", "waiting_for_manual_action", "failed"].includes(taskRun.state)) continue;
    const catalogEntry = TASK_CATALOG_BY_ID[taskId];
    drawer = await waitForDrawerTask(currentRun.mainTabId ?? -1, drawer, catalogEntry.groupId);
    const row = drawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
    if (!row) {
      await pauseRun(runId, "waiting_for_manual_action", `Task ${taskId} was not present in the live drawer`);
      return;
    }

    recordLog({
      level: "debug",
      event: "task-row-observed",
      message: `${taskId} group ${catalogEntry.groupId} observed as ${row.actionState}`,
      runId,
      taskId,
      tabId: currentRun.mainTabId,
      data: {
        action: row.actionText,
        progress: row.progress ? `${row.progress.current}/${row.progress.total}` : null,
        completed: row.completed
      }
    });

    if (row.completed) {
      await markTaskComplete(runId, taskId, {
        kind: "drawer-complete",
        detail: `${catalogEntry.groupId} row reported complete`,
        at: Date.now()
      });
      continue;
    }

    const liveSession = await serialized(() => getAutomationSession());
    if (liveSession && taskHasActiveWork(liveSession, taskId)) return;
    if (taskRun.state === "running") {
      const before = taskRun.progressBefore;
      if (row.progress && (before ? row.progress.current > before.current : row.progress.current > 0)) {
        await markTaskProgress(runId, taskId, row.progress);
      } else if (taskRun.outcomeCheckNotBefore && taskRun.outcomeCheckNotBefore > Date.now()) {
        return;
      } else if (await scheduleTaskRetry(runId, taskId, `${taskId} did not provide progress or completion evidence after navigation`)) {
        queueMainDrive(runId);
        return;
      } else {
        await pauseRun(runId, "waiting_for_manual_action", `${taskId} did not provide progress or completion evidence after navigation`);
        return;
      }
    }
    if (row.actionState !== "active") {
      await pauseRun(runId, "waiting_for_manual_action", `${taskId} row action was ${row.actionState}`);
      return;
    }
    const progressBefore = mostAdvancedTaskProgress(row.progress, taskRun.progressAfter);
    const attemptsRemaining = taskClicksRemaining(catalogEntry, progressBefore);
    const actionAttemptLimit = taskActionAttemptLimit(catalogEntry);
    if (!taskRetriesUntilComplete(catalogEntry) && taskRun.attempts >= actionAttemptLimit) {
      await failRun(runId, "fatal_error", `${taskId} reached the bounded action-attempt limit`);
      return;
    }

    await updateRun(runId, (run) => {
      const task = run.tasks[taskId];
      run.state = "running_tasks";
      run.currentTaskId = taskId;
      task.state = "running";
      task.attempts += 1;
      task.attemptsRemaining = attemptsRemaining;
      task.startedAt ??= Date.now();
      task.progressBefore = progressBefore;
      task.error = undefined;
    });
    recordLog({
      level: "info",
      event: "task-started",
      message: `Starting ${taskId}`,
      runId,
      taskId,
      tabId: currentRun.mainTabId,
      data: {
        progress: progressBefore ? `${progressBefore.current}/${progressBefore.total}` : null,
        attemptsRemaining
      }
    });

    const armed = await serialized(() => armNavigationLocked(runId, currentRun.mainTabId ?? -1, taskId));
    if (!armed.ok || !armed.expectedId) {
      await failRun(runId, "retryable_error", armed.error ?? `Could not arm ${taskId}`);
      return;
    }
    const clickResponse = await clickMainTask(runId, taskId, currentRun.mainTabId ?? -1);
    recordLog({
      level: clickResponse.result === "clicked" ? "info" : "warn",
      event: "task-click-result",
      message: `${taskId} click returned ${clickResponse.result}`,
      runId,
      taskId,
      tabId: currentRun.mainTabId,
      data: {
        clicked: clickResponse.clicked ?? false,
        clickCount: clickResponse.clickCount ?? 0,
        error: clickResponse.error ?? null,
        targetTag: clickResponse.clickTarget?.tagName ?? null,
        targetClass: clickResponse.clickTarget?.className ?? null,
        targetText: clickResponse.clickTarget?.text ?? null,
        targetRole: clickResponse.clickTarget?.role ?? null
      }
    });
    if (clickResponse.result === "clicked") {
      const outcome = await waitForTaskOutcome(runId, taskId, armed.expectedId!, currentRun.mainTabId ?? -1);
      if (outcome.kind === "credited") {
         if (!(await claimExpectedNavigation(runId, armed.expectedId!, currentRun.mainTabId ?? -1, true))) return;
        const creditedRow = outcome.drawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
        if (creditedRow?.completed) {
          await markTaskComplete(runId, taskId, {
            kind: "drawer-complete",
            detail: `${catalogEntry.groupId} completed after direct drawer credit`,
            at: Date.now()
          });
        } else if (creditedRow?.progress) {
          await markTaskProgress(runId, taskId, creditedRow.progress);
        }
        recordLog({
          level: "info",
          event: "direct-task-credit",
          message: `${taskId} credited without child navigation`,
          runId,
          taskId,
          tabId: currentRun.mainTabId,
         data: {
            progress: creditedRow?.progress ? `${creditedRow.progress.current}/${creditedRow.progress.total}` : null,
            completed: creditedRow?.completed ?? false
          }
        });
        await delay(OPTIONAL_CHILD_CLOSE_MS);
        const freshDrawer = await sendContentCommand(currentRun.mainTabId ?? -1, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
        if (freshDrawer.result === "success" && freshDrawer.taskDrawer) {
          await processDrawer(runId, freshDrawer.taskDrawer);
        } else {
          await failRun(runId, freshDrawer.result, "Task drawer could not be refreshed after direct credit");
        }
      } else if (outcome.kind === "timeout") {
        await handleNavigationWatchdog(armed.expectedId!);
      }
      return;
    }

    await serialized(async () => clearExpectedNavigationLocked(await getAutomationSession(), armed.expectedId));
    if (clickResponse.result === "already_complete") {
      await markTaskComplete(runId, taskId, {
        kind: "drawer-complete",
        detail: `${catalogEntry.groupId} completed before the click`,
        at: Date.now()
      });
      drawer = clickResponse.taskDrawer ?? drawer;
      continue;
    }
    if (clickResponse.result === "retryable_error" && taskRetriesUntilComplete(catalogEntry)) {
      const reason = clickResponse.error ?? `${taskId} click failed transiently`;
      if (await scheduleTaskRetry(runId, taskId, reason)) {
        queueMainDrive(runId);
        return;
      }
    }
    if (clickResponse.result === "manual_action_required" || clickResponse.result === "unknown_state") {
      await pauseRun(runId, "waiting_for_manual_action", clickResponse.error ?? `${taskId} could not be clicked safely`);
    } else {
      await failRun(runId, clickResponse.result, clickResponse.error ?? `${taskId} click failed`);
    }
    return;
  }

  const settled = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    return Boolean(
      run && run.id === runId && session?.runId === runId &&
      !run.taskOrder.some((taskId) => run.tasks[taskId].state === "running" ||
        (run.tasks[taskId].outcomeCheckNotBefore ?? 0) > Date.now()) &&
      !Object.values(session?.expectedNavigations ?? {}).length &&
      !Object.values(session?.childTabs ?? {}).length
    );
  });
  if (!settled) return;
  const completed = await serialized(async () => {
    const run = await getRun();
    return Boolean(run && run.id === runId && enabledTasksComplete(run));
  });
  await completeRun(runId, completed ? "succeeded" : "partially_succeeded");
}

async function driveMain(runId: string): Promise<void> {
  const initial = await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
     if (!run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== runId) return undefined;
    return { run, session };
  });
  if (!initial) return;

  if (initial.run.state === "running_tasks") {
    const drawer = await sendContentCommand(initial.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
    if (drawer.result === "success" && drawer.taskDrawer) {
      const settings = await getSettings();
      if (initial.run.executionMode === "parallel") await processDrawerParallel(runId, drawer.taskDrawer);
      else await processDrawer(runId, drawer.taskDrawer);
    }
    else await failRun(runId, drawer.result, "Task drawer could not be observed on the main tab");
    return;
  }

  await updateRun(runId, (run) => {
    run.state = "loading_coin_page";
    run.mainTabId = initial.session.mainTabId;
    run.mainWindowId = initial.session.mainWindowId;
  });
  recordLog({ level: "info", event: "coin-page-loading", message: "Observing the controlled coin page", runId, tabId: initial.session.mainTabId });

  const observed = await sendContentCommand(initial.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "observe-coin" });
  if (observed.result !== "success" || !observed.coinIndex) {
    await failRun(runId, observed.result, observed.error ?? "Coin page observation failed");
    return;
  }
  if (observed.coinIndex.state === "collectable") {
    await updateRun(runId, (run) => { run.state = "collecting_daily"; });
    recordLog({ level: "info", event: "daily-collect-started", message: "Collect state verified; sending one click", runId, tabId: initial.session.mainTabId });
    let collected = await sendContentCommand(initial.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "collect-daily" });
    if (collected.result === "retryable_error") {
      recordLog({
        level: "info",
        event: "daily-collect-retry",
        message: collected.error ?? "Retrying a transient daily collection failure",
        runId,
        tabId: initial.session.mainTabId
      });
      await delay(DAILY_COLLECT_RETRY_DELAY_MS);
      collected = await sendContentCommand(initial.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "collect-daily" });
    }
    if (collected.result !== "success" && collected.result !== "already_complete") {
      recordLog({
        level: "warn",
        event: "daily-collect-failed",
        message: collected.error ?? "Daily collection did not produce completion evidence",
        runId,
        tabId: initial.session.mainTabId,
        data: collected.coinIndex
          ? {
              state: collected.coinIndex.state,
              buttonText: collected.coinIndex.buttonText,
              buttonDisabled: collected.coinIndex.buttonDisabled,
              buttonVisible: collected.coinIndex.buttonVisible,
              buttonHasGeometry: collected.coinIndex.buttonHasGeometry
            }
          : undefined
      });
      await failRun(runId, collected.result, collected.error ?? "Daily collection did not produce completion evidence");
      return;
    }
    recordLog({ level: "info", event: "daily-collect-finished", message: collected.evidence?.detail ?? "Daily collection complete", runId });
  } else if (observed.coinIndex.state === "already-checked" || observed.coinIndex.state === "task-opener") {
    recordLog({ level: "info", event: "coin-reward-already-complete", message: `Coin reward state was ${observed.coinIndex.state}`, runId });
  } else {
    await failRun(runId, "unknown_state", "Coin page did not expose a verified collectable or already-checked state");
    return;
  }

  await updateRun(runId, (run) => { run.state = "opening_task_drawer"; });
  const drawer = await sendContentCommand(initial.session.mainTabId, { type: "AUTOMATION_COMMAND", command: "open-drawer" });
  if (drawer.result !== "success" || !drawer.taskDrawer) {
    recordLog({
      level: "warn",
      event: "task-opener-failed",
      message: drawer.error ?? "Task drawer opener did not complete",
      runId,
      tabId: initial.session.mainTabId,
      data: drawer.coinIndex
        ? {
            state: drawer.coinIndex.state,
            buttonText: drawer.coinIndex.buttonText,
            buttonDisabled: drawer.coinIndex.buttonDisabled,
            buttonVisible: drawer.coinIndex.buttonVisible,
            buttonHasGeometry: drawer.coinIndex.buttonHasGeometry
          }
        : undefined
    });
    await failRun(runId, drawer.result, drawer.error ?? "Task drawer did not open");
    return;
  }
  await updateRun(runId, (run) => { run.state = "running_tasks"; });
  const settings = await getSettings();
  if (initial.run.executionMode === "parallel") await processDrawerParallel(runId, drawer.taskDrawer);
  else await processDrawer(runId, drawer.taskDrawer);
}

async function startAutomationLocked(trigger: RunTrigger, attempt = 1): Promise<Phase0Response> {
  const existing = await getRun();
  if (existing && !isTerminalRunState(existing.state)) {
    const session = await getAutomationSession();
    if (session?.runId === existing.id) {
      try {
        await chrome.tabs.get(session.mainTabId);
        return { ok: false, error: `Automation is already ${existing.state}`, run: existing };
      } catch {
        await setAutomationSession(undefined);
      }
    }
    await updateRunLocked(existing.id, (run) => {
      run.state = "interrupted";
      run.lastError = "The previous run lost its current-session ownership";
      run.finishedAt = Date.now();
    });
    await closeAutomationRunLocked(existing.id);
    await appendLog({
      level: "warn",
      event: "stale-run-recovered",
      message: "Recovered a run whose current-session automation session was missing",
      runId: existing.id
    });
  }

  const settings = await getSettings();
  const run = createRun(trigger, settings, attempt);
  if (!(await acquireLeaseLocked(run.id))) return { ok: false, error: "Another automation run owns the account lease" };
  await setRun(run);
  await appendLog({ level: "info", event: "run-started", message: `Started ${trigger} automation run`, runId: run.id });

  try {
    await updateRunLocked(run.id, (current) => { current.state = "preparing_mobile_tab"; });
    const focus = trigger === "manual" ? settings.automation.focusManualRuns : settings.automation.focusScheduledRuns;
    const main = await openProbeSession(COIN_INDEX_URL, true, settings.automation.compactWindow, "automation", run.id, focus);
    await updateRunLocked(run.id, (current) => {
      current.mainTabId = main.tabId;
      current.mainWindowId = main.windowId;
      current.state = "loading_coin_page";
    });
    await setAutomationSession({
      runId: run.id,
      mainTabId: main.tabId,
      mainWindowId: main.windowId,
      mainWindowOwned: settings.automation.compactWindow && main.windowId !== undefined,
      childTabs: {},
      expectedNavigations: {}
    });
    await appendLog({ level: "info", event: "main-tab-opened", message: "Controlled mobile coin tab opened", runId: run.id, tabId: main.tabId });
    return { ok: true, run: await getRun() };
  } catch (error) {
    await updateRunLocked(run.id, (current) => {
      current.state = "failed_terminal";
      current.lastError = error instanceof Error ? error.message : String(error);
      current.finishedAt = Date.now();
    });
    await setLease(undefined);
    await appendLog({ level: "error", event: "run-start-failed", message: error instanceof Error ? error.message : String(error), runId: run.id });
    return { ok: false, error: error instanceof Error ? error.message : String(error), run: await getRun() };
  }
}

async function stopAutomationLocked(): Promise<Phase0Response> {
  const run = await getRun();
  if (!run || isTerminalRunState(run.state)) return { ok: true, run };
  await updateRunLocked(run.id, (current) => {
    current.state = "cancelled";
    current.finishedAt = Date.now();
    current.lastError = "Stopped by user";
  }, true);
  await appendLog({ level: "warn", event: "run-stopped", message: "Automation stopped by user", runId: run.id });
  await closeAutomationRunLocked(run.id);
  return { ok: true, run: await getRun() };
}

async function resumeAutomationLocked(): Promise<Phase0Response> {
  const run = await getRun();
  if (!run || !["waiting_for_login", "waiting_for_manual_action"].includes(run.state)) {
    return { ok: false, error: "No paused automation run is waiting for resume", run };
  }
  const session = await getAutomationSession();
  if (!session || session.runId !== run.id) {
    return { ok: false, error: "The paused automation session is no longer available", run };
  }
  if (!(await acquireLeaseLocked(run.id))) return { ok: false, error: "Another automation run owns the account lease", run };

  const wasWaitingForLogin = run.state === "waiting_for_login";
  const childTabs = Object.values(session.childTabs);
  const resumed = await updateRunLocked(run.id, (current) => {
    current.state = childTabs.length ? "running_tasks" : "loading_coin_page";
    current.lastError = undefined;
    if (current.executionMode === "sequential") {
      for (const taskId of current.taskOrder) {
        if (current.tasks[taskId].state !== "waiting_for_manual_action") continue;
        current.tasks[taskId].state = "pending";
        current.tasks[taskId].finishedAt = undefined;
        current.tasks[taskId].outcomeCheckNotBefore = undefined;
        current.tasks[taskId].error = undefined;
      }
    }
  }, true);
  if (!resumed) {
    await setLease(undefined);
    return { ok: false, error: "The paused run changed before it could resume", run: await getRun() };
  }
  await appendLog({ level: "info", event: "run-resumed", message: "Automation resumed from an explicit user action", runId: run.id });

  if (wasWaitingForLogin) await chrome.tabs.update(session.mainTabId, { url: COIN_INDEX_URL });

  // A paused child may contain a manually completed quiz/mission. Close it
  // without claiming success, then re-read the drawer from fresh DOM state.
  for (const child of childTabs) void finishTaskChild(run.id, child.tabId, "manual_action_required", false, true, false);
  scheduleMainDrive(run.id);
  return { ok: true, run: await getRun() };
}

async function markUnexpectedDestination(runId: string, tabId: number, reason: string): Promise<void> {
  const child = await serialized(async () => {
    const session = await getAutomationSession();
    return session?.runId === runId ? session.childTabs[String(tabId)] : undefined;
  });
  if (child) {
    await finishTaskChild(runId, tabId, "manual_action_required", false, true);
  } else {
    await serialized(async () => {
      const session = await getAutomationSession();
      if (session?.runId === runId) await clearExpectedNavigationLocked(session);
      const sessions = await getSessionMap();
      const tab = sessions[String(tabId)];
      if (tab?.owner === "automation") {
        delete sessions[String(tabId)];
        await setSessionMap(sessions);
        if (tab.ruleId !== undefined) await removeRule(tab.ruleId);
        await chrome.tabs.remove(tabId).catch(() => undefined);
      }
    });
  }
  const run = await serialized(() => getRun());
  if (run?.executionMode === "parallel") {
    await maybeFinalizeParallelRun(runId);
    queueMainDrive(runId);
  } else {
    await pauseRun(runId, "waiting_for_manual_action", reason);
  }
  recordLog({ level: "warn", event: "unexpected-destination", message: reason, runId, tabId });
}

async function finishTaskChild(
  runId: string,
  tabId: number,
  result: AutomationResult,
  resume: boolean,
  closeTab = true,
  updateTaskState = true,
  onlyIfNotReady = false
): Promise<boolean> {
  let parentTabId: number | undefined;
  let expectedId: string | undefined;
  let taskId: TaskId | undefined;
  let childWindowId: number | undefined;
  let closeChildWindow = false;
  let handled = false;
  await serialized(async () => {
    const automationSession = await getAutomationSession();
    if (!automationSession || automationSession.runId !== runId) return;
    const child = automationSession.childTabs[String(tabId)];
    if (!child) return;
    if (onlyIfNotReady && child.contentReady) return;
    handled = true;
    parentTabId = child.parentTabId;
    expectedId = child.expectedId;
    taskId = child.taskId;
    childWindowId = child.windowId;
    delete automationSession.childTabs[String(tabId)];
    await setAutomationSession(automationSession);

    const sessions = await getSessionMap();
    const ownedTab = sessions[String(tabId)];
    delete sessions[String(tabId)];
    await setSessionMap(sessions);
    if (ownedTab?.ruleId !== undefined) await removeRule(ownedTab.ruleId);
    if (child.closeAlarmName) await chrome.alarms.clear(child.closeAlarmName).catch(() => false);
    if (child.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
    if (closeTab) {
      const childWindow = childWindowId === undefined ? undefined : await chrome.windows.get(childWindowId).catch(() => undefined);
      const ownedChildrenInWindow = childWindowId === undefined
        ? []
        : Object.values(automationSession.childTabs).filter((candidate) => candidate.windowId === childWindowId);
      closeChildWindow = childWindow?.type === "popup" && ownedChildrenInWindow.length === 0;
      await chrome.tabs.remove(tabId).catch(() => undefined);
      if (closeChildWindow && childWindowId !== undefined) await chrome.windows.remove(childWindowId).catch(() => undefined);
    }
    await appendLog({
      level: result === "success" ? "info" : "warn",
      event: closeTab ? "child-closed" : "child-released",
      message: `${closeTab ? "Closed" : "Released"} ${taskId ?? "task"} child after ${result}`,
      runId,
      taskId,
      tabId,
      data: { route: child.route ?? "unknown", itemId: child.itemId ?? null }
    });
    if (taskId && resume && result === "success") {
      const finishedTaskId = taskId;
      const outcomeCheckNotBefore = Date.now() + POST_CHILD_RESUME_DELAY_MS + TASK_DRAWER_CONFIRMATION_WAIT_MS;
      await updateRunLocked(runId, (run) => {
        run.tasks[finishedTaskId].outcomeCheckNotBefore = outcomeCheckNotBefore;
      });
      await chrome.alarms.create(`${TASK_OUTCOME_CHECK_PREFIX}${runId}:${finishedTaskId}`, { when: outcomeCheckNotBefore });
    }
    if (taskId && updateTaskState && result !== "success") {
      const finishedTaskId = taskId;
      await updateRunLocked(runId, (run) => {
        const task = run.tasks[finishedTaskId];
        task.state = ["retryable_error", "fatal_error"].includes(result) ? "failed" : "waiting_for_manual_action";
        task.finishedAt = Date.now();
        task.outcomeCheckNotBefore = undefined;
        task.error = `Child ended with ${result}`;
      });
    }
  });

  if (!handled) return false;

  if (parentTabId !== undefined && expectedId) {
    await chrome.tabs.sendMessage(parentTabId, {
      type: "AUTOMATION_CHILD_FINISHED",
      expectedId,
      result
    } satisfies Phase0Message).catch(() => undefined);
  }
  if (resume && taskId && result === "success") {
    await markTaskActionAccepted(runId, taskId, "Child completed successfully; awaiting drawer completion state");
    void resumeAfterTaskChild(runId, taskId);
  }
  return true;
}

type ChildCommitAction =
  | { kind: "login"; taskId: TaskId }
  | { kind: "unexpected"; taskId: TaskId }
  | { kind: "item"; taskId: TaskId; itemId: string }
  | { kind: "controller"; taskId: TaskId; route: RouteKind; contentReady: boolean }
  | { kind: "finish"; taskId: TaskId }
  | { kind: "scheduled"; taskId: TaskId; expectedId: string; optional: boolean };

async function handleChildCommitted(runId: string, tabId: number, rawUrl: string): Promise<void> {
  const route = classifyRoute(rawUrl);
  const action = await serialized(async (): Promise<ChildCommitAction | undefined> => {
    const [session, run, settings] = await Promise.all([getAutomationSession(), getRun(), getSettings()]);
    const child = session?.runId === runId ? session.childTabs[String(tabId)] : undefined;
    if (!child || !run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) return undefined;

    const taskId = child.taskId;
    const entry = TASK_CATALOG_BY_ID[taskId];
    if (route === "login") return { kind: "login", taskId };

    const destination = child.itemId
      ? route === "item" && itemDestinationMatches(child.itemId, rawUrl)
      : !taskDestinationMatters(entry) || (taskAllowsRoute(entry, route) && taskDestinationMatches(entry, rawUrl));
    if (!destination) {
      // Optional task pages may redirect back to Coins after crediting the visit.
      if (entry.navigation === "optional-child" && child.committedAt !== undefined) return { kind: "finish", taskId };
      return { kind: "unexpected", taskId };
    }

    const expectedId = child.expectedId;
    const needsContentController = entry.policy === "surprise" || entry.policy === "quiz";
    const routeChanged = child.route !== undefined && child.route !== route;
    child.route = route;
    child.committedAt ??= Date.now();
    if (routeChanged) {
      child.committedAt = Date.now();
      child.contentReady = false;
      child.controllerStarted = false;
    }
    if (child.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
    if (needsContentController && !child.contentReady) {
      child.readyAlarmName = `${CHILD_READY_WATCHDOG_PREFIX}${expectedId}`;
      await chrome.alarms.create(child.readyAlarmName, { when: Date.now() + settings.timeouts.pageLoadMs });
    } else {
      child.readyAlarmName = undefined;
    }
    await setAutomationSession(session);
    await updateRunLocked(runId, (currentRun) => {
      currentRun.state = "running_tasks";
      currentRun.currentTaskId = taskId;
      currentRun.tasks[taskId].navigationMode = "new-tab";
    });

    // Surprise item tabs are completion evidence; landing pages and quizzes
    // need a content controller before they can report completion.
    if (child.itemId || (entry.policy === "surprise" && route === "item")) {
      return { kind: "item", taskId, itemId: child.itemId ?? itemIdFromUrl(rawUrl) ?? "unknown" };
    }
    if (entry.policy === "surprise" || entry.policy === "quiz") {
      return { kind: "controller", taskId, route, contentReady: child.contentReady === true };
    }

    const dwellMs = taskChildDwellMs(entry, settings.timeouts.passiveDwellMs, settings.timeouts.assistedDwellMs);
    if (!dwellMs) return { kind: "finish", taskId };

    const closeNotBefore = Date.now() + dwellMs;
    child.closeNotBefore = closeNotBefore;
    child.closeAlarmName = `${CHILD_CLOSE_ALARM_PREFIX}${expectedId}`;
    await setAutomationSession(session);
    await updateRunLocked(runId, (currentRun) => {
      currentRun.tasks[taskId].closeNotBefore = closeNotBefore;
    });
    await chrome.alarms.create(child.closeAlarmName, { when: closeNotBefore });
    await appendLog({
      level: "info",
      event: "child-dwell-started",
      message: `${taskId} child retained for ${dwellMs / 1000}s`,
      runId,
      taskId,
      tabId,
      data: { closeNotBefore, url: safeUrl(rawUrl) }
    });
    return { kind: "scheduled", taskId, expectedId, optional: entry.navigation === "optional-child" };
  });

  if (!action) return;
  if (action.kind === "login") {
    await finishTaskChild(runId, tabId, "login_required", false, false);
    await pauseRun(runId, "waiting_for_login", "AliExpress requested login in a controlled child tab");
    return;
  }
  if (action.kind === "unexpected") {
    await markUnexpectedDestination(runId, tabId, `Expected ${action.taskId} route did not match: ${safeUrl(rawUrl)}`);
    return;
  }
  if (action.kind === "item") {
    await appendLog({
      level: "info",
      event: "task-action-evidence",
      message: `Committed allowlisted surprise item ${action.itemId}`,
      runId,
      taskId: action.taskId,
      tabId,
      data: { url: safeUrl(rawUrl) }
    });
    await finishTaskChild(runId, tabId, "success", false);
    return;
  }
  if (action.kind === "controller") {
    if (action.contentReady) void startChildController(runId, tabId, action.route);
    return;
  }
  if (action.kind === "finish") {
    await finishTaskChild(runId, tabId, "success", true);
    return;
  }
  if (action.optional) setTimeout(() => void handleChildCloseDeadline(action.expectedId), OPTIONAL_CHILD_CLOSE_MS);
}

async function startChildController(runId: string, tabId: number, route: string): Promise<void> {
  if (activeChildControllers.has(tabId)) return;
  activeChildControllers.add(tabId);
  try {
  const snapshot = await serialized(async () => {
    const session = await getAutomationSession();
    const run = await getRun();
    const child = session?.runId === runId ? session.childTabs[String(tabId)] : undefined;
    if (!session || !run || run.id !== runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !child) return undefined;
    return { child, run };
  });
   if (!snapshot) return;
   const entry = TASK_CATALOG_BY_ID[snapshot.child.taskId];
   const expectedRoute = entry.policy === "surprise" ? "surprise-items" : entry.policy === "quiz" ? "quiz" : undefined;
   if (!expectedRoute || snapshot.child.route !== route || expectedRoute !== route || !snapshot.child.contentReady) return;
   const claimed = await serialized(async () => {
     const session = await getAutomationSession();
     const child = session?.runId === runId ? session.childTabs[String(tabId)] : undefined;
     if (!child || child.controllerStarted) return false;
     child.controllerStarted = true;
     await setAutomationSession(session);
     return true;
   });
   if (!claimed) return;
   const command: AutomationContentCommand = entry.policy === "surprise"
    ? { type: "AUTOMATION_COMMAND", command: "run-surprise", selectedItemIds: snapshot.run.tasks[snapshot.child.taskId].selectedItemIds }
    : { type: "AUTOMATION_COMMAND", command: "run-quiz" };
  recordLog({ level: "info", event: "child-controller-started", message: `Running ${entry.policy} controller on ${route}`, runId, taskId: entry.id, tabId });
   const result = await sendContentCommand(tabId, command);
   if (result.result === "success" || result.result === "already_complete") {
     if (result.evidence) {
       recordLog({ level: "info", event: "task-action-evidence", message: result.evidence.detail, runId, taskId: entry.id, tabId });
     }
     if (entry.policy === "surprise" && result.result === "success") {
       await markTaskComplete(runId, entry.id, result.evidence);
       await finishTaskChild(runId, tabId, "success", false);
       if (snapshot.run.executionMode === "parallel") queueMainDrive(runId);
       return;
     }
      await finishTaskChild(runId, tabId, "success", true);
      return;
   }
    const reason = result.error ?? `${entry.id} controller stopped`;
    const retryableControllerResult = ["retryable_error", "unknown_state", "not_available"].includes(result.result);
    if (retryableControllerResult && taskRetriesUntilComplete(entry)) {
      await finishTaskChild(runId, tabId, result.result, false, true, false);
      if (await scheduleTaskRetry(runId, entry.id, reason)) {
        queueMainDrive(runId);
        return;
      }
    }
    if (snapshot.run.executionMode === "parallel") {
     // A manual-only child must not pause unrelated parallel tasks that are
      // still making progress, such as the Surprise controller.
      await finishTaskChild(runId, tabId, result.result, false, true, false);
      if (!retryableControllerResult || !(await scheduleTaskRetry(runId, entry.id, reason))) {
        await markTaskWaiting(runId, entry.id, reason);
      }
      await maybeFinalizeParallelRun(runId);
      queueMainDrive(runId);
      return;
   }
   await pauseRun(runId, "waiting_for_manual_action", result.error ?? `${entry.id} controller stopped`);
  } finally {
    activeChildControllers.delete(tabId);
  }
}

function scheduleMainDrive(runId: string): void {
  if (activeMainDrives.has(runId)) {
    pendingMainDrives.add(runId);
    return;
  }
  activeMainDrives.add(runId);
  void driveMain(runId)
    .catch((error: unknown) => failRun(runId, "retryable_error", error instanceof Error ? error.message : String(error)))
    .finally(() => {
      activeMainDrives.delete(runId);
      if (!pendingMainDrives.delete(runId)) return;
      scheduleMainDrive(runId);
    });
}

async function handleAutomationContentReady(tabId: number, route: string, url: string): Promise<void> {
  let action: "main" | "child" | undefined;
  let runId: string | undefined;
  await serialized(async () => {
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    if (!run || isTerminalRunState(run.state) || isPausedRunState(run.state) || !session || session.runId !== run.id) return;
    const main = tabId === session.mainTabId;
    const child = session.childTabs[String(tabId)];
    if (!main && !child) return;
    runId = run.id;

    if (route === "login") {
      await pauseRunLocked(run.id, "waiting_for_login", "AliExpress requested login before the current automation step");
      return;
    }
    if (main) {
      if (route !== "coin-index") {
        await pauseRunLocked(run.id, "waiting_for_manual_action", `Main automation tab reached unexpected route: ${safeUrl(url)}`);
        return;
      }
      action = "main";
      return;
    }
    if (child) {
      const entry = TASK_CATALOG_BY_ID[child.taskId];
      const controllerRoute = entry.policy === "surprise" ? "surprise-items" : entry.policy === "quiz" ? "quiz" : undefined;
      if (controllerRoute === route && (!child.route || child.route === route)) {
        child.route = route;
        child.contentReady = true;
        if (child.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
        child.readyAlarmName = undefined;
        await setAutomationSession(session);
        action = "child";
      }
    }
  });

  if (!runId) return;
  if (action === "main") scheduleMainDrive(runId);
  else if (action === "child") {
    const session = await serialized(() => getAutomationSession());
    const child = session?.runId === runId ? Object.values(session.childTabs).find((candidate) => candidate.route && candidate.tabId === tabId) : undefined;
    if (child) void startChildController(runId, tabId, child.route ?? route);
    else void startChildController(runId, tabId, route);
  }
}

async function detachAutomationChildLocked(session: AutomationSession, tab: chrome.tabs.Tab): Promise<number> {
  if (tab.id === undefined) return tab.windowId;
  const currentWindow = await chrome.windows.get(tab.windowId).catch(() => undefined);
  if (currentWindow?.type === "popup" && currentWindow.id !== undefined) {
    await chrome.windows.update(currentWindow.id, {
      width: AUTOMATION_POPUP_WIDTH,
      height: AUTOMATION_POPUP_HEIGHT
    }).catch(() => undefined);
    return currentWindow.id;
  }

  const detached = await chrome.windows.create({
    tabId: tab.id,
    type: "popup",
    focused: false,
    width: AUTOMATION_POPUP_WIDTH,
    height: AUTOMATION_POPUP_HEIGHT
  }).catch(() => undefined);
  if (detached?.id !== undefined) {
    const bounds = await automationChildPopupBounds(session);
    if (bounds) await chrome.windows.update(detached.id, { ...bounds, focused: false }).catch(() => undefined);
  }
  return detached?.id ?? tab.windowId;
}

async function reuseManualMobileTabLocked(source: ProbeSession, discardedTabId: number, url: string): Promise<boolean> {
  if (source.tabId === discardedTabId || !isAliExpressPageUrl(url)) return false;
  await chrome.tabs.remove(discardedTabId).catch(() => undefined);
  await chrome.tabs.update(source.tabId, { active: true }).catch(() => undefined);
  if (source.windowId !== undefined) {
    await chrome.windows.update(source.windowId, { focused: true }).catch(() => undefined);
  }
  try {
    await navigateWithMobileUserAgent(source.tabId, url);
  } catch (error) {
    await appendLog({
      level: "warn",
      event: "manual-mobile-navigation-failed",
      message: error instanceof Error ? error.message : String(error),
      tabId: source.tabId,
      data: { discardedTabId, url: safeUrl(url) }
    });
    return true;
  }
  await appendLog({
    level: "info",
    event: source.role === "child" ? "manual-mobile-child-link-reused" : "manual-mobile-main-link-reused",
    message: source.role === "child"
      ? "Reused the existing mobile child tab for a subsequent AliExpress link"
      : "Reused the main mobile probe tab for an AliExpress link",
    tabId: source.tabId,
    data: { sourceTabId: source.tabId, discardedTabId, url: safeUrl(url) }
  });
  return true;
}

async function handleManualMobileNavigationLocked(tabId: number, url: string, openerTabId?: number): Promise<boolean> {
  const sessions = await getSessionMap();
  const direct = sessions[String(tabId)];
  if (direct?.owner !== "automation" && direct?.role === "child") return false;
  const source = direct?.owner !== "automation" && direct?.mobile && direct.role === "main"
    ? direct
    : openerTabId === undefined
      ? undefined
      : sessions[String(openerTabId)];
  if (!source || source.owner === "automation" || !source.mobile || !["main", "child"].includes(source.role ?? "") || !isAliExpressPageUrl(url)) return false;
  if (direct === source && source.role === "main" && classifyRoute(url) === "coin-index") return false;

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.id === undefined) return false;

  if (source.tabId === tabId) return false;
  return reuseManualMobileTabLocked(source, tab.id, url);
}

async function restoreNavigationFocus(expected: ExpectedNavigation): Promise<void> {
  if (expected.itemNavigation) await chrome.tabs.update(expected.sourceTabId, { active: true }).catch(() => undefined);
  if (expected.returnFocusTabId !== undefined) await chrome.tabs.update(expected.returnFocusTabId, { active: true }).catch(() => undefined);
  if (expected.returnFocusWindowId !== undefined) {
    await chrome.windows.update(expected.returnFocusWindowId, { focused: true }).catch(() => undefined);
  }
}

async function handleCreatedTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.openerTabId === undefined) return;
  const session = await getAutomationSession();
  if (!session) return;
  const sourceChild = Object.values(session.childTabs).find((child) => child.tabId === tab.openerTabId);
  const initialUrl = tab.pendingUrl ?? tab.url;
  if (sourceChild && initialUrl && initialUrl !== "about:blank" && !expectedForCreatedNavigation(session, tab.openerTabId, initialUrl)) {
    await chrome.tabs.remove(tab.id as number).catch(() => undefined);
    await appendLog({
      level: "warn",
      event: "unowned-child-tab-closed",
      message: `Closed a tab opened by ${sourceChild.taskId} without an expected navigation`,
      runId: session.runId,
      taskId: sourceChild.taskId,
      tabId: tab.id,
      data: { sourceTabId: tab.openerTabId, url: safeUrl(initialUrl) }
    });
    return;
  }
  const candidates = expectedNavigationCandidates(session, tab.openerTabId).filter((expected) => expected.itemNavigation);
  if (candidates.length === 1) await restoreNavigationFocus(candidates[0]);
}

async function handleUpdatedChildTab(tabId: number, rawUrl: string, openerTabId: number | undefined): Promise<void> {
  if (openerTabId === undefined || rawUrl === "about:blank") return;
  const session = await getAutomationSession();
  if (!session) return;
  const sourceChild = Object.values(session.childTabs).find((child) => child.tabId === openerTabId);
  if (!sourceChild || expectedForCreatedNavigation(session, openerTabId, rawUrl)) return;
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await appendLog({
    level: "warn",
    event: "unowned-child-tab-closed",
    message: `Closed a tab opened by ${sourceChild.taskId} after an unexpected navigation`,
    runId: session.runId,
    taskId: sourceChild.taskId,
    tabId,
    data: { sourceTabId: openerTabId, url: safeUrl(rawUrl) }
  });
}

async function adoptCreatedNavigationTargetLocked(
  session: AutomationSession,
  expected: ExpectedNavigation,
  tabId: number,
  sourceTabId: number,
  tab: chrome.tabs.Tab,
  initialUrl: string | undefined,
  detach = true
): Promise<boolean> {
  const run = await getRun();
  if (!run || run.id !== expected.runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) return false;
  if (initialUrl && initialUrl !== "about:blank" && !destinationMatchesExpected(expected, initialUrl)) {
    await chrome.tabs.remove(tabId).catch(() => undefined);
    await clearExpectedNavigationLocked(session, expected.id);
    if (!taskDestinationMatters(TASK_CATALOG_BY_ID[expected.taskId])) {
      queueMainDrive(expected.runId);
      return false;
    }
    if (expected.taskId === "surprise_items" && expected.itemId) {
      await appendLog({
        level: "warn",
        event: "surprise-item-route-rejected",
        message: `Surprise item ${expected.itemId} opened an unexpected route`,
        runId: expected.runId,
        taskId: expected.taskId,
        tabId,
        data: { url: safeUrl(initialUrl) }
      });
      await chrome.tabs.sendMessage(expected.sourceTabId, {
        type: "AUTOMATION_CHILD_FINISHED",
        expectedId: expected.id,
        result: "unknown_state"
      } satisfies Phase0Message).catch(() => undefined);
      return false;
    }
    const reason = `New child route was outside the expected policy: ${safeUrl(initialUrl)}`;
    if (run.executionMode === "parallel") {
      await updateRunLocked(expected.runId, (current) => {
        const task = current.tasks[expected.taskId];
        task.state = "waiting_for_manual_action";
        task.finishedAt = Date.now();
        task.error = reason;
      });
      await appendLog({
        level: "warn",
        event: "task-waiting",
        message: reason,
        runId: expected.runId,
        taskId: expected.taskId,
        tabId
      });
      queueMainDrive(expected.runId);
    } else {
      await pauseRunLocked(expected.runId, "waiting_for_manual_action", reason);
    }
    return false;
  }

  const sessions = await getSessionMap();
  const childWindowId = detach ? await detachAutomationChildLocked(session, tab) : tab.windowId;
  if (!detach && childWindowId !== undefined) {
    const bounds = await automationChildPopupBounds(session);
    if (bounds) await chrome.windows.update(childWindowId, { ...bounds, focused: false }).catch(() => undefined);
  }
  if (expected.launchRuleId !== undefined) await removeRule(expected.launchRuleId);
  await chrome.alarms.clear(`${NAVIGATION_WATCHDOG_PREFIX}${expected.id}`).catch(() => false);

  await clearExpectedNavigationLocked(session, expected.id);
  session.childTabs[String(tabId)] = {
    tabId,
    parentTabId: sourceTabId,
    windowId: childWindowId,
    taskId: expected.taskId,
    expectedId: expected.id,
    itemId: expected.itemId,
    mobile: expected.mobile,
    readyAlarmName: `${CHILD_READY_WATCHDOG_PREFIX}${expected.id}`
  };
  await setAutomationSession(session);
  sessions[String(tabId)] = {
    id: expected.id,
    tabId,
    windowId: childWindowId,
    mobile: expected.mobile,
    ruleId: undefined,
    createdAt: Date.now(),
    owner: "automation",
    runId: expected.runId,
    role: "child"
  };
  await setSessionMap(sessions);
  await chrome.alarms.create(`${CHILD_READY_WATCHDOG_PREFIX}${expected.id}`, {
    when: Date.now() + (await getSettings()).timeouts.childCommitMs
  });
  await restoreNavigationFocus(expected);
  await updateRunLocked(expected.runId, (currentRun) => {
    const task = currentRun.tasks[expected.taskId];
    task.childTabIds.push(tabId);
    task.navigationMode = "new-tab";
    currentRun.currentTaskId = expected.taskId;
  });
  await appendLog({
    level: "info",
    event: "child-tab-created",
    message: `Attributed child tab to ${expected.taskId}`,
    runId: expected.runId,
    taskId: expected.taskId,
    tabId,
    data: { mobile: expected.mobile, itemId: expected.itemId ?? null, ruleId: null }
  });
  queueMainDrive(expected.runId);
  return true;
}

async function launchControlledChild(expectedId: string, urlOverride?: string): Promise<void> {
  let failed: { runId: string; taskId: TaskId; tabId?: number; reason: string } | undefined;
  await serialized(async () => {
    const session = await getAutomationSession();
    const expected = session?.expectedNavigations[expectedId];
    const run = await getRun();
    const url = urlOverride ?? (expected ? controlledChildUrl(expected) : undefined);
    if (!session || !expected || !run || run.id !== expected.runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || !url) return;
    if (urlOverride && !destinationMatchesExpected(expected, urlOverride)) return;
    if (!expectedRequiresChild(expected) || Object.values(session.childTabs).some((child) => child.expectedId === expectedId)) return;
    await chrome.alarms.clear(`${CONTROLLED_CHILD_LAUNCH_PREFIX}${expectedId}`).catch(() => false);
    const focusChild = expected.taskId === "surprise_items";

    const created = await chrome.windows.create({
      type: "popup",
      focused: focusChild,
      width: AUTOMATION_POPUP_WIDTH,
      height: AUTOMATION_POPUP_HEIGHT,
      url: "about:blank"
    }).catch(() => undefined);
    const tab = created?.tabs?.[0] ?? (created?.id !== undefined ? (await chrome.tabs.query({ windowId: created.id }))[0] : undefined);
    if (!tab?.id) {
      if (created?.id !== undefined) await chrome.windows.remove(created.id).catch(() => undefined);
      failed = { runId: run.id, taskId: expected.taskId, reason: "Chrome did not return a controlled child tab" };
      return;
    }

    const adopted = await adoptCreatedNavigationTargetLocked(session, expected, tab.id, expected.sourceTabId, tab, undefined, false);
    if (!adopted) {
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      return;
    }
    try {
      if (expected.mobile) await navigateWithMobileUserAgent(tab.id, url);
      else await chrome.tabs.update(tab.id, { url });
      if (focusChild) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
        if (created?.id !== undefined) await chrome.windows.update(created.id, { focused: true }).catch(() => undefined);
      }
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      failed = {
        runId: run.id,
        taskId: expected.taskId,
        tabId: tab.id,
        reason: error instanceof Error ? error.message : String(error)
      };
      return;
    }
    await appendLog({
      level: "info",
      event: "controlled-child-opened",
       message: `Opened ${expected.taskId} in a controlled mobile popup`,
      runId: run.id,
      taskId: expected.taskId,
      tabId: tab.id,
        data: { url: safeUrl(url), mobile: expected.mobile, source: urlOverride ? "live-go-navigation" : "catalog-fallback" }
    });
  });

  if (!failed) return;
  await markTaskWaiting(failed.runId, failed.taskId, `Could not open a controlled child tab: ${failed.reason}`);
  const run = await serialized(() => getRun());
  if (run?.id !== failed.runId) return;
  if (run.executionMode === "parallel") {
    await maybeFinalizeParallelRun(run.id);
    queueMainDrive(run.id);
  } else {
    await pauseRun(run.id, "waiting_for_manual_action", `Could not open a controlled child tab for ${failed.taskId}`);
  }
}

async function handleCreatedNavigationTarget(details: chrome.webNavigation.WebNavigationSourceCallbackDetails): Promise<void> {
  let capturedSurpriseNavigation: { expectedId: string; url: string; tabId: number } | undefined;
  await serialized(async () => {
    const targetTab = await chrome.tabs.get(details.tabId).catch(() => undefined);
    const initialUrl = details.url && details.url !== "about:blank"
      ? details.url
      : targetTab?.pendingUrl ?? targetTab?.url;
    if (initialUrl && initialUrl !== "about:blank" && await handleManualMobileNavigationLocked(details.tabId, initialUrl, details.sourceTabId)) return;

    const session = await getAutomationSession();
    const tab = targetTab;
    const expected = session ? expectedForCreatedNavigation(session, details.sourceTabId, initialUrl) : undefined;
    if (!session) return;
    if (!expected) {
      const sourceChild = Object.values(session.childTabs).find((child) => child.tabId === details.sourceTabId);
      if (sourceChild) {
        if (tab) await chrome.tabs.remove(details.tabId).catch(() => undefined);
        await appendLog({
          level: "warn",
          event: "unowned-child-tab-closed",
          message: `Closed a new tab opened by ${sourceChild.taskId} without an expected navigation`,
          runId: session.runId,
          taskId: sourceChild.taskId,
          tabId: details.tabId,
          data: { sourceTabId: details.sourceTabId, url: safeUrl(initialUrl ?? "about:blank") }
        });
        return;
      }
      const candidates = expectedNavigationCandidates(session, details.sourceTabId);
      const run = await getRun();
      if (details.sourceTabId === session.mainTabId && run?.id === session.runId && run.executionMode === "parallel" && candidates.length <= 1) {
        if (tab) await chrome.tabs.remove(details.tabId).catch(() => undefined);
        await appendLog({
          level: "debug",
          event: "passive-child-closed",
          message: "Closed an unowned child opened by the shared passive-task batch",
          runId: session.runId,
          tabId: details.tabId,
          data: { sourceTabId: details.sourceTabId, url: safeUrl(initialUrl ?? "about:blank") }
        });
        return;
      }
      if (candidates.length > 1) {
        if (tab) await chrome.tabs.remove(details.tabId).catch(() => undefined);
        const reason = "A new tab could not be attributed to one task safely";
        const run = await getRun();
        if (run?.id === session.runId && run.executionMode === "parallel") {
          await settleNavigationCandidatesLocked(run, session, candidates, reason);
        } else {
          await pauseRunLocked(session.runId, "waiting_for_manual_action", reason);
        }
        await appendLog({
          level: "warn",
          event: "ambiguous-child-tab",
          message: "Closed a new tab because multiple task navigation expectations matched",
          runId: session.runId,
          tabId: details.tabId,
          data: { sourceTabId: details.sourceTabId, url: safeUrl(initialUrl ?? "about:blank") }
        });
      }
      return;
    }
    if (expected.taskId === "surprise_items" && initialUrl && initialUrl !== "about:blank" && destinationMatchesExpected(expected, initialUrl)) {
      if (tab) await chrome.tabs.remove(details.tabId).catch(() => undefined);
      capturedSurpriseNavigation = { expectedId: expected.id, url: initialUrl, tabId: details.tabId };
      await appendLog({
        level: "debug",
        event: "surprise-live-url-captured",
        message: "Captured the live Surprise Items URL from the GO-created tab",
        runId: session.runId,
        taskId: expected.taskId,
        tabId: details.tabId,
        data: { url: safeUrl(initialUrl) }
      });
      return;
    }
    if (!tab) return;
    await adoptCreatedNavigationTargetLocked(session, expected, details.tabId, details.sourceTabId, tab, initialUrl);
  });
  if (capturedSurpriseNavigation) {
    await launchControlledChild(capturedSurpriseNavigation.expectedId, capturedSurpriseNavigation.url);
  }
}

async function handleCommittedNavigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): Promise<void> {
  if (details.frameId !== 0) return;
  if (details.url === "about:blank") return;

  let child: AutomationChildTab | undefined;
  let childRunId: string | undefined;
  let capturedSurpriseNavigation: { expectedId: string; url: string; tabId: number } | undefined;
  await serialized(async () => {
    const committedTab = await chrome.tabs.get(details.tabId).catch(() => undefined);
    if (await handleManualMobileNavigationLocked(details.tabId, details.url, committedTab?.openerTabId)) return;

    const session = await getAutomationSession();
    if (!session) {
      const sessions = await getSessionMap();
      const manual = sessions[String(details.tabId)];
      if (manual && manual.owner !== "automation" && details.url !== "about:blank" && !isAliExpressPageUrl(details.url)) {
        delete sessions[String(details.tabId)];
        await setSessionMap(sessions);
        if (manual.ruleId !== undefined) await removeRule(manual.ruleId);
      }
      return;
    }
    const run = await getRun();
    if (!run || run.id !== session.runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) return;

    if (classifyRoute(details.url) === "login") {
      await pauseRunLocked(run.id, "waiting_for_login", "AliExpress requested login during task navigation");
      return;
    }

    const expected = Object.values(session.expectedNavigations).find(
      (candidate) => candidate.sourceTabId === details.tabId && destinationMatchesExpected(candidate, details.url)
    );
    if (expected && details.url !== "about:blank") {
      const reason = `Task navigation replaced the source tab: ${safeUrl(details.url)}`;
      if (run.executionMode === "parallel" && details.tabId !== session.mainTabId) {
        const candidates = expectedNavigationCandidates(session, details.tabId);
        await settleNavigationCandidatesLocked(run, session, candidates.length ? candidates : [expected], reason);
        const sourceChild = session.childTabs[String(details.tabId)];
        if (sourceChild) {
          delete session.childTabs[String(details.tabId)];
          if (sourceChild.closeAlarmName) await chrome.alarms.clear(sourceChild.closeAlarmName).catch(() => false);
          if (sourceChild.readyAlarmName) await chrome.alarms.clear(sourceChild.readyAlarmName).catch(() => false);
          await setAutomationSession(session);
          const sessions = await getSessionMap();
          const owned = sessions[String(details.tabId)];
          delete sessions[String(details.tabId)];
          await setSessionMap(sessions);
          if (owned?.ruleId !== undefined) await removeRule(owned.ruleId);
          await chrome.tabs.remove(details.tabId).catch(() => undefined);
        }
      } else {
        await clearExpectedNavigationLocked(session, expected.id);
        await pauseRunLocked(run.id, "waiting_for_manual_action", reason);
      }
      await appendLog({
        level: "warn",
        event: "same-tab-navigation",
        message: run.executionMode === "parallel" && details.tabId !== session.mainTabId
          ? `Expected ${expected.taskId} child replaced its source tab; only that task was stopped`
          : `Expected ${expected.taskId} child opened in the source tab; automation paused`,
        runId: run.id,
        taskId: expected.taskId,
        tabId: details.tabId,
        data: { url: safeUrl(details.url) }
      });
      return;
    }

    const candidate = session.childTabs[String(details.tabId)];
    if (candidate) {
      child = { ...candidate };
      childRunId = run.id;
      return;
    }

    const targetTab = await chrome.tabs.get(details.tabId).catch(() => undefined);
    const sourceTabId = targetTab?.openerTabId;
    const targetExpected = sourceTabId === undefined
      ? undefined
      : expectedForCreatedNavigation(session, sourceTabId, details.url);
    if (sourceTabId !== undefined && targetExpected && targetTab) {
      if (targetExpected.taskId === "surprise_items" && destinationMatchesExpected(targetExpected, details.url)) {
        await chrome.tabs.remove(details.tabId).catch(() => undefined);
        capturedSurpriseNavigation = { expectedId: targetExpected.id, url: details.url, tabId: details.tabId };
        await appendLog({
          level: "debug",
          event: "surprise-live-url-captured",
          message: "Captured the live Surprise Items URL from the committed GO-created tab",
          runId: run.id,
          taskId: targetExpected.taskId,
          tabId: details.tabId,
          data: { url: safeUrl(details.url) }
        });
        return;
      }
      const adopted = await adoptCreatedNavigationTargetLocked(session, targetExpected, details.tabId, sourceTabId, targetTab, details.url);
      if (adopted) {
        const adoptedChild = session.childTabs[String(details.tabId)];
        if (adoptedChild) {
          child = { ...adoptedChild };
          childRunId = run.id;
          return;
        }
      }
    }
    const sourceCandidates = sourceTabId === undefined ? [] : expectedNavigationCandidates(session, sourceTabId);
    if (sourceTabId === session.mainTabId && targetTab && run.executionMode === "parallel" && sourceCandidates.length <= 1) {
      await chrome.tabs.remove(details.tabId).catch(() => undefined);
      await appendLog({
        level: "debug",
        event: "passive-child-closed",
        message: "Closed an unowned child committed by the shared passive-task batch",
        runId: run.id,
        tabId: details.tabId,
        data: { sourceTabId, url: safeUrl(details.url) }
      });
      return;
    }
    if (sourceTabId !== undefined && targetTab && !targetExpected) {
      const candidates = expectedNavigationCandidates(session, sourceTabId);
      if (candidates.length > 1) {
        await chrome.tabs.remove(details.tabId).catch(() => undefined);
        const reason = "A committed new tab could not be attributed to one task safely";
        if (run.executionMode === "parallel") {
          await settleNavigationCandidatesLocked(run, session, candidates, reason);
        } else {
          await pauseRunLocked(run.id, "waiting_for_manual_action", reason);
        }
        await appendLog({
          level: "warn",
          event: "ambiguous-child-tab",
          message: "Closed a committed new tab because multiple task navigation expectations matched",
          runId: run.id,
          tabId: details.tabId,
          data: { sourceTabId, url: safeUrl(details.url) }
        });
        return;
      }
    }

  });

  if (capturedSurpriseNavigation) {
    await launchControlledChild(capturedSurpriseNavigation.expectedId, capturedSurpriseNavigation.url);
  }
  if (child && childRunId) await handleChildCommitted(childRunId, details.tabId, details.url);
}

async function handleNavigationWatchdog(expectedId: string): Promise<void> {
  const snapshot = await serialized(async () => {
    const session = await getAutomationSession();
    const expected = session?.expectedNavigations[expectedId];
    const run = await getRun();
    if (!session || !expected || expected.id !== expectedId || !run || run.id !== expected.runId) return undefined;
    return {
      runId: run.id,
      taskId: expected.taskId,
      sourceTabId: expected.sourceTabId,
      progressBefore: run.tasks[expected.taskId].progressBefore,
      requiresChild: expectedRequiresChild(expected),
      executionMode: run.executionMode,
      directCreditGrace: expected.status === "direct-credited"
    };
  });
  if (!snapshot) return;
  if (snapshot.directCreditGrace) return;

  const drawer = await sendContentCommand(snapshot.sourceTabId, { type: "AUTOMATION_COMMAND", command: "observe-drawer" });
  if (drawer.result === "success" && drawer.taskDrawer && !snapshot.requiresChild && drawerShowsTaskCredit(drawer.taskDrawer, snapshot.taskId, snapshot.progressBefore)) {
    if (!(await claimExpectedNavigation(snapshot.runId, expectedId, snapshot.sourceTabId, true))) return;
    const row = drawer.taskDrawer.tasks.find((candidate) => candidate.groupId === TASK_CATALOG_BY_ID[snapshot.taskId].groupId);
    if (row?.completed) {
      await markTaskComplete(snapshot.runId, snapshot.taskId, {
        kind: "drawer-complete",
        detail: `${TASK_CATALOG_BY_ID[snapshot.taskId].groupId} completed while navigation was pending`,
        at: Date.now()
      });
    } else if (row?.progress) {
      await markTaskProgress(snapshot.runId, snapshot.taskId, row.progress);
    } else if (!row && taskRowDisappearsOnCompletion(TASK_CATALOG_BY_ID[snapshot.taskId])) {
      await markTaskComplete(snapshot.runId, snapshot.taskId, {
        kind: "drawer-disappeared",
        detail: `${TASK_CATALOG_BY_ID[snapshot.taskId].groupId} row disappeared after the verified click`,
        at: Date.now()
      });
    }
    recordLog({
      level: "info",
      event: "direct-task-credit",
      message: `${snapshot.taskId} credited without child navigation`,
      runId: snapshot.runId,
      taskId: snapshot.taskId,
      tabId: snapshot.sourceTabId,
      data: {
        progress: row?.progress ? `${row.progress.current}/${row.progress.total}` : null,
        completed: row?.completed ?? false
      }
    });
    if (snapshot.executionMode === "parallel") queueMainDrive(snapshot.runId);
    else {
      await delay(OPTIONAL_CHILD_CLOSE_MS);
      await processDrawer(snapshot.runId, drawer.taskDrawer);
    }
    return;
  }

  if (!(await claimExpectedNavigation(snapshot.runId, expectedId, snapshot.sourceTabId))) return;
  recordLog({
    level: "warn",
    event: "navigation-timeout",
    message: snapshot.requiresChild
      ? `No expected child navigation appeared for ${snapshot.taskId}`
      : `No direct credit or optional child navigation appeared for ${snapshot.taskId}`,
    runId: snapshot.runId,
    taskId: snapshot.taskId,
    tabId: snapshot.sourceTabId
  });
  const reason = snapshot.requiresChild
    ? `No child tab appeared for ${snapshot.taskId}`
    : `No direct credit or optional child navigation appeared for ${snapshot.taskId}`;
  await markTaskActionAccepted(snapshot.runId, snapshot.taskId, reason);
  if (await scheduleTaskRetry(snapshot.runId, snapshot.taskId, reason)) {
    if (snapshot.executionMode === "parallel") await maybeFinalizeParallelRun(snapshot.runId);
    queueMainDrive(snapshot.runId);
    return;
  }
  await markTaskWaiting(snapshot.runId, snapshot.taskId, reason);
  if (snapshot.requiresChild && snapshot.executionMode !== "parallel") {
    await pauseRun(snapshot.runId, "waiting_for_manual_action", `No child tab appeared for ${snapshot.taskId}`);
  } else if (snapshot.executionMode === "parallel") {
    await maybeFinalizeParallelRun(snapshot.runId);
    queueMainDrive(snapshot.runId);
  } else {
    queueMainDrive(snapshot.runId);
  }
}

async function handleChildReadyWatchdog(expectedId: string): Promise<void> {
  const snapshot = await serialized(async () => {
    const session = await getAutomationSession();
    const child = session ? Object.values(session.childTabs).find((candidate) => candidate.expectedId === expectedId) : undefined;
    const run = await getRun();
    if (!child || !run || run.id !== session?.runId || child.contentReady) return undefined;
    return { runId: run.id, tabId: child.tabId, taskId: child.taskId, route: child.route, executionMode: run.executionMode };
  });
  if (!snapshot) return;

  if (!(await finishTaskChild(snapshot.runId, snapshot.tabId, "retryable_error", false, true, false, true))) return;
  const reason = snapshot.route
    ? `Child tab for ${snapshot.taskId} did not become ready after reaching ${snapshot.route}`
    : `Child tab for ${snapshot.taskId} did not commit an allowlisted destination`;
  await markTaskActionAccepted(snapshot.runId, snapshot.taskId, reason);
  if (await scheduleTaskRetry(snapshot.runId, snapshot.taskId, reason)) {
    if (snapshot.executionMode === "parallel") await maybeFinalizeParallelRun(snapshot.runId);
    queueMainDrive(snapshot.runId);
    return;
  }
  if (snapshot.executionMode === "parallel") {
    await markTaskWaiting(snapshot.runId, snapshot.taskId, reason);
    await maybeFinalizeParallelRun(snapshot.runId);
    queueMainDrive(snapshot.runId);
  } else {
    await pauseRun(snapshot.runId, "waiting_for_manual_action", reason);
  }
  recordLog({
    level: "warn",
    event: "child-ready-timeout",
    message: `Child tab for ${snapshot.taskId} did not become automation-ready`,
    runId: snapshot.runId,
    taskId: snapshot.taskId,
    tabId: snapshot.tabId
  });
}

async function ensureSchedulerAlarmsLocked(settings: AutomationSettings): Promise<void> {
  const statsAlarm = await chrome.alarms.get(STATS_REFRESH_ALARM_NAME);
  if (!settings.stats.enabled) {
    if (statsAlarm) await chrome.alarms.clear(STATS_REFRESH_ALARM_NAME);
  } else if (!statsAlarm || statsAlarm.periodInMinutes !== settings.stats.refreshMinutes) {
    if (statsAlarm) await chrome.alarms.clear(STATS_REFRESH_ALARM_NAME);
    await chrome.alarms.create(STATS_REFRESH_ALARM_NAME, { delayInMinutes: settings.stats.refreshMinutes, periodInMinutes: settings.stats.refreshMinutes });
  }
  if (!settings.schedule.enabled) {
    await chrome.alarms.clear(DAILY_ALARM_NAME);
    await chrome.alarms.clear(RECONCILE_ALARM_NAME);
    return;
  }
  const daily = await chrome.alarms.get(DAILY_ALARM_NAME);
  const nextScheduled = nextLocalSchedule(settings.schedule.localTime);
  if (!daily || Math.abs(daily.scheduledTime - nextScheduled) > 1_000) {
    if (daily) await chrome.alarms.clear(DAILY_ALARM_NAME);
    await chrome.alarms.create(DAILY_ALARM_NAME, { when: nextScheduled });
  }
  const reconcile = await chrome.alarms.get(RECONCILE_ALARM_NAME);
  if (!reconcile) await chrome.alarms.create(RECONCILE_ALARM_NAME, { delayInMinutes: 15, periodInMinutes: 15 });
}

async function maybeStartCatchUpLocked(settings: AutomationSettings): Promise<void> {
  if (!settings.schedule.enabled || settings.schedule.catchUp === "never") return;
  const now = Date.now();
  const scheduledAt = todayLocalSchedule(settings.schedule.localTime);
  if (now < scheduledAt) return;
  if (settings.schedule.catchUp === "within-grace" && now > scheduledAt + settings.schedule.graceMinutes * 60_000) return;

  const run = await getRun();
  if (run && run.logicalDay === localDay(now)) return;
  if (run && !isTerminalRunState(run.state)) return;
  await startAutomationLocked("catch-up");
}

async function closeOrphanAutomationTabsLocked(): Promise<void> {
  const sessions = await getSessionMap();
  for (const session of Object.values(sessions)) {
    if (session.owner !== "automation") continue;
    delete sessions[String(session.tabId)];
    if (session.ruleId !== undefined) await removeRule(session.ruleId);
    await chrome.tabs.remove(session.tabId).catch(() => undefined);
  }
  await setSessionMap(sessions);
}

async function reconcileAutomationLocked(recoverControllers = false): Promise<void> {
  const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
  if (!run || isTerminalRunState(run.state)) {
    if (session) await closeAutomationRunLocked(session.runId);
    await closeOrphanAutomationTabsLocked();
    const lease = await getLease();
    if (lease) await setLease(undefined);
    return;
  }
  if (!session || session.runId !== run.id) {
    await updateRunLocked(run.id, (current) => {
      current.state = "interrupted";
      current.lastError = "The previous automation session was not restored";
      current.finishedAt = Date.now();
    });
    if (session) await closeAutomationRunLocked(session.runId);
    await closeAutomationRunLocked(run.id);
    await appendLog({ level: "warn", event: "run-interrupted", message: "Automation session was not available during bootstrap", runId: run.id });
    return;
  }

  const sessions = await getSessionMap();
  try {
    await chrome.tabs.get(session.mainTabId);
  } catch {
    await updateRunLocked(run.id, (current) => {
      current.state = "interrupted";
      current.lastError = "The controlled main tab no longer exists";
      current.finishedAt = Date.now();
    });
    await closeAutomationRunLocked(run.id);
    await appendLog({ level: "warn", event: "main-tab-missing", message: "Automation stopped because its main tab disappeared", runId: run.id });
    return;
  }

  let missingChild = false;
  const settings = await getSettings();
  const now = Date.now();
  for (const expected of Object.values(session.expectedNavigations)) {
    if (expected.expiresAt <= now) {
      await clearExpectedNavigationLocked(session, expected.id);
      if (expected.status === "direct-credited") continue;
      const entry = TASK_CATALOG_BY_ID[expected.taskId];
      await updateRunLocked(run.id, (current) => {
        const task = current.tasks[expected.taskId];
        task.state = taskRetriesUntilComplete(entry) ? "pending" : "waiting_for_manual_action";
        task.finishedAt = taskRetriesUntilComplete(entry) ? undefined : Date.now();
        task.error = expectedRequiresChild(expected)
          ? `No child tab appeared for ${expected.taskId}`
          : `No direct credit or optional child navigation appeared for ${expected.taskId}`;
      });
      if (!taskRetriesUntilComplete(entry) && expectedRequiresChild(expected) && run.executionMode !== "parallel") {
        await pauseRunLocked(run.id, "waiting_for_manual_action", `No child tab appeared for ${expected.taskId}`);
        return;
      }
      continue;
    }
    await chrome.alarms.create(
      `${expected.status === "direct-credited" ? OPTIONAL_NAVIGATION_GRACE_PREFIX : NAVIGATION_WATCHDOG_PREFIX}${expected.id}`,
      { when: expected.expiresAt }
    );
  }

  for (const child of Object.values(session.childTabs)) {
    try {
      await chrome.tabs.get(child.tabId);
      if (recoverControllers) child.controllerStarted = false;
      if (child.closeAlarmName && child.closeNotBefore !== undefined) {
        if (child.closeNotBefore <= now) {
          await chrome.alarms.create(child.closeAlarmName, { when: now });
          setTimeout(() => void handleChildCloseDeadline(child.expectedId), 0);
        } else if (!(await chrome.alarms.get(child.closeAlarmName))) {
          await chrome.alarms.create(child.closeAlarmName, { when: child.closeNotBefore });
        }
      }
      if (child.readyAlarmName && !child.contentReady && !(await chrome.alarms.get(child.readyAlarmName))) {
        const deadline = child.route && child.committedAt
          ? child.committedAt + settings.timeouts.pageLoadMs
          : now + settings.timeouts.childCommitMs;
        await chrome.alarms.create(child.readyAlarmName, { when: Math.max(now, deadline) });
      }
    } catch {
      delete session.childTabs[String(child.tabId)];
      delete sessions[String(child.tabId)];
      if (child.closeAlarmName) await chrome.alarms.clear(child.closeAlarmName).catch(() => false);
      if (child.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
      await updateRunLocked(run.id, (current) => {
        const task = current.tasks[child.taskId];
        task.state = taskRetriesUntilComplete(TASK_CATALOG_BY_ID[child.taskId]) ? "pending" : "failed";
        task.finishedAt = undefined;
        task.outcomeCheckNotBefore = undefined;
        task.error = "Controlled child tab disappeared during worker recovery";
      });
      await appendLog({ level: "warn", event: "child-tab-missing", message: `Child tab for ${child.taskId} disappeared during recovery`, runId: run.id, taskId: child.taskId });
      if (!taskRetriesUntilComplete(TASK_CATALOG_BY_ID[child.taskId])) missingChild = true;
    }
  }
  await setSessionMap(sessions);
  await setAutomationSession(session);
  for (const taskId of run.taskOrder) {
    const task = run.tasks[taskId];
    if (task.state !== "running" || task.outcomeCheckNotBefore === undefined) continue;
    const alarmName = `${TASK_OUTCOME_CHECK_PREFIX}${run.id}:${taskId}`;
    if (task.outcomeCheckNotBefore <= now) queueMainDrive(run.id);
    else if (!(await chrome.alarms.get(alarmName))) {
      await chrome.alarms.create(alarmName, { when: task.outcomeCheckNotBefore });
    }
  }
  if (missingChild && run.executionMode !== "parallel") {
    await pauseRunLocked(run.id, "waiting_for_manual_action", "A controlled child tab disappeared during worker recovery");
    return;
  }
  if (["waiting_for_login", "waiting_for_manual_action"].includes(run.state)) {
    await setLease(undefined);
    return;
  }
  if (!(await acquireLeaseLocked(run.id))) {
    await updateRunLocked(run.id, (current) => {
      current.state = "interrupted";
      current.lastError = "The automation lease was not restored";
      current.finishedAt = Date.now();
    });
    await closeAutomationRunLocked(run.id);
    await appendLog({ level: "warn", event: "run-interrupted", message: "The automation lease was not restored during bootstrap", runId: run.id });
    return;
  }

  for (const child of Object.values(session.childTabs)) {
    if (child.itemId && child.route === "item") {
      void finishTaskChild(run.id, child.tabId, "success", false);
      continue;
    }
    const entry = TASK_CATALOG_BY_ID[child.taskId];
    if (child.contentReady && ((entry.policy === "surprise" && child.route === "surprise-items") || (entry.policy === "quiz" && child.route === "quiz"))) {
      void startChildController(run.id, child.tabId, child.route);
    }
  }
  if (!hasMainTabAction(session) && !["waiting_for_login", "waiting_for_manual_action"].includes(run.state)) {
    scheduleMainDrive(run.id);
  }
}

async function handleChildCloseDeadline(expectedId: string): Promise<void> {
  const snapshot = await serialized(async () => {
    const session = await getAutomationSession();
    const child = session ? Object.values(session.childTabs).find((candidate) => candidate.expectedId === expectedId) : undefined;
    const run = await getRun();
    if (!child || !run || run.id !== session?.runId || isTerminalRunState(run.state) || isPausedRunState(run.state)) return undefined;
    return { child, run };
  });
  if (!snapshot) return;

  const remaining = (snapshot.child.closeNotBefore ?? 0) - Date.now();
  if (remaining > 0) {
    setTimeout(() => void handleChildCloseDeadline(expectedId), remaining);
    return;
  }

  const entry = TASK_CATALOG_BY_ID[snapshot.child.taskId];
  await finishTaskChild(snapshot.run.id, snapshot.child.tabId, entry.policy === "assisted" ? "manual_action_required" : "success", true);
  if (entry.policy !== "assisted") return;
  if (snapshot.run.executionMode === "parallel") {
    await markTaskWaiting(snapshot.run.id, snapshot.child.taskId, `${snapshot.child.taskId} requires manual game/order completion`);
    await maybeFinalizeParallelRun(snapshot.run.id);
  } else {
    await pauseRun(snapshot.run.id, "waiting_for_manual_action", `${snapshot.child.taskId} requires manual game/order completion`);
  }
}

async function handleOptionalNavigationGrace(expectedId: string): Promise<void> {
  let runId: string | undefined;
  await serialized(async () => {
    const session = await getAutomationSession();
    const expected = session?.expectedNavigations[expectedId];
    if (!session || !expected || expected.status !== "direct-credited") return;
    runId = expected.runId;
    await clearExpectedNavigationLocked(session, expectedId);
  });
  if (runId) queueMainDrive(runId);
}

async function bootstrapLocked(): Promise<void> {
  await setTrustedStorageAccess();
  await syncActionIcon();
  await syncStatsBadge((await getStatsCache())?.snapshot);
  const settings = await getSettings();
  await cleanupDiagnostics(settings);
  await ensureSchedulerAlarmsLocked(settings);
  await reconcileSessions();
  await reconcileAutomationLocked(true);
  await maybeStartCatchUpLocked(settings);
  void refreshStats().catch((error: unknown) => {
    console.warn("Initial stats refresh could not start", error);
  });
}

let bootstrapPromise: Promise<void> | undefined;

function ensureBootstrap(): Promise<void> {
  bootstrapPromise ??= serialized(bootstrapLocked).catch((error: unknown) => {
    console.error("Automation bootstrap failed", error);
  });
  return bootstrapPromise;
}

async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name === STATS_REFRESH_ALARM_NAME) {
    await refreshStats();
    return;
  }
  if (alarm.name === DAILY_ALARM_NAME) {
    await serialized(async () => {
      const settings = await getSettings();
      if (!settings.schedule.enabled) {
        await chrome.alarms.clear(DAILY_ALARM_NAME);
        return;
      }
      await chrome.alarms.create(DAILY_ALARM_NAME, { when: nextLocalSchedule(settings.schedule.localTime) });
      const existing = await getRun();
      if (existing && !isTerminalRunState(existing.state)) {
        await appendLog({ level: "debug", event: "schedule-skipped", message: `Daily schedule skipped while run is ${existing.state}`, runId: existing.id });
        return;
      }
      if (existing && existing.logicalDay === localDay()) {
        await appendLog({
          level: existing.attempt >= settings.schedule.maxAttemptsPerDay ? "warn" : "debug",
          event: "schedule-skipped",
          message: existing.attempt >= settings.schedule.maxAttemptsPerDay
            ? "Daily attempt limit reached"
            : "A run already exists for the current logical day",
          runId: existing.id
        });
        return;
      }
      await startAutomationLocked("schedule");
    });
    return;
  }
  if (alarm.name === RECONCILE_ALARM_NAME) {
    await serialized(async () => {
      await ensureSchedulerAlarmsLocked(await getSettings());
      await reconcileSessions();
      await reconcileAutomationLocked();
      await maybeStartCatchUpLocked(await getSettings());
    });
    return;
  }
  if (alarm.name.startsWith(OPTIONAL_NAVIGATION_GRACE_PREFIX)) {
    await handleOptionalNavigationGrace(alarm.name.slice(OPTIONAL_NAVIGATION_GRACE_PREFIX.length));
    return;
  }
  if (alarm.name.startsWith(CONTROLLED_CHILD_LAUNCH_PREFIX)) {
    await launchControlledChild(alarm.name.slice(CONTROLLED_CHILD_LAUNCH_PREFIX.length));
    return;
  }
  if (alarm.name.startsWith(NAVIGATION_WATCHDOG_PREFIX)) {
    await handleNavigationWatchdog(alarm.name.slice(NAVIGATION_WATCHDOG_PREFIX.length));
    return;
  }
  if (alarm.name.startsWith(CHILD_READY_WATCHDOG_PREFIX)) {
    await handleChildReadyWatchdog(alarm.name.slice(CHILD_READY_WATCHDOG_PREFIX.length));
    return;
  }
  if (alarm.name.startsWith(TASK_OUTCOME_CHECK_PREFIX)) {
    const key = alarm.name.slice(TASK_OUTCOME_CHECK_PREFIX.length);
    const separator = key.lastIndexOf(":");
    if (separator === -1) return;
    const runId = key.slice(0, separator);
    const taskId = key.slice(separator + 1) as TaskId;
    const run = await getRun();
    if (run?.id === runId && run.tasks[taskId]?.state === "running") queueMainDrive(runId);
    return;
  }
  if (alarm.name.startsWith(RETRY_ALARM_PREFIX)) {
    const previousRunId = alarm.name.slice(RETRY_ALARM_PREFIX.length);
    await chrome.alarms.clear(alarm.name).catch(() => false);
    await serialized(async () => {
      const previous = await getRun();
      if (!previous || previous.id !== previousRunId || previous.state !== "failed_retryable") return;
      const settings = await getSettings();
      if (previous.logicalDay !== localDay() || previous.attempt >= settings.schedule.maxAttemptsPerDay) {
        await appendLog({ level: "warn", event: "retry-skipped", message: "Retry skipped because its daily bound was reached", runId: previous.id });
        return;
      }
      await startAutomationLocked("retry", previous.attempt + 1);
    });
    return;
  }
  if (alarm.name.startsWith(CHILD_CLOSE_ALARM_PREFIX)) {
    await handleChildCloseDeadline(alarm.name.slice(CHILD_CLOSE_ALARM_PREFIX.length));
  }
}

async function handleAutomationTabRemoved(tabId: number): Promise<void> {
  let parallelRunId: string | undefined;
  await serialized(async () => {
    const sessions = await getSessionMap();
    const owned = sessions[String(tabId)];
    if (!owned || owned.owner !== "automation") return;
    delete sessions[String(tabId)];
    await setSessionMap(sessions);
    if (owned.ruleId !== undefined) await removeRule(owned.ruleId);

    const automationSession = await getAutomationSession();
    const run = await getRun();
    if (!automationSession || !run || automationSession.runId !== run.id) return;
    const child = automationSession.childTabs[String(tabId)];
    if (child) {
      const orphanExpectedIds = Object.values(automationSession.expectedNavigations)
        .filter((expected) => expected.sourceTabId === tabId)
        .map((expected) => expected.id);
      delete automationSession.childTabs[String(tabId)];
      await setAutomationSession(automationSession);
      for (const expectedId of orphanExpectedIds) {
        const currentSession = await getAutomationSession();
        await clearExpectedNavigationLocked(currentSession, expectedId);
      }
      if (child.closeAlarmName) await chrome.alarms.clear(child.closeAlarmName).catch(() => false);
      if (child.readyAlarmName) await chrome.alarms.clear(child.readyAlarmName).catch(() => false);
      await updateRunLocked(run.id, (current) => {
        current.tasks[child.taskId].state = "failed";
        current.tasks[child.taskId].error = "Child tab was closed before the automation closed it";
      });
       if (run.executionMode === "parallel") parallelRunId = run.id;
      else await pauseRunLocked(run.id, "waiting_for_manual_action", `Controlled child tab for ${child.taskId} was closed unexpectedly`);
      await appendLog({ level: "warn", event: "child-tab-closed-unexpectedly", message: `Child tab for ${child.taskId} was closed unexpectedly`, runId: run.id, taskId: child.taskId, tabId });
      return;
    }
    if (automationSession.mainTabId === tabId) {
      await updateRunLocked(run.id, (current) => {
        current.state = "interrupted";
        current.lastError = "Main automation tab was closed";
        current.finishedAt = Date.now();
      });
      await closeAutomationRunLocked(run.id);
      await appendLog({ level: "warn", event: "main-tab-closed", message: "Main automation tab was closed", runId: run.id, tabId });
    }
  });
  if (parallelRunId) {
    await maybeFinalizeParallelRun(parallelRunId);
    queueMainDrive(parallelRunId);
  }
}

async function stateResponse(): Promise<Phase0Response> {
  const [sessions, reports, settings, run, logs, automationSession, statsCache] = await Promise.all([
    getSessionMap(),
    getReports(),
    getSettings(),
    getRun(),
    getLogs(),
    getAutomationSession(),
    getStatsCache()
  ]);
  let automationSessionActive = Boolean(run && automationSession?.runId === run.id);
  if (automationSessionActive && automationSession) {
    try {
      await chrome.tabs.get(automationSession.mainTabId);
    } catch {
      automationSessionActive = false;
    }
  }
  const diagnostics = buildDiagnostics(run, reports, logs, statsCache?.snapshot);
  return {
    ok: true,
    sessions: Object.values(sessions),
    reports,
    settings,
    run,
    logs,
    automationSessionActive,
    stats: statsCache?.snapshot,
    statsRefreshing: statsRefreshCoalescer.isActive(),
    diagnostics
  };
}

async function viewAutomationTab(): Promise<Phase0Response> {
  const session = await getAutomationSession();
  if (!session) return { ok: false, error: "No automation tab is available" };
  try {
    await chrome.tabs.update(session.mainTabId, { active: true });
    if (session.mainWindowId !== undefined) await chrome.windows.update(session.mainWindowId, { focused: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "The automation tab is no longer available" };
  }
}

async function clearStatsHistory(): Promise<Phase0Response> {
  await setStatsHistoryCache(undefined);
  const cache = await getStatsCache();
  if (cache) {
    await setStatsCache({
      ...cache,
      snapshot: { ...cache.snapshot, history: [] }
    });
  }
  return stateResponse();
}

async function clearDiagnostics(): Promise<Phase0Response> {
  await chrome.storage.local.remove([PHASE0_REPORTS_KEY, AUTOMATION_LOGS_KEY]);
  return stateResponse();
}

async function handleMessage(message: Phase0Message, sender: chrome.runtime.MessageSender): Promise<Phase0Response> {
  if (message.type === "PHASE0_OPEN_MOBILE") {
    return { ok: true, session: await openMobileSession() };
  }

  if (message.type === "PHASE0_OPEN_URL") {
    return { ok: true, session: await openProbeSession(message.url, message.mobile, message.compact) };
  }

  if (message.type === "PHASE0_CLOSE_MOBILE") {
    await closeMobileSessions(message.tabId);
    return { ok: true };
  }

  if (message.type === "PHASE0_GET_STATE") return stateResponse();

  if (message.type === "STATS_GET_STATE") return stateResponse();
  if (message.type === "STATS_REFRESH") {
    await refreshStats(message.force === true);
    return stateResponse();
  }

  if (message.type === "AUTOMATION_START") return startAutomationLocked(message.trigger ?? "manual");
  if (message.type === "AUTOMATION_STOP") return stopAutomationLocked();
  if (message.type === "AUTOMATION_RESUME") return resumeAutomationLocked();
  if (message.type === "AUTOMATION_VIEW_TAB") return viewAutomationTab();
  if (message.type === "AUTOMATION_GET_STATE") return stateResponse();
  if (message.type === "STATS_CLEAR_HISTORY") return clearStatsHistory();
  if (message.type === "DIAGNOSTICS_CLEAR") return clearDiagnostics();
  if (message.type === "DIAGNOSTICS_EXPORT") {
    const response = await stateResponse();
    return response.diagnostics ? { ...response, diagnosticsExport: diagnosticsJson(response.diagnostics) } : response;
  }
  if (message.type === "AUTOMATION_SAVE_SETTINGS") {
    const settings = await setSettings(message.settings);
    await ensureSchedulerAlarmsLocked(settings);
    await appendLog({
      level: "info",
      event: "settings-saved",
      message: "Automation settings saved",
      data: { scheduled: settings.schedule.enabled, executionMode: settings.automation.executionMode }
    });
    return { ok: true, settings };
  }
  if (message.type === "AUTOMATION_CLEAR_LOGS") {
    await chrome.storage.local.remove(AUTOMATION_LOGS_KEY);
    return { ok: true, logs: [] };
  }

  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false, error: "No sender tab" };
  const sessions = await getSessionMap();
  const ownedSession = sessions[String(tabId)];
  const owned = Boolean(ownedSession);

  if (message.type === "PHASE0_CONTENT_READY") {
    scheduleStatsRefresh(tabId, message.url);
    if (owned && ownedSession?.owner === "automation" && ownedSession.runId) {
      void handleAutomationContentReady(tabId, message.route, message.url);
    }
    return { ok: true, owned };
  }
  if (message.type === "PHASE0_REPORT") {
    if (!owned) return { ok: false, error: "Unowned tab" };
    await storeReport(message.report, tabId);
    return { ok: true, owned: true };
  }
  if (message.type === "AUTOMATION_ARM_NAVIGATION") {
    if (ownedSession?.owner !== "automation" || !ownedSession.runId) return { ok: false, error: "Unowned automation tab" };
    return armNavigationLocked(ownedSession.runId, tabId, message.taskId, message.itemId);
  }
  if (message.type === "AUTOMATION_DISARM_NAVIGATION") {
    if (ownedSession?.owner !== "automation" || !ownedSession.runId) return { ok: false, error: "Unowned automation tab" };
    const session = await getAutomationSession();
    if (session?.runId === ownedSession.runId && session.expectedNavigations[message.expectedId]) {
      await clearExpectedNavigationLocked(session, message.expectedId);
    }
    return { ok: true };
  }
  if (message.type === "AUTOMATION_SURPRISE_TRUSTED_CLICK") {
    if (ownedSession?.owner !== "automation" || !ownedSession.runId) return { ok: false, error: "Unowned automation tab" };
    const [run, automationSession] = await Promise.all([getRun(), getAutomationSession()]);
    const child = automationSession?.runId === ownedSession.runId ? automationSession.childTabs[String(tabId)] : undefined;
    if (!run || run.id !== ownedSession.runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || child?.taskId !== "surprise_items" || run.tasks.surprise_items.state !== "running") {
      return { ok: false, error: "Surprise trusted click is not part of the active run" };
    }
    if (![message.x, message.y].every((value) => Number.isFinite(value)) || message.x < 0 || message.y < 0 || message.x > 10_000 || message.y > 10_000) {
      return { ok: false, error: "Surprise click coordinates were invalid" };
    }

    const target = { tabId };
    let attached = false;
    try {
      await new Promise<void>((resolve, reject) => {
        chrome.debugger.attach(target, "1.3", () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
      attached = true;
      const dispatch = (params: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", params, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
      await dispatch({ type: "mouseMoved", x: message.x, y: message.y });
      await dispatch({ type: "mousePressed", x: message.x, y: message.y, button: "left", clickCount: 1 });
      await delay(80);
      await dispatch({ type: "mouseReleased", x: message.x, y: message.y, button: "left", clickCount: 1 });
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendLog({
        level: "error",
        event: "surprise-cdp-click-failed",
        message: `Trusted mouse click failed for ${message.itemId}: ${detail}`,
        runId: run.id,
        taskId: "surprise_items",
        tabId
      });
      return { ok: false, error: detail };
    } finally {
      if (attached) {
        await new Promise<void>((resolve) => {
          chrome.debugger.detach(target, () => resolve());
        });
      }
    }
  }
  if (message.type === "AUTOMATION_SURPRISE_CARD_ACCEPTED") {
    if (ownedSession?.owner !== "automation" || !ownedSession.runId) return { ok: false, error: "Unowned automation tab" };
    const [run, session] = await Promise.all([getRun(), getAutomationSession()]);
    const child = session?.runId === ownedSession.runId ? session.childTabs[String(tabId)] : undefined;
    if (!run || run.id !== ownedSession.runId || isTerminalRunState(run.state) || isPausedRunState(run.state) || child?.taskId !== "surprise_items" || run.tasks.surprise_items.state !== "running") {
      return { ok: false, error: "Surprise card is not part of the active run" };
    }
    await updateRunLocked(run.id, (current) => {
      const selected = current.tasks.surprise_items.selectedItemIds;
      if (!selected.includes(message.itemId)) selected.push(message.itemId);
    });
    return { ok: true };
  }
  return { ok: false, error: "Unsupported message" };
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureBootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureBootstrap();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-mobile-probe") return;
  void (async () => {
    await ensureBootstrap();
    await serialized(() => openMobileSession());
  })().catch((error: unknown) => {
    console.error("Could not open the mobile probe from the keyboard shortcut", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[POPUP_THEME_KEY]) return;
  void syncActionIcon(changes[POPUP_THEME_KEY].newValue);
});

chrome.runtime.onMessage.addListener((message: Phase0Message, sender, sendResponse) => {
  void ensureBootstrap()
    .then(() => serialized(() => handleMessage(message, sender)))
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleAutomationTabRemoved(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleCreatedTab(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) void handleUpdatedChildTab(tabId, changeInfo.url, tab.openerTabId);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void handleCreatedNavigationTarget(details);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  void handleCommittedNavigation(details);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm);
});

// MV3 workers can be recreated between navigation events. Reconcile persisted
// ownership and alarms whenever this worker instance is initialized.
void ensureBootstrap();
