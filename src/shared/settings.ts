import { DEFAULT_ENABLED_TASK_IDS, TASK_CATALOG, TASK_CATALOG_BY_ID } from "./task-catalog";
import type { AutomationSettings, TaskId } from "./types";

export const DEFAULT_SETTINGS: AutomationSettings = {
  schemaVersion: 5,
  schedule: {
    enabled: false,
    localTime: "09:00",
    catchUp: "same-day",
    graceMinutes: 240,
    retryDelaysMinutes: [5, 15, 60, 180],
    maxAttemptsPerDay: 5
  },
  automation: {
    enabledTaskIds: [...DEFAULT_ENABLED_TASK_IDS],
    executionMode: "parallel",
    compactWindow: true,
    focusManualRuns: true,
    focusScheduledRuns: false,
    stopOnUnknownTaskState: true
  },
  stats: {
    enabled: true,
    refreshMinutes: 5
  },
  notifications: {
    enabled: true,
    loginRequired: true,
    runCompleted: true,
    partialRun: true,
    failures: true
  },
  privacy: {
    historyRetentionMonths: 6,
    diagnosticsRetentionDays: 30
  },
  timeouts: {
    pageLoadMs: 30_000,
    childCommitMs: 20_000,
    passiveDwellMs: 15_000,
    assistedDwellMs: 5 * 60_000
  }
};

const TASK_IDS = new Set(Object.keys(TASK_CATALOG_BY_ID) as TaskId[]);

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function validTaskIds(value: unknown): TaskId[] {
  if (!Array.isArray(value)) return [...DEFAULT_ENABLED_TASK_IDS];
  const enabled = new Set(value.filter((id): id is TaskId => typeof id === "string" && TASK_IDS.has(id as TaskId)));
  return TASK_CATALOG.map((task) => task.id).filter((id) => enabled.has(id));
}

function validLocalTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/u.test(value)) return DEFAULT_SETTINGS.schedule.localTime;
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) return DEFAULT_SETTINGS.schedule.localTime;
  return value;
}

export function normalizeSettings(raw: unknown): AutomationSettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<AutomationSettings>;
  const storedSchemaVersion = typeof value.schemaVersion === "number" ? value.schemaVersion : 0;
  const schedule = (value.schedule ?? {}) as Partial<AutomationSettings["schedule"]>;
  const automation = (value.automation ?? {}) as Partial<AutomationSettings["automation"]>;
  const stats = (value.stats ?? {}) as Partial<AutomationSettings["stats"]>;
  const notifications = (value.notifications ?? {}) as Partial<AutomationSettings["notifications"]>;
  const privacy = (value.privacy ?? {}) as Partial<AutomationSettings["privacy"]>;
  const timeouts = (value.timeouts ?? {}) as Partial<AutomationSettings["timeouts"]>;
  const enabledTaskIds = validTaskIds(automation.enabledTaskIds);
  if (storedSchemaVersion < DEFAULT_SETTINGS.schemaVersion && Array.isArray(automation.enabledTaskIds) && enabledTaskIds.length > 0 && !enabledTaskIds.includes("daily_checkin")) {
    enabledTaskIds.unshift("daily_checkin");
  }
  const catchUp = schedule.catchUp === "within-grace" || schedule.catchUp === "never" ? schedule.catchUp : "same-day";
  const retryDelays = Array.isArray(schedule.retryDelaysMinutes)
    ? schedule.retryDelaysMinutes
        .filter((delay): delay is number => typeof delay === "number" && Number.isFinite(delay))
        .map((delay) => boundedNumber(delay, 5, 1, 24 * 60))
        .slice(0, 8)
    : [...DEFAULT_SETTINGS.schedule.retryDelaysMinutes];

  return {
    schemaVersion: 5,
    schedule: {
      enabled: schedule.enabled === true,
      localTime: validLocalTime(schedule.localTime),
      catchUp,
      graceMinutes: boundedNumber(schedule.graceMinutes, DEFAULT_SETTINGS.schedule.graceMinutes, 0, 24 * 60),
      retryDelaysMinutes: retryDelays.length ? retryDelays : [...DEFAULT_SETTINGS.schedule.retryDelaysMinutes],
      maxAttemptsPerDay: boundedNumber(schedule.maxAttemptsPerDay, DEFAULT_SETTINGS.schedule.maxAttemptsPerDay, 1, 10)
    },
    automation: {
      enabledTaskIds,
      executionMode: automation.executionMode === "sequential" ? "sequential" : "parallel",
      compactWindow: automation.compactWindow !== false,
      focusManualRuns: automation.focusManualRuns !== false,
      focusScheduledRuns: automation.focusScheduledRuns === true,
      stopOnUnknownTaskState: automation.stopOnUnknownTaskState !== false
    },
    stats: {
      enabled: stats.enabled !== false,
      refreshMinutes: boundedNumber(stats.refreshMinutes, DEFAULT_SETTINGS.stats.refreshMinutes, 5, 60)
    },
    notifications: {
      enabled: notifications.enabled !== false,
      loginRequired: notifications.loginRequired !== false,
      runCompleted: notifications.runCompleted !== false,
      partialRun: notifications.partialRun !== false,
      failures: notifications.failures !== false
    },
    privacy: {
      historyRetentionMonths: boundedNumber(
        privacy.historyRetentionMonths,
        DEFAULT_SETTINGS.privacy.historyRetentionMonths,
        1,
        6
      ),
      diagnosticsRetentionDays: boundedNumber(
        privacy.diagnosticsRetentionDays,
        DEFAULT_SETTINGS.privacy.diagnosticsRetentionDays,
        1,
        365
      )
    },
    timeouts: {
      pageLoadMs: boundedNumber(timeouts.pageLoadMs, DEFAULT_SETTINGS.timeouts.pageLoadMs, 5_000, 120_000),
      childCommitMs: boundedNumber(timeouts.childCommitMs, DEFAULT_SETTINGS.timeouts.childCommitMs, 5_000, 120_000),
      passiveDwellMs: boundedNumber(timeouts.passiveDwellMs, DEFAULT_SETTINGS.timeouts.passiveDwellMs, 15_000, 10 * 60_000),
      assistedDwellMs: boundedNumber(timeouts.assistedDwellMs, DEFAULT_SETTINGS.timeouts.assistedDwellMs, 5 * 60_000, 60 * 60_000)
    }
  };
}
