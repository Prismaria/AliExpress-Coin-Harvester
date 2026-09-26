import { safeUrl } from "./routes";
import type { StatsHistoryCategory, StatsHistoryEntry, StatsSnapshot } from "./types";

export type MtopResponse = {
  data?: {
    data?: unknown;
    success?: boolean;
  };
  ret?: unknown;
};

export type MtopFlowEntry = {
  id?: string | number;
  date?: number;
  eventType?: string;
  extendAttr1?: string | number;
  formatTime?: string;
  num?: number | string;
  subject?: string;
  sequence?: number;
};

export type MtopEventType = {
  key: string;
  name: string;
};

export type MtopStatsPayload = {
  pageUrl: string;
  balance: Array<{ name: string; value: unknown }>;
  lifetime: { coinSaveFormatPrice?: unknown };
  earned: MtopFlowEntry[];
  used: MtopFlowEntry[];
  expired: MtopFlowEntry[];
  eventTypes: {
    earned: MtopEventType[];
    used: MtopEventType[];
  };
  warnings?: string[];
};

export type MtopBridgeRequest = {
  source: "ali-coin-harvester";
  type: "ALI_COIN_MTOP_REQUEST";
  requestId: string;
};

export type MtopBridgeResponse = {
  source: "ali-coin-harvester";
  type: "ALI_COIN_MTOP_RESPONSE";
  requestId: string;
  ok: boolean;
  snapshot?: StatsSnapshot;
  error?: string;
};

export const MTOP_BRIDGE_SOURCE = "ali-coin-harvester" as const;

export function parseMtopJsonp(text: string): MtopResponse {
  const trimmed = text.trim();
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open < 1 || close <= open) throw new Error("MTop returned an invalid JSONP envelope");
  const value: unknown = JSON.parse(trimmed.slice(open + 1, close));
  if (!value || typeof value !== "object") throw new Error("MTop returned a non-object envelope");
  return value as MtopResponse;
}

export function mtopReturnMessages(response: MtopResponse): string[] {
  return Array.isArray(response.ret) ? response.ret.filter((value): value is string => typeof value === "string") : [];
}

export function isMtopTokenExpired(response: MtopResponse): boolean {
  return mtopReturnMessages(response).some((message) => /TOKEN_EXOIRED|TOKEN_EXPIRED|令牌过期/iu.test(message));
}

export function isMtopAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:FAIL_SYS_(?:TOKEN_EXOIRED|TOKEN_EXPIRED|SESSION_EXPIRED|USER_VALIDATE|NOT_LOGIN|LOGIN|AUTH)|(?:not|no|please)\s+(?:logged[ -]?in|login|sign(?:ed)?\s+in)|unauthori[sz]ed|未登录|请先登录|登录后)/iu.test(message);
}

export function mtopResponseData(response: MtopResponse, scene: string): unknown {
  const messages = mtopReturnMessages(response);
  if (messages.length && !messages.some((message) => /^SUCCESS::/u.test(message))) {
    throw new Error(`${scene}: ${messages[0]}`);
  }
  if (response.data?.success !== true || response.data.data === undefined) {
    throw new Error(`${scene}: MTop returned no successful data`);
  }
  return response.data.data;
}

function dateParts(timestamp: number): { dateKey?: string; dateLabel?: string } {
  const normalized = timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return {};
  return {
    dateKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    dateLabel: date.toLocaleDateString()
  };
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function amountRaw(value: unknown): string | undefined {
  const numeric = numericValue(value);
  if (numeric === undefined) return undefined;
  const text = String(numeric);
  return numeric > 0 ? `+${text}` : text;
}

function priceFormat(value: unknown): string | undefined {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const structure = (parsed as Record<string, unknown>).structure;
  if (!structure || typeof structure !== "object") return undefined;
  const formatPrice = (structure as Record<string, unknown>).formatPrice;
  return typeof formatPrice === "string" && formatPrice.trim() ? formatPrice.trim() : undefined;
}

function historyEntry(
  entry: MtopFlowEntry,
  category: StatsHistoryCategory,
  index: number,
  warnings: string[]
): StatsHistoryEntry | undefined {
  const amount = amountRaw(entry.num);
  const title = entry.subject?.trim() || entry.eventType?.trim();
  if (amount === undefined || !title) {
    warnings.push(`MTop ${category} history row ${index + 1} was missing its title or amount`);
    return undefined;
  }

  const timestamp = numericValue(entry.date);
  const parts = timestamp === undefined ? {} : dateParts(timestamp);
  const nativeId = entry.id ?? entry.extendAttr1;
  const identity = nativeId !== undefined
    ? String(nativeId)
    : `${entry.date ?? "undated"}:${entry.eventType ?? ""}:${entry.num ?? ""}:${entry.sequence ?? index}`;
  const result: StatsHistoryEntry = {
    id: `${category}:${identity}`,
    category,
    dateLabel: entry.formatTime?.trim() || parts.dateLabel,
    dateKey: parts.dateKey,
    title,
    amountRaw: amount
  };
  if (timestamp !== undefined) result.timestamp = timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
  if (entry.eventType?.trim()) result.eventType = entry.eventType.trim();
  return result;
}

function normalizeHistory(
  entries: MtopFlowEntry[],
  category: StatsHistoryCategory,
  warnings: string[]
): StatsHistoryEntry[] {
  return entries.flatMap((entry, index) => {
    const normalized = historyEntry(entry, category, index, warnings);
    return normalized ? [normalized] : [];
  });
}

function balanceValue(balance: MtopStatsPayload["balance"], name: string): unknown {
  return balance.find((entry) => entry.name === name)?.value;
}

function normalizedEventTypes(values: MtopEventType[]): MtopEventType[] {
  return values.filter((value) => value.key.trim() && value.name.trim()).map((value) => ({
    key: value.key.trim(),
    name: value.name.trim()
  }));
}

export function normalizeMtopStats(payload: MtopStatsPayload, observedAt = Date.now()): StatsSnapshot {
  const warnings = [...(payload.warnings ?? [])];
  const coinCount = numericValue(balanceValue(payload.balance, "userCoinsNum"));
  const currentValue = balanceValue(payload.balance, "valueMoney");
  const currentSavingsRaw = typeof currentValue === "string" ? currentValue.trim() || undefined : undefined;
  const lifetimePrice = priceFormat(payload.lifetime.coinSaveFormatPrice);
  const history = [
    ...normalizeHistory(payload.earned, "earned", warnings),
    ...normalizeHistory(payload.used, "used", warnings),
    ...normalizeHistory(payload.expired, "expired", warnings)
  ];
  const earnedEventTypes = normalizedEventTypes(payload.eventTypes.earned);
  const usedEventTypes = normalizedEventTypes(payload.eventTypes.used);
  const historyEventTypes = earnedEventTypes.length || usedEventTypes.length
    ? { earned: earnedEventTypes, used: usedEventTypes }
    : undefined;
  const hasValues = coinCount !== undefined || currentSavingsRaw !== undefined || lifetimePrice !== undefined || history.length > 0;

  return {
    accountState: hasValues ? "authenticated" : "empty",
    coinCountRaw: coinCount === undefined ? undefined : String(coinCount),
    currentSavingsRaw,
    lifetimeSavingsRaw: lifetimePrice,
    history,
    historyEventTypes,
    source: {
      kind: "page-mtop",
      url: safeUrl(payload.pageUrl),
      observedAt
    },
    stale: false,
    warnings
  };
}
