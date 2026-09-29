import type { Phase0Report, ProbeSession } from "./types";

export function shouldAutoLoginManualProbe(
  session: Pick<ProbeSession, "owner" | "mobile" | "role" | "loginAutomationState">,
  report: Pick<Phase0Report, "route" | "coinIndex">,
  retryManual = false
): boolean {
  return session.owner === "manual" && session.mobile && session.role === "main" &&
    report.route === "coin-index" && report.coinIndex?.loginButtonFound === true &&
    session.loginAutomationState !== "attempting" &&
    (session.loginAutomationState !== "manual" || retryManual);
}
