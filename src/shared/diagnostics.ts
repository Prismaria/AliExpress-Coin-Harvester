import { safeUrl } from "./routes";
import type {
  AutomationLogEntry,
  AutomationRun,
  CoinIndexObservation,
  DiagnosticsSnapshot,
  Phase0Report,
  StatsObservation,
  StatsSnapshot,
  TaskDrawerObservation
} from "./types";

function redactText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/giu, (url) => safeUrl(url))
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\b(?:token|secret|password|authorization|cookie)\s*[=:]\s*[^,;\s]+/giu, "$1=[redacted]");
}

function redactData(data: Record<string, string | number | boolean | null> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!data) return undefined;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => {
    if (/(?:token|secret|password|authorization|cookie)/iu.test(key)) return [key, "[redacted]"];
    if (typeof value === "string") return [key, redactText(value)];
    return [key, value];
  }));
}

function diagnosticTask(run: AutomationRun, taskId: AutomationRun["taskOrder"][number]) {
  const task = run.tasks[taskId];
  return {
    id: task.id,
    state: task.state,
    attempts: task.attempts,
    attemptsRemaining: task.attemptsRemaining,
    optimisticProgress: task.optimisticProgress,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    navigationMode: task.navigationMode,
    completionEvidence: task.completionEvidence
      ? { ...task.completionEvidence, detail: redactText(task.completionEvidence.detail) }
      : undefined,
    error: task.error ? redactText(task.error) : undefined
  };
}

function reportSummary(report: Phase0Report): DiagnosticsSnapshot["reports"][number] {
  const coinIndex: Pick<CoinIndexObservation, "state" | "buttonText" | "buttonDisabled" | "buttonVisible" | "buttonHasGeometry"> | undefined = report.coinIndex
    ? {
        state: report.coinIndex.state,
        buttonText: report.coinIndex.buttonText,
        buttonDisabled: report.coinIndex.buttonDisabled,
        buttonVisible: report.coinIndex.buttonVisible,
        buttonHasGeometry: report.coinIndex.buttonHasGeometry
      }
    : undefined;
  const taskDrawer: Pick<TaskDrawerObservation, "found" | "rowCount"> | undefined = report.taskDrawer
    ? { found: report.taskDrawer.found, rowCount: report.taskDrawer.rowCount }
    : undefined;
  const stats: Pick<StatsObservation, "found" | "historyEntryCount"> | undefined = report.stats
    ? { found: report.stats.found, historyEntryCount: report.stats.historyEntryCount }
    : undefined;
  return {
    at: report.at,
    tabId: report.tabId,
    url: safeUrl(report.url),
    route: report.route,
    page: {
      readyState: report.page.readyState,
      bodyTextLength: report.page.bodyTextLength,
      rootFound: report.page.rootFound,
      signButtonFound: report.page.signButtonFound
    },
    environment: {
      navigatorUserAgent: report.environment.navigatorUserAgent.slice(0, 300),
      userAgentData: report.environment.userAgentData
        ? {
            mobile: report.environment.userAgentData.mobile,
            platform: report.environment.userAgentData.platform,
            brands: report.environment.userAgentData.brands?.slice(0, 6).map((brand) => ({
              brand: brand.brand.slice(0, 80),
              version: brand.version.slice(0, 40)
            }))
          }
        : undefined,
      innerWidth: report.environment.innerWidth,
      innerHeight: report.environment.innerHeight,
      devicePixelRatio: report.environment.devicePixelRatio,
      maxTouchPoints: report.environment.maxTouchPoints,
      hasTouchEvent: report.environment.hasTouchEvent
    },
    coinIndex,
    taskDrawer,
    surprise: report.surprise
      ? { found: report.surprise.found, cardIds: report.surprise.cardIds.slice(0, 20), hasCoinAdClickAnchor: report.surprise.hasCoinAdClickAnchor }
      : undefined,
    quiz: report.quiz ? { found: report.quiz.found, options: report.quiz.options.slice(0, 8) } : undefined,
    stats,
    overlays: report.overlays.map((overlay) => overlay.phrase)
  };
}

function selectorMismatches(
  reports: DiagnosticsSnapshot["reports"],
  mainTabId?: number
): DiagnosticsSnapshot["selectorMismatches"] {
  const latest = new Map<string, DiagnosticsSnapshot["reports"][number]>();
  for (const report of reports) {
    const current = latest.get(report.route);
    const reportIsMain = mainTabId !== undefined && report.tabId === mainTabId;
    const currentIsMain = mainTabId !== undefined && current?.tabId === mainTabId;
    if (!current || reportIsMain && !currentIsMain || !reportIsMain && !currentIsMain && report.at > current.at) {
      latest.set(report.route, report);
    }
  }
  const mismatches: DiagnosticsSnapshot["selectorMismatches"] = [];
  const coin = latest.get("coin-index");
  if (coin) {
    if (!coin.page.rootFound) mismatches.push({ route: coin.route, contract: "coin-root", observedAt: coin.at, detail: "#root was not found" });
    if (!coin.page.signButtonFound) mismatches.push({ route: coin.route, contract: "coin-sign-button", observedAt: coin.at, detail: "#signButton was not found" });
  }
  const stats = latest.get("stats");
  if (stats && !stats.stats?.found) mismatches.push({ route: stats.route, contract: "stats-fields", observedAt: stats.at, detail: "No authenticated stats fields were detected" });
  const surprise = latest.get("surprise-items");
  if (surprise && !surprise.surprise?.found) mismatches.push({ route: surprise.route, contract: "surprise-grid", observedAt: surprise.at, detail: "The route-scoped surprise grid was not detected" });
  const quiz = latest.get("quiz");
  if (quiz && !quiz.quiz?.found) mismatches.push({ route: quiz.route, contract: "quiz-prompt", observedAt: quiz.at, detail: "The quiz prompt/options were not detected" });
  return mismatches;
}

function logSummary(entry: AutomationLogEntry): DiagnosticsSnapshot["logs"][number] {
  return {
    at: entry.at,
    level: entry.level,
    event: entry.event,
    message: redactText(entry.message),
    taskId: entry.taskId,
    tabId: entry.tabId,
    data: redactData(entry.data)
  };
}

export function buildDiagnostics(
  run: AutomationRun | undefined,
  reports: Phase0Report[],
  logs: AutomationLogEntry[],
  stats: StatsSnapshot | undefined,
  generatedAt = Date.now()
): DiagnosticsSnapshot {
  const reportSummaries = reports
    .slice()
    .sort((left, right) => right.at - left.at)
    .slice(0, 20)
    .map(reportSummary);
  return {
    schemaVersion: 1,
    generatedAt,
    run: run
      ? {
          id: run.id,
          logicalDay: run.logicalDay,
          state: run.state,
          trigger: run.trigger,
          attempt: run.attempt,
          executionMode: run.executionMode,
          mainTabId: run.mainTabId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          finishedAt: run.finishedAt,
          currentTaskId: run.currentTaskId,
          lastError: run.lastError ? redactText(run.lastError) : undefined,
          tasks: run.taskOrder.map((taskId) => diagnosticTask(run, taskId))
        }
      : undefined,
    reports: reportSummaries,
    selectorMismatches: selectorMismatches(reportSummaries, run?.mainTabId),
    stats: stats
      ? {
          accountState: stats.accountState,
          stale: stats.stale,
          source: { ...stats.source, url: stats.source.url ? safeUrl(stats.source.url) : undefined },
          historyEntryCount: stats.history.length,
          warnings: stats.warnings.map(redactText)
        }
      : undefined,
    logs: logs.slice().sort((left, right) => right.at - left.at).slice(0, 100).map(logSummary)
  };
}

export function diagnosticsJson(snapshot: DiagnosticsSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
