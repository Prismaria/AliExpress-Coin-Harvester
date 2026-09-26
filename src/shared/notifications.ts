import type { AutomationRun, AutomationSettings } from "./types";

export type RunNotification = {
  title: string;
  message: string;
};

export function notificationForRun(run: AutomationRun, settings: AutomationSettings): RunNotification | undefined {
  if (!settings.notifications.enabled) return undefined;
  if (run.state === "waiting_for_login" && settings.notifications.loginRequired) {
    return {
      title: "AliExpress login required",
      message: "Sign in to AliExpress, then resume the paused run."
    };
  }
  if (run.state === "succeeded" && settings.notifications.runCompleted) {
    return {
      title: "Ali Coin Harvester run complete",
      message: "All enabled tasks completed with evidence."
    };
  }
  if (run.state === "partially_succeeded" && settings.notifications.partialRun) {
    return {
      title: "Ali Coin Harvester run partially complete",
      message: "Some tasks need review or manual action."
    };
  }
  if (["failed_retryable", "failed_terminal"].includes(run.state) && settings.notifications.failures) {
    return {
      title: "Ali Coin Harvester run failed",
      message: run.lastError ?? "The run stopped before completion."
    };
  }
  return undefined;
}
