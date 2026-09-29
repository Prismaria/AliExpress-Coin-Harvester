import { describe, expect, it } from "vitest";
import { shouldAutoLoginManualProbe } from "../src/shared/manual-probe-login";
import type { Phase0Report, ProbeSession } from "../src/shared/types";

const manualMobileMain: Pick<ProbeSession, "owner" | "mobile" | "role"> = {
  owner: "manual",
  mobile: true,
  role: "main"
};

const loggedOutCoinReport: Pick<Phase0Report, "route" | "coinIndex"> = {
  route: "coin-index",
  coinIndex: {
    rootFound: false,
    loginButtonFound: true,
    buttonFound: false,
    buttonVisible: false,
    buttonHasGeometry: false,
    buttonText: "",
    buttonDisabled: false,
    currentCardClasses: "",
    state: "login-required"
  }
};

describe("manual probe saved sign-in eligibility", () => {
  it("allows a logged-out manual mobile main Coins probe", () => {
    expect(shouldAutoLoginManualProbe(manualMobileMain, loggedOutCoinReport)).toBe(true);
  });

  it("does not start saved sign-in on automation-owned, desktop, or child sessions", () => {
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, owner: "automation" }, loggedOutCoinReport)).toBe(false);
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, mobile: false }, loggedOutCoinReport)).toBe(false);
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, role: "child" }, loggedOutCoinReport)).toBe(false);
  });

  it("requires the Coins route and a detected login button", () => {
    expect(shouldAutoLoginManualProbe(manualMobileMain, { ...loggedOutCoinReport, route: "item" })).toBe(false);
    expect(shouldAutoLoginManualProbe(manualMobileMain, {
      ...loggedOutCoinReport,
      coinIndex: { ...loggedOutCoinReport.coinIndex!, loginButtonFound: false }
    })).toBe(false);
  });

  it("deduplicates in-flight and manually paused attempts unless credentials are explicitly retried", () => {
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, loginAutomationState: "attempting" }, loggedOutCoinReport)).toBe(false);
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, loginAutomationState: "manual" }, loggedOutCoinReport)).toBe(false);
    expect(shouldAutoLoginManualProbe({ ...manualMobileMain, loginAutomationState: "manual" }, loggedOutCoinReport, true)).toBe(true);
  });
});
