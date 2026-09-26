import type {
  StatsAccountState,
  StatsHistoryCategory,
  StatsHistoryEntry,
  StatsParseOptions,
  StatsParseResult,
  StatsSource,
  StatsSnapshot
} from "../shared/types";
import { STATS_URL } from "../shared/constants";
import { classifyRoute, safeUrl } from "../shared/routes";
import { historyDateKey } from "../shared/stats-history";
import { compactText, isVisible, normalizeText } from "./dom-contracts";

const COIN_COUNT_SELECTOR = ".coin-info-content-head-text";
const CURRENT_SAVINGS_SELECTOR = ".coin-info-content-money-num";
const LIFETIME_SAVINGS_SELECTOR = ".coin-history-head-subtitle";
const HISTORY_LIST_SELECTOR = ".coin-history-content-data-list";
const HISTORY_ITEM_SELECTOR = ".data-history-item-content";

function hasLoadingSignal(document: Document): boolean {
  if ([...document.querySelectorAll("[aria-busy]")].some((element) => element.getAttribute("aria-busy") === "true")) {
    return true;
  }

  return [...document.querySelectorAll("[class]")].some((element) => {
    if (!isVisible(element)) return false;
    return /(?:^|[-_])loading(?:[-_]|$)/iu.test(element.className.toString());
  });
}

function hasLoginSignal(document: Document): boolean {
  const bodyText = normalizeText(document.body?.textContent);
  return /(?:please )?(?:log in|login|sign in)(?: to continue)?/u.test(bodyText);
}

function isValidCoinCount(value: string | undefined): boolean {
  return Boolean(value && /^\d[\d,]*(?:\.\d+)?$/u.test(value.replace(/\s+/gu, "")));
}

function hasCurrencyAmount(value: string | undefined): boolean {
  return Boolean(
    value &&
      /\d/u.test(value) &&
      /[$€£¥]|(?:^|\s)[A-Z]{2,4}\s*\$|\b(?:USD|CAD|EUR|GBP|CNY|JPY)\b/iu.test(value)
  );
}

export function historyCategoryFromText(value: string | null | undefined): StatsHistoryCategory {
  const raw = normalizeText(value);
  if (/earn/u.test(raw)) return "earned";
  if (/used|use|spend/u.test(raw)) return "used";
  if (/expir/u.test(raw)) return "expired";
  return "unknown";
}

function historyCategory(element: Element): StatsHistoryCategory {
  const owner = element.closest("[data-category], [data-type], [data-tab]");
  return historyCategoryFromText(
    owner?.getAttribute("data-category") ?? owner?.getAttribute("data-type") ?? owner?.getAttribute("data-tab")
  );
}

function historyEntryId(element: Element, category: StatsHistoryCategory, dateLabel: string | undefined, title: string, amountRaw: string): string {
  const nativeId = element.getAttribute("data-id") ?? element.getAttribute("data-key") ?? element.getAttribute("data-transaction-id");
  if (nativeId) return `${category}:${nativeId}`;
  return [category, dateLabel ?? "undated", normalizeText(title), normalizeText(amountRaw)].join("|");
}

function parseHistory(
  document: Document,
  warnings: string[],
  categoryOverride?: StatsHistoryCategory
): StatsHistoryEntry[] {
  const list = document.querySelector(HISTORY_LIST_SELECTOR);
  if (!list) return [];

  let dateLabel: string | undefined;
  const entries: StatsHistoryEntry[] = [];
  for (const element of [...list.querySelectorAll(`.data-history-item-date, ${HISTORY_ITEM_SELECTOR}`)]) {
    if (element.matches(".data-history-item-date")) {
      dateLabel = compactText(element.textContent) || undefined;
      continue;
    }

    const title = compactText(element.querySelector(".data-history-item-content-title")?.textContent);
    const amountRaw = compactText(element.querySelector(".data-history-item-content-num")?.textContent);
    if (!title || !amountRaw) {
      warnings.push("A history row was missing its title or amount");
      continue;
    }

    const category = categoryOverride ?? historyCategory(element);
    const dateKey = historyDateKey(dateLabel);
    if (!dateKey) warnings.push("A history row was missing a recognized date");
    entries.push({
      id: historyEntryId(element, category, dateLabel, title, amountRaw),
      category,
      dateLabel,
      dateKey,
      title,
      amountRaw
    });
  }
  return entries;
}

function accountState(
  document: Document,
  rawUrl: string | undefined,
  coinCountRaw: string | undefined,
  currentSavingsRaw: string | undefined,
  lifetimeSavingsRaw: string | undefined,
  history: StatsHistoryEntry[],
  warnings: string[]
): StatsAccountState {
  if (rawUrl && classifyRoute(rawUrl) === "login") return "logged-out";
  if (hasLoginSignal(document) && !document.querySelector(".coin-info")) {
    warnings.push("Stats response contains a login prompt without redirecting to the login route");
    return "logged-out";
  }

  const coinCountElement = document.querySelector(COIN_COUNT_SELECTOR);
  const currentSavingsElement = document.querySelector(CURRENT_SAVINGS_SELECTOR);
  const lifetimeSavingsElement = document.querySelector(LIFETIME_SAVINGS_SELECTOR);
  const hasStatsShell = Boolean(document.querySelector(`.coin-info, .coin-history, ${HISTORY_LIST_SELECTOR}`));
  const hasValues = Boolean(coinCountRaw || currentSavingsRaw || lifetimeSavingsRaw || history.length);

  if (hasLoadingSignal(document) && !hasValues) return "loading";
  if (!hasStatsShell) return "malformed";

  if (
    (coinCountRaw && !isValidCoinCount(coinCountRaw)) ||
    (currentSavingsRaw && !hasCurrencyAmount(currentSavingsRaw)) ||
    (lifetimeSavingsRaw && !hasCurrencyAmount(lifetimeSavingsRaw))
  ) {
    warnings.push("A stats value did not match the expected numeric or currency shape");
    return "malformed";
  }

  if (coinCountElement && !coinCountRaw && currentSavingsElement && !currentSavingsRaw && lifetimeSavingsElement && !lifetimeSavingsRaw && !history.length) {
    return "empty";
  }
  return hasValues ? "authenticated" : "empty";
}

export function parseStatsDocument(document: Document, options: StatsParseOptions = {}): StatsParseResult {
  const observedAt = options.observedAt ?? Date.now();
  const rawUrl = options.rawUrl ?? STATS_URL;
  const source: StatsSource = {
    kind: options.source ?? "stats-html",
    url: safeUrl(rawUrl),
    observedAt
  };
  const warnings: string[] = [];
  const coinCountRaw = compactText(document.querySelector(COIN_COUNT_SELECTOR)?.textContent) || undefined;
  const currentSavingsRaw = compactText(document.querySelector(CURRENT_SAVINGS_SELECTOR)?.textContent) || undefined;
  const lifetimeSavingsRaw = compactText(document.querySelector(LIFETIME_SAVINGS_SELECTOR)?.textContent) || undefined;
  const history = parseHistory(document, warnings, options.historyCategory);
  const snapshot: StatsSnapshot = {
    accountState: accountState(document, rawUrl, coinCountRaw, currentSavingsRaw, lifetimeSavingsRaw, history, warnings),
    coinCountRaw,
    currentSavingsRaw,
    lifetimeSavingsRaw,
    history,
    source,
    stale: false,
    warnings
  };
  return { snapshot };
}
