import type { StatsAccountState, StatsCacheRecord, StatsHistoryCacheRecord, StatsSnapshot } from "./types";

export const STATS_CACHE_SCHEMA_VERSION = 1 as const;
export const STATS_CACHE_TTL_MS = 5 * 60_000;
export const STATS_HISTORY_CACHE_SCHEMA_VERSION = 1 as const;

export function formatCoinBadge(rawValue: string | undefined): string {
  if (!rawValue) return "";
  const value = Number(rawValue.replaceAll(",", "").trim());
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 10_000) return String(Math.floor(value));

  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"]
  ];
  const [divisor, suffix] = units.find(([unit]) => value >= unit) ?? units.at(-1)!;
  const scaled = value / divisor;
  const amount = scaled < 10 ? scaled.toFixed(1).replace(/\.0$/u, "") : String(Math.floor(scaled));
  return `${amount}${suffix}`;
}

function hasUsableStats(state: StatsAccountState): boolean {
  return state === "authenticated" || state === "empty";
}

function uniqueWarnings(...warningLists: string[][]): string[] {
  return [...new Set(warningLists.flat())].slice(0, 12);
}

export function isStatsCacheRecord(value: unknown): value is StatsCacheRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StatsCacheRecord>;
  return candidate.schemaVersion === STATS_CACHE_SCHEMA_VERSION &&
    typeof candidate.checkedAt === "number" &&
    Boolean(candidate.snapshot && typeof candidate.snapshot === "object") &&
    Boolean(candidate.snapshot?.source && typeof candidate.snapshot.source === "object") &&
    ["authenticated", "logged-out", "empty", "loading", "malformed", "unavailable"].includes(candidate.snapshot?.accountState ?? "") &&
    ["stats-html", "controlled-tab", "page-mtop"].includes(candidate.snapshot?.source?.kind ?? "") &&
    typeof candidate.snapshot?.source?.observedAt === "number" &&
    Array.isArray(candidate.snapshot?.history) &&
    typeof candidate.snapshot?.stale === "boolean";
}

export function isStatsHistoryCacheRecord(value: unknown): value is StatsHistoryCacheRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StatsHistoryCacheRecord>;
  return candidate.schemaVersion === STATS_HISTORY_CACHE_SCHEMA_VERSION &&
    typeof candidate.updatedAt === "number" &&
    Array.isArray(candidate.entries);
}

export function isStatsCacheFresh(record: StatsCacheRecord | undefined, now = Date.now()): boolean {
  return Boolean(
    record &&
      record.fetchedAt !== undefined &&
      hasUsableStats(record.snapshot.accountState) &&
      !record.snapshot.stale &&
      now >= record.fetchedAt &&
      now - record.fetchedAt < STATS_CACHE_TTL_MS
  );
}

export function cacheStatsSnapshot(
  previous: StatsCacheRecord | undefined,
  incoming: StatsSnapshot,
  checkedAt = Date.now()
): StatsCacheRecord {
  if (hasUsableStats(incoming.accountState)) {
    return {
      schemaVersion: STATS_CACHE_SCHEMA_VERSION,
      snapshot: { ...incoming, stale: false },
      fetchedAt: checkedAt,
      checkedAt
    };
  }

  if (previous) {
    return {
      schemaVersion: STATS_CACHE_SCHEMA_VERSION,
      snapshot: {
        ...previous.snapshot,
        accountState: incoming.accountState,
        source: incoming.source,
        stale: true,
        warnings: uniqueWarnings(previous.snapshot.warnings, incoming.warnings)
      },
      fetchedAt: previous.fetchedAt,
      checkedAt
    };
  }

  return {
    schemaVersion: STATS_CACHE_SCHEMA_VERSION,
    snapshot: { ...incoming, stale: true },
    checkedAt
  };
}

export function markStatsCacheStale(
  previous: StatsCacheRecord | undefined,
  warning: string,
  checkedAt = Date.now()
): StatsCacheRecord | undefined {
  if (!previous) return undefined;
  return {
    ...previous,
    checkedAt,
    snapshot: {
      ...previous.snapshot,
      stale: true,
      warnings: uniqueWarnings(previous.snapshot.warnings, [warning])
    }
  };
}

export function createRefreshCoalescer<T>() {
  let active: Promise<T> | undefined;

  return {
    run(operation: () => Promise<T>): Promise<T> {
      if (active) return active;
      const current = (async () => operation())();
      active = current;
      void (async () => {
        try {
          await current;
        } catch {
          // The caller owns the refresh error; cleanup must not create a second rejection.
        } finally {
          if (active === current) active = undefined;
        }
      })();
      return current;
    },
    isActive(): boolean {
      return active !== undefined;
    }
  };
}
