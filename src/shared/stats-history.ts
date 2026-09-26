import type { StatsHistoryEntry } from "./types";

export const HISTORY_RETENTION_MONTHS = 6;
export const MAX_STORED_HISTORY_ENTRIES = 500;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function historyDateKey(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const value = label.normalize("NFKC").trim();
  const numeric = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\b|\s)/u);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const year = Number(numeric[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }

  const iso = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\b|\s)/u);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const date = new Date(parsed);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function historyCutoffKey(now = Date.now(), retentionMonths = HISTORY_RETENTION_MONTHS): string {
  const cutoff = startOfDay(new Date(now));
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
}

export function normalizedHistoryEntry(entry: StatsHistoryEntry): StatsHistoryEntry | undefined {
  const dateKey = entry.dateKey ?? historyDateKey(entry.dateLabel);
  if (!dateKey) return undefined;
  return { ...entry, dateKey };
}

export function historyEntryKey(entry: StatsHistoryEntry): string {
  return entry.id || [entry.category, entry.dateKey ?? entry.dateLabel ?? "undated", entry.title, entry.amountRaw].join("|");
}

export function retainHistory(
  entries: StatsHistoryEntry[],
  now = Date.now(),
  retentionMonths = HISTORY_RETENTION_MONTHS,
  maxEntries = MAX_STORED_HISTORY_ENTRIES
): StatsHistoryEntry[] {
  const cutoff = historyCutoffKey(now, retentionMonths);
  const unique = new Map<string, StatsHistoryEntry>();
  for (const entry of entries) {
    const normalized = normalizedHistoryEntry(entry);
    if (!normalized || (normalized.dateKey ?? "") < cutoff) continue;
    unique.set(historyEntryKey(normalized), normalized);
  }
  return [...unique.values()]
    .sort((left, right) => {
      const dateOrder = (right.dateKey ?? "").localeCompare(left.dateKey ?? "");
      return dateOrder || historyEntryKey(left).localeCompare(historyEntryKey(right));
    })
    .slice(0, maxEntries);
}

export function mergeHistory(
  existing: StatsHistoryEntry[],
  incoming: StatsHistoryEntry[],
  now = Date.now(),
  retentionMonths = HISTORY_RETENTION_MONTHS,
  maxEntries = MAX_STORED_HISTORY_ENTRIES
): StatsHistoryEntry[] {
  return retainHistory([...existing, ...incoming], now, retentionMonths, maxEntries);
}
