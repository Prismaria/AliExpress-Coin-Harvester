import { classifyRoute, findExpectedOverlays, observeCoinIndex, observePage, observeQuiz, observeStats, observeSurprise, observeTaskDrawer } from "./dom-contracts";
import { safeUrl } from "../shared/routes";
import type { Phase0Message, Phase0Report, Phase0Response } from "../shared/types";
import "./automation-controller";

const route = classifyRoute(location.href);
let monitoring = false;
let lastFingerprint = "";
let debounceTimer: number | undefined;

function collectReport(): Phase0Report {
  const currentRoute = classifyRoute(location.href);
  const userAgentData = (navigator as Navigator & {
    userAgentData?: {
      mobile?: boolean;
      platform?: string;
      brands?: Array<{ brand: string; version: string }>;
    };
  }).userAgentData;

  return {
    at: Date.now(),
    url: safeUrl(location.href),
    route: currentRoute,
    page: observePage(document),
    environment: {
      navigatorUserAgent: navigator.userAgent,
      userAgentData: userAgentData
        ? {
            mobile: userAgentData.mobile,
            platform: userAgentData.platform,
            brands: userAgentData.brands
          }
        : undefined,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      hasTouchEvent: "ontouchstart" in window
    },
    coinIndex: currentRoute === "coin-index" ? observeCoinIndex(document) : undefined,
    taskDrawer: currentRoute === "coin-index" ? observeTaskDrawer(document) : undefined,
    surprise: currentRoute === "surprise-items" ? observeSurprise(document, currentRoute) : undefined,
    quiz: currentRoute === "quiz" ? observeQuiz(document) : undefined,
    stats: currentRoute === "stats" ? observeStats(document) : undefined,
    overlays: findExpectedOverlays(document)
  };
}

function reportIfChanged(): void {
  if (!monitoring) return;
  const report = collectReport();
  const fingerprint = JSON.stringify(report);
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  void chrome.runtime.sendMessage({ type: "PHASE0_REPORT", report } satisfies Phase0Message);
}

function scheduleReport(): void {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(reportIfChanged, 250);
}

chrome.runtime.sendMessage(
  { type: "PHASE0_CONTENT_READY", route, url: safeUrl(location.href) } satisfies Phase0Message,
  (response: Phase0Response | undefined) => {
    if (chrome.runtime.lastError || !response?.owned) return;
    monitoring = true;
    reportIfChanged();
    const observer = new MutationObserver(scheduleReport);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  }
);
