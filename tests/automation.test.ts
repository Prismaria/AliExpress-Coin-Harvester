import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_TASK_IDS,
  TASK_CATALOG_BY_ID,
  mostAdvancedTaskProgress,
  taskActionAttemptLimit,
  taskChildDwellMs,
  taskClicksRemaining,
  taskDestinationMatters,
  taskDestinationMatches,
  taskOutcomeWaitMs,
  taskRowDisappearsOnCompletion,
  taskRetriesUntilComplete,
  taskForGroupId,
  taskRequiresChildNavigation
} from "../src/shared/task-catalog";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";
import { cacheStatsSnapshot, createRefreshCoalescer, formatCoinBadge, isStatsCacheFresh, STATS_CACHE_TTL_MS } from "../src/shared/stats-cache";
import { historyDateKey, mergeHistory, retainHistory } from "../src/shared/stats-history";
import type { StatsSnapshot } from "../src/shared/types";
import type { AutomationRun } from "../src/shared/types";
import { notificationForRun } from "../src/shared/notifications";
import { buildDiagnostics, diagnosticsJson } from "../src/shared/diagnostics";
import type { AutomationLogEntry, Phase0Report } from "../src/shared/types";

function statsSnapshot(accountState: StatsSnapshot["accountState"] = "authenticated"): StatsSnapshot {
  return {
    accountState,
    coinCountRaw: "729",
    currentSavingsRaw: "C$10.37",
    lifetimeSavingsRaw: "Coins have saved C$325.58",
    history: [],
    source: { kind: "controlled-tab", url: "https://www.aliexpress.com/p/coin-pc-index/mycoin.html", observedAt: 100 },
    stale: false,
    warnings: []
  };
}

function runWithState(state: AutomationRun["state"]): AutomationRun {
  return {
    id: "run-1",
    trigger: "manual",
    logicalDay: "2026-09-17",
    state,
    attempt: 1,
    executionMode: "sequential",
    createdAt: 1,
    updatedAt: 1,
    taskOrder: [],
    tasks: {} as AutomationRun["tasks"],
    selectorContractVersion: 1,
    lastError: state.startsWith("failed") ? "A controlled tab failed" : undefined
  };
}

describe("automation policy", () => {
  it("enables verified task flows but leaves assisted game flows disabled", () => {
    expect(DEFAULT_ENABLED_TASK_IDS).toContain("surprise_items");
    expect(DEFAULT_ENABLED_TASK_IDS).toContain("daily_quiz");
    expect(DEFAULT_ENABLED_TASK_IDS).not.toContain("prize_land");
    expect(DEFAULT_ENABLED_TASK_IDS).not.toContain("merge_boss");
  });

  it("maps group IDs and validates explicit destinations", () => {
    expect(taskForGroupId("548001")?.id).toBe("daily_checkin");
    expect(taskForGroupId("554001")?.id).toBe("super_discounts");
    expect(taskDestinationMatches(TASK_CATALOG_BY_ID.super_discounts, "https://www.aliexpress.com/ssr/300000949/gamecenterpc?task=redacted")).toBe(true);
    expect(taskDestinationMatches(TASK_CATALOG_BY_ID.super_discounts, "https://m.aliexpress.com/p/coin-index/hotsale.html")).toBe(true);
    expect(taskDestinationMatches(TASK_CATALOG_BY_ID.super_discounts, "https://www.aliexpress.com/checkout/index.html")).toBe(false);
  });

  it("only requires child navigation for the named new-tab workflows", () => {
    expect(TASK_CATALOG_BY_ID.daily_checkin.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.daily_quiz.navigation).toBe("required-child");
    expect(TASK_CATALOG_BY_ID.merge_boss.navigation).toBe("required-child");
    expect(TASK_CATALOG_BY_ID.prize_land.navigation).toBe("required-child");
    expect(TASK_CATALOG_BY_ID.surprise_items.navigation).toBe("required-child");
    expect(TASK_CATALOG_BY_ID.sponsored_items.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.recently_viewed.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.savings_recap.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.super_discounts.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.coin_search.navigation).toBe("optional-child");
    expect(TASK_CATALOG_BY_ID.coupons_credits.navigation).toBe("optional-child");
    expect(taskRequiresChildNavigation(TASK_CATALOG_BY_ID.sponsored_items)).toBe(false);
    expect(taskDestinationMatters(TASK_CATALOG_BY_ID.sponsored_items)).toBe(false);
    expect(taskDestinationMatters(TASK_CATALOG_BY_ID.daily_quiz)).toBe(true);
    expect(taskDestinationMatters(TASK_CATALOG_BY_ID.surprise_items)).toBe(true);
    expect(taskRequiresChildNavigation(TASK_CATALOG_BY_ID.surprise_items)).toBe(true);
    expect(taskRequiresChildNavigation(TASK_CATALOG_BY_ID.surprise_items, "123")).toBe(true);
    expect(taskRequiresChildNavigation(TASK_CATALOG_BY_ID.sponsored_items, "123")).toBe(false);
    expect(TASK_CATALOG_BY_ID.sponsored_items.drawerClickCount).toBe(2);
    expect(TASK_CATALOG_BY_ID.super_discounts.drawerClickCount).toBe(3);
    expect(TASK_CATALOG_BY_ID.super_discounts.requiresMobileIdentity).toBe(true);
    expect(taskRowDisappearsOnCompletion(TASK_CATALOG_BY_ID.daily_checkin)).toBe(true);
    expect(taskRowDisappearsOnCompletion(TASK_CATALOG_BY_ID.sponsored_items)).toBe(false);
    expect(TASK_CATALOG_BY_ID.surprise_items.launchUrl).toBeUndefined();
    expect(taskDestinationMatches(
      TASK_CATALOG_BY_ID.surprise_items,
      "https://m.aliexpress.com/p/coin-index/adclick.html?componentType=productClick&taskId=1722001&taskInstanceId=776145032406&_target=blank"
    )).toBe(true);
    expect(TASK_CATALOG_BY_ID.daily_quiz.launchUrl).toBe("https://m.aliexpress.com/p/coin-index/coinquest.html");
    expect(TASK_CATALOG_BY_ID.prize_land.launchUrl).toBe("https://m.aliexpress.com/ssr/300000949/farmpc");
    expect(TASK_CATALOG_BY_ID.merge_boss.launchUrl).toBe("https://m.aliexpress.com/p/merge-market/index.html");
  });

  it("plans repeated drawer work with an aggressive retry budget", () => {
    expect(taskClicksRemaining(TASK_CATALOG_BY_ID.sponsored_items, { current: 1, total: 2 })).toBe(1);
    expect(taskClicksRemaining(TASK_CATALOG_BY_ID.super_discounts, { current: 0, total: 3 })).toBe(3);
    expect(taskClicksRemaining(TASK_CATALOG_BY_ID.super_discounts, { current: 2, total: 3 })).toBe(1);
    expect(taskActionAttemptLimit(TASK_CATALOG_BY_ID.sponsored_items)).toBe(5);
    expect(taskActionAttemptLimit(TASK_CATALOG_BY_ID.recently_viewed)).toBe(4);
    expect(taskActionAttemptLimit(TASK_CATALOG_BY_ID.super_discounts)).toBe(6);
    expect(taskActionAttemptLimit(TASK_CATALOG_BY_ID.surprise_items)).toBe(5);
    expect(taskActionAttemptLimit(TASK_CATALOG_BY_ID.daily_quiz)).toBe(4);
    expect(taskOutcomeWaitMs(TASK_CATALOG_BY_ID.daily_checkin)).toBe(5_000);
    expect(taskOutcomeWaitMs(TASK_CATALOG_BY_ID.sponsored_items)).toBe(5_000);
    expect(taskOutcomeWaitMs(TASK_CATALOG_BY_ID.daily_quiz)).toBe(20_000);
    expect(taskOutcomeWaitMs(TASK_CATALOG_BY_ID.surprise_items, "123")).toBe(20_000);
    expect(taskRetriesUntilComplete(TASK_CATALOG_BY_ID.sponsored_items)).toBe(true);
    expect(taskRetriesUntilComplete(TASK_CATALOG_BY_ID.recently_viewed)).toBe(true);
    expect(taskRetriesUntilComplete(TASK_CATALOG_BY_ID.super_discounts)).toBe(true);
    expect(taskRetriesUntilComplete(TASK_CATALOG_BY_ID.daily_quiz)).toBe(false);
    expect(taskChildDwellMs(TASK_CATALOG_BY_ID.sponsored_items, 15_000, 300_000)).toBe(15_000);
    expect(taskChildDwellMs(TASK_CATALOG_BY_ID.recently_viewed, 15_000, 300_000)).toBe(15_000);
    expect(taskChildDwellMs(TASK_CATALOG_BY_ID.super_discounts, 15_000, 300_000)).toBe(15_000);
    expect(taskChildDwellMs(TASK_CATALOG_BY_ID.coin_search, 15_000, 300_000)).toBe(1_000);
  });

  it("does not let stale drawer progress override newer observed progress", () => {
    expect(mostAdvancedTaskProgress({ current: 0, total: 2 }, { current: 1, total: 2 })).toEqual({ current: 1, total: 2 });
  });

  it("normalizes corrupted settings without enabling the schedule", () => {
    const settings = normalizeSettings({
      schedule: { enabled: "yes", localTime: "99:99", maxAttemptsPerDay: 999 },
      automation: { enabledTaskIds: ["daily_quiz", "not-a-task"] },
      timeouts: { passiveDwellMs: 1 }
    });
    expect(settings.schedule.enabled).toBe(false);
    expect(settings.schedule.localTime).toBe(DEFAULT_SETTINGS.schedule.localTime);
    expect(settings.schedule.maxAttemptsPerDay).toBe(10);
    expect(settings.automation.enabledTaskIds).toEqual(["daily_checkin", "daily_quiz"]);
    expect(settings.automation.executionMode).toBe("parallel");
    expect(settings.timeouts.passiveDwellMs).toBe(15_000);
  });

  it("adds the daily check-in task when upgrading an older task list", () => {
    const settings = normalizeSettings({
      schemaVersion: 2,
      automation: { enabledTaskIds: ["sponsored_items"] }
    });
    expect(settings.schemaVersion).toBe(5);
    expect(settings.automation.enabledTaskIds).toContain("daily_checkin");
    expect(normalizeSettings({
      schemaVersion: 5,
      automation: { enabledTaskIds: ["sponsored_items"] }
    }).automation.enabledTaskIds).not.toContain("daily_checkin");
  });

  it("preserves the explicit sequential execution setting", () => {
    expect(normalizeSettings({ automation: { executionMode: "sequential" } }).automation.executionMode).toBe("sequential");
    expect(DEFAULT_SETTINGS.automation.executionMode).toBe("parallel");
  });

  it("defaults stats refresh to an enabled five-minute schedule", () => {
    expect(DEFAULT_SETTINGS.stats).toEqual({ enabled: true, refreshMinutes: 5 });
    expect(normalizeSettings({ stats: { enabled: false, refreshMinutes: 1 } }).stats).toEqual({
      enabled: false,
      refreshMinutes: 5
    });
  });

  it("keeps authenticated stats fresh for five minutes", () => {
    const cache = cacheStatsSnapshot(undefined, statsSnapshot(), 1_000);
    expect(isStatsCacheFresh(cache, 1_000 + STATS_CACHE_TTL_MS - 1)).toBe(true);
    expect(isStatsCacheFresh(cache, 1_000 + STATS_CACHE_TTL_MS)).toBe(false);
  });

  it("formats the coin balance for the compact toolbar badge", () => {
    expect(formatCoinBadge("729")).toBe("729");
    expect(formatCoinBadge("12,345")).toBe("12k");
    expect(formatCoinBadge("1,234,567")).toBe("1.2M");
    expect(formatCoinBadge("not-a-number")).toBe("");
  });

  it("preserves the last values when a refresh becomes logged out", () => {
    const authenticated = cacheStatsSnapshot(undefined, statsSnapshot(), 1_000);
    const loggedOut = cacheStatsSnapshot(authenticated, {
      ...statsSnapshot("logged-out"),
      coinCountRaw: undefined,
      currentSavingsRaw: undefined,
      lifetimeSavingsRaw: undefined,
      history: [],
      source: { kind: "controlled-tab", url: "https://www.aliexpress.com/p/ug-login-page/login.html", observedAt: 2_000 },
      stale: false
    }, 2_000);
    expect(loggedOut.snapshot).toMatchObject({
      accountState: "logged-out",
      coinCountRaw: "729",
      currentSavingsRaw: "C$10.37",
      lifetimeSavingsRaw: "Coins have saved C$325.58",
      stale: true
    });
    expect(loggedOut.fetchedAt).toBe(1_000);
  });

  it("coalesces concurrent refresh operations and releases after completion", async () => {
    const coalescer = createRefreshCoalescer<number>();
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = coalescer.run(async () => {
      calls += 1;
      await pending;
      return 42;
    });
    const second = coalescer.run(async () => {
      calls += 1;
      return 7;
    });
    expect(first).toBe(second);
    expect(coalescer.isActive()).toBe(true);
    release();
    await expect(first).resolves.toBe(42);
    expect(calls).toBe(1);
    expect(coalescer.isActive()).toBe(false);
    await expect(coalescer.run(async () => 7)).resolves.toBe(7);
  });

  it("normalizes history dates and retains only six months of unique entries", () => {
    expect(historyDateKey("9/17/2026 PT")).toBe("2026-09-17");
    expect(historyDateKey("2026-03-16")).toBe("2026-03-16");
    expect(historyDateKey("not a date")).toBeUndefined();

    const entries = [
      { id: "new", category: "earned" as const, dateLabel: "9/17/2026 PT", title: "New", amountRaw: "+1" },
      { id: "cutoff", category: "earned" as const, dateLabel: "3/17/2026 PT", title: "Cutoff", amountRaw: "+2" },
      { id: "old", category: "earned" as const, dateLabel: "3/16/2026 PT", title: "Old", amountRaw: "+3" },
      { id: "undated", category: "unknown" as const, title: "Unknown", amountRaw: "+4" }
    ];
    expect(retainHistory(entries, new Date("2026-09-17T12:00:00Z").getTime())).toEqual([
      { ...entries[0], dateKey: "2026-09-17" },
      { ...entries[1], dateKey: "2026-03-17" }
    ]);
    expect(mergeHistory(entries.slice(0, 2), [entries[0]], new Date("2026-09-17T12:00:00Z").getTime())).toHaveLength(2);
    expect(retainHistory(entries, new Date("2026-09-17T12:00:00Z").getTime(), 1)).toEqual([
      { ...entries[0], dateKey: "2026-09-17" }
    ]);
  });

  it("respects notification preferences for terminal and login states", () => {
    expect(notificationForRun(runWithState("waiting_for_login"), DEFAULT_SETTINGS)?.title).toContain("login");
    expect(notificationForRun(runWithState("succeeded"), DEFAULT_SETTINGS)?.title).toContain("complete");
    expect(notificationForRun(runWithState("partially_succeeded"), DEFAULT_SETTINGS)?.title).toContain("partially");
    expect(notificationForRun(runWithState("failed_terminal"), DEFAULT_SETTINGS)?.title).toContain("failed");
    expect(notificationForRun(runWithState("succeeded"), {
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false }
    })).toBeUndefined();
  });

  it("exports redacted diagnostics and reports selector mismatches", () => {
    const report: Phase0Report = {
      at: 2_000,
      tabId: 42,
      url: "https://www.aliexpress.com/p/coin-pc-index/mycoin.html?token=private",
      route: "stats",
      page: { readyState: "complete", bodyTextLength: 10, rootFound: true, signButtonFound: false },
      environment: {
        navigatorUserAgent: "not exported",
        innerWidth: 390,
        innerHeight: 700,
        devicePixelRatio: 1,
        maxTouchPoints: 0,
        hasTouchEvent: false
      },
      stats: { found: false, historyEntryCount: 0 },
      overlays: []
    };
    const log: AutomationLogEntry = {
      at: 2_001,
      level: "error",
      event: "stats-failed",
      message: "Request https://www.aliexpress.com/private?token=private failed for user@example.com",
      data: { token: "private", url: "https://www.aliexpress.com/private?secret=private" }
    };
    const diagnostics = buildDiagnostics(undefined, [report], [log], undefined, 3_000);
    const json = diagnosticsJson(diagnostics);
    expect(diagnostics.selectorMismatches).toMatchObject([
      { route: "stats", contract: "stats-fields" }
    ]);
    expect(json).not.toContain("token=private");
    expect(json).not.toContain("user@example.com");
    expect(json).toContain("[redacted]");
    expect(diagnostics.reports[0].url).toBe("https://www.aliexpress.com/p/coin-pc-index/mycoin.html");
    expect(diagnostics.reports[0].tabId).toBe(42);
    expect(diagnostics.reports[0].environment.innerWidth).toBe(390);
  });

  it("prefers the controlled main-tab report over a newer unrelated report", () => {
    const controlled: Phase0Report = {
      at: 1_000,
      tabId: 42,
      url: "https://m.aliexpress.com/p/coin-index/index.html",
      route: "coin-index",
      page: { readyState: "complete", bodyTextLength: 100, rootFound: true, signButtonFound: true },
      environment: {
        navigatorUserAgent: "mobile",
        innerWidth: 430,
        innerHeight: 860,
        devicePixelRatio: 1,
        maxTouchPoints: 5,
        hasTouchEvent: true
      },
      coinIndex: {
        rootFound: true,
        loginButtonFound: false,
        buttonFound: true,
        buttonVisible: true,
        buttonHasGeometry: true,
        buttonText: "Collect",
        buttonDisabled: false,
        currentCardClasses: "",
        state: "collectable"
      },
      taskDrawer: { found: false, rowCount: 0, tasks: [] },
      overlays: []
    };
    const unrelated = {
      ...controlled,
      at: 2_000,
      tabId: 99,
      page: { ...controlled.page, signButtonFound: false }
    };
    const diagnostics = buildDiagnostics({ ...runWithState("interrupted"), mainTabId: 42 }, [controlled, unrelated], [], undefined, 3_000);
    expect(diagnostics.selectorMismatches).toEqual([]);
    expect(diagnostics.reports.find((report) => report.tabId === 42)?.tabId).toBe(42);
  });
});
