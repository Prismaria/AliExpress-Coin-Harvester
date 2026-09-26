import { md5 } from "../shared/md5";
import {
  isMtopTokenExpired,
  isMtopAuthenticationError,
  mtopResponseData,
  normalizeMtopStats,
  parseMtopJsonp,
  MTOP_BRIDGE_SOURCE,
  type MtopBridgeRequest,
  type MtopBridgeResponse,
  type MtopEventType,
  type MtopFlowEntry,
  type MtopResponse,
  type MtopStatsPayload
} from "../shared/mtop-stats";
import type { StatsSnapshot } from "../shared/types";
import { isAliExpressPageUrl, safeUrl } from "../shared/routes";

const MTOP_ENDPOINT = "https://acs.aliexpress.com/h5/mtop.aliexpress.coin.execute/1.0/";
const MTOP_APP_KEY = "24815441";
const MTOP_TIMEOUT_MS = 20_000;
const MTOP_COLLECTION_TIMEOUT_MS = 90_000;
const HISTORY_PAGE_SIZE = 20;
const MAX_HISTORY_PAGES = 25;
const JSONP_CALLBACK_PREFIX = "__aliCoinHarvesterMtop";

type CookieSettings = Record<string, string>;
type PageWindow = Window & Record<string, unknown>;

let callbackSequence = 0;
let activeRequest: Promise<StatsSnapshot> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    const raw = value.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function readCookieSettings(): CookieSettings {
  const raw = readCookie("aep_usuc_f");
  if (!raw) return {};
  return Object.fromEntries(
    raw.split("&").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return [];
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      return [[key, value]];
    })
  );
}

function localeSettings(): { language: string; region: string; currency: string } {
  const cookies = readCookieSettings();
  const languageSource = document.documentElement.lang || navigator.language || "en-US";
  const languageParts = languageSource.replace("-", "_").split("_");
  const region = (cookies.region || languageParts[1] || "US").toUpperCase();
  const language = `${languageParts[0] || "en"}_${region}`;
  return {
    language,
    region,
    currency: (cookies.c_tp || "USD").toUpperCase()
  };
}

function tokenFromCookie(): string | undefined {
  const raw = readCookie("_m_h5_tk");
  if (!raw) return undefined;
  const separator = raw.indexOf("_");
  const token = separator >= 0 ? raw.slice(0, separator) : raw;
  return token || undefined;
}

function jsonpRequest(url: string, timeoutMs = MTOP_TIMEOUT_MS): Promise<MtopResponse> {
  return new Promise((resolve, reject) => {
    const callbackName = `${JSONP_CALLBACK_PREFIX}${Date.now()}_${callbackSequence++}`;
    const pageWindow = window as unknown as PageWindow;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = (): void => {
      window.clearTimeout(timeout);
      delete pageWindow[callbackName];
      script.remove();
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error("MTop JSONP request timed out")));
    }, timeoutMs);

    pageWindow[callbackName] = (value: unknown) => {
      finish(() => {
        const response = asRecord(value);
        if (!response) reject(new Error("MTop JSONP returned an invalid response"));
        else resolve(response as MtopResponse);
      });
    };
    script.async = true;
    script.src = `${url}&callback=${encodeURIComponent(callbackName)}`;
    script.onerror = () => finish(() => reject(new Error("MTop JSONP script failed to load")));
    (document.head || document.documentElement).append(script);
  });
}

function requestData(scene: string, param?: Record<string, number>): string {
  const locale = localeSettings();
  const data: Record<string, unknown> = {
    scene,
    _lang: locale.language,
    _currency: locale.currency,
    locale: locale.region
  };

  if (scene === "UserCoinNum") {
    data.lang = locale.language;
    data.currency = locale.currency;
    data.platform = "app";
    data.param = "{}";
  } else if (param) {
    data.param = JSON.stringify(param);
  }

  return JSON.stringify(data);
}

async function requestScene(scene: string, param: Record<string, number> | undefined, deadline: number): Promise<unknown> {
  let lastResponse: MtopResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("MTop stats collection timed out");
    const token = tokenFromCookie();
    if (!token) throw new Error("AliExpress MTop token cookie was not available on the page");

    const timestamp = String(Date.now());
    const data = requestData(scene, param);
    const query = new URLSearchParams({
      jsv: "2.7.5",
      appKey: MTOP_APP_KEY,
      t: timestamp,
      sign: md5(`${token}&${timestamp}&${MTOP_APP_KEY}&${data}`),
      api: "mtop.aliexpress.coin.execute",
      v: "1.0",
      type: "jsonp",
      dataType: "jsonp",
      data
    });
    if (scene === "UserCoinNum") query.set("ecode", "1");
    else query.set("H5Request", "true");

    const response = await jsonpRequest(`${MTOP_ENDPOINT}?${query.toString()}`, Math.min(MTOP_TIMEOUT_MS, remaining));
    lastResponse = response;
    if (isMtopTokenExpired(response)) continue;
    return mtopResponseData(response, scene);
  }

  const detail = lastResponse ? mtopResponseData(lastResponse, scene) : undefined;
  return detail;
}

function flowEntries(value: unknown, sequenceOffset: number): MtopFlowEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const row = asRecord(candidate);
    if (!row) return [];
    return [{
      id: typeof row.id === "string" || typeof row.id === "number" ? row.id : undefined,
      date: typeof row.date === "number" ? row.date : undefined,
      eventType: typeof row.eventType === "string" ? row.eventType : undefined,
      extendAttr1: typeof row.extendAttr1 === "string" || typeof row.extendAttr1 === "number" ? row.extendAttr1 : undefined,
      formatTime: typeof row.formatTime === "string" ? row.formatTime : undefined,
      num: typeof row.num === "number" || typeof row.num === "string" ? row.num : undefined,
      subject: typeof row.subject === "string" ? row.subject : undefined,
      sequence: sequenceOffset + index
    } satisfies MtopFlowEntry];
  });
}

function eventTypes(value: unknown): MtopEventType[] {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.eventTypes)) return [];
  return record.eventTypes.flatMap((candidate) => {
    const row = asRecord(candidate);
    return row && typeof row.key === "string" && typeof row.name === "string"
      ? [{ key: row.key, name: row.name }]
      : [];
  });
}

function balanceFields(value: unknown): Array<{ name: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const row = asRecord(candidate);
    return row && typeof row.name === "string" && "value" in row
      ? [{ name: row.name, value: row.value }]
      : [];
  });
}

function lifetimeValue(value: unknown): { coinSaveFormatPrice?: unknown } {
  const record = asRecord(value);
  return record && "coinSaveFormatPrice" in record
    ? { coinSaveFormatPrice: record.coinSaveFormatPrice }
    : {};
}

async function collectFlow(flagType: number, warnings: string[], deadline: number): Promise<MtopFlowEntry[]> {
  const entries: MtopFlowEntry[] = [];
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const value = await requestScene("CoinFlowList", { page, pageSize: HISTORY_PAGE_SIZE, flagType }, deadline);
    const pageEntries = flowEntries(value, entries.length);
    entries.push(...pageEntries);
    if (pageEntries.length < HISTORY_PAGE_SIZE) return entries;
  }
  warnings.push(`MTop coin flow reached the ${MAX_HISTORY_PAGES}-page safety limit`);
  return entries;
}

async function collectExpired(warnings: string[], deadline: number): Promise<MtopFlowEntry[]> {
  const entries: MtopFlowEntry[] = [];
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const value = await requestScene("ExpiredAccountList", { page, pageSize: HISTORY_PAGE_SIZE }, deadline);
    const pageEntries = flowEntries(value, entries.length);
    entries.push(...pageEntries);
    if (pageEntries.length < HISTORY_PAGE_SIZE) return entries;
  }
  warnings.push(`MTop expired history reached the ${MAX_HISTORY_PAGES}-page safety limit`);
  return entries;
}

async function collectStats(): Promise<StatsSnapshot> {
  try {
    if (location.pathname.includes("/p/ug-login-page/login.html")) {
      return {
        accountState: "logged-out",
        history: [],
        source: { kind: "page-mtop", url: safeUrl(location.href), observedAt: Date.now() },
        stale: false,
        warnings: ["AliExpress login page is open"]
      };
    }

    const deadline = Date.now() + MTOP_COLLECTION_TIMEOUT_MS;
    const warnings: string[] = [];
    const balance = balanceFields(await requestScene("UserCoinNum", undefined, deadline));
    const earnedEventTypes = eventTypes(await requestScene("CoinEventType", { flagType: 1 }, deadline));
    const lifetime = lifetimeValue(await requestScene("CoinSaveMoneyNumV2", undefined, deadline));
    const earned = await collectFlow(1, warnings, deadline);
    const usedEventTypes = eventTypes(await requestScene("CoinEventType", { flagType: -1 }, deadline));
    const used = await collectFlow(-1, warnings, deadline);
    const expired = await collectExpired(warnings, deadline);

    const payload: MtopStatsPayload = {
      pageUrl: location.href,
      balance,
      lifetime,
      earned,
      used,
      expired,
      eventTypes: { earned: earnedEventTypes, used: usedEventTypes },
      warnings
    };
    return normalizeMtopStats(payload);
  } catch (error) {
    if (!isMtopAuthenticationError(error)) throw error;
    return {
      accountState: "logged-out",
      history: [],
      source: { kind: "page-mtop", url: safeUrl(location.href), observedAt: Date.now() },
      stale: false,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function isBridgeRequest(value: unknown): value is MtopBridgeRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MtopBridgeRequest>;
  return candidate.source === MTOP_BRIDGE_SOURCE &&
    candidate.type === "ALI_COIN_MTOP_REQUEST" &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length < 200;
}

function postResponse(response: MtopBridgeResponse): void {
  window.postMessage(response, window.location.origin);
}

function isStatsBridgePage(): boolean {
  return isAliExpressPageUrl(window.location.href);
}

async function handleRequest(request: MtopBridgeRequest): Promise<void> {
  const requestPromise = activeRequest ?? collectStats();
  activeRequest = requestPromise;
  try {
    postResponse({
      source: MTOP_BRIDGE_SOURCE,
      type: "ALI_COIN_MTOP_RESPONSE",
      requestId: request.requestId,
      ok: true,
      snapshot: await requestPromise
    });
  } catch (error) {
    postResponse({
      source: MTOP_BRIDGE_SOURCE,
      type: "ALI_COIN_MTOP_RESPONSE",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (activeRequest === requestPromise) activeRequest = undefined;
  }
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isStatsBridgePage() || event.source !== window || event.origin !== window.location.origin || !isBridgeRequest(event.data)) return;
  void handleRequest(event.data);
});
