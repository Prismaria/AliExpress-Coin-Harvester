import type { Progress, RouteKind, TaskId } from "./types";
import {
  AGGRESSIVE_EXTRA_TASK_ATTEMPTS,
  AGGRESSIVE_TASK_OUTCOME_WAIT_MS,
  NAVIGATION_OUTCOME_WAIT_MS,
  OPTIONAL_CHILD_CLOSE_MS,
  OPTIONAL_DIRECT_CREDIT_GRACE_MS,
} from "./constants";

export type TaskPolicy = "passive" | "surprise" | "quiz" | "assisted";
export type TaskNavigationPolicy = "required-child" | "optional-child";

export type TaskCatalogEntry = {
  id: TaskId;
  groupId: string;
  title: string;
  goal: number;
  policy: TaskPolicy;
  navigation: TaskNavigationPolicy;
  requiresMobileIdentity: boolean;
  launchUrl?: string;
  drawerClickCount?: number;
  minimumDwellMs?: number;
  rowDisappearsOnCompletion?: boolean;
  allowedRoutes: RouteKind[];
  pathPrefixes: string[];
};

export const TASK_CATALOG: readonly TaskCatalogEntry[] = [
  {
    id: "daily_checkin",
    groupId: "548001",
    title: "Daily check-in",
    goal: 1,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: true,
    rowDisappearsOnCompletion: true,
    allowedRoutes: ["coin-index", "coin-pc-index"],
    pathPrefixes: []
  },
  {
    id: "sponsored_items",
    groupId: "550001",
    title: "Explore sponsored items",
    goal: 2,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: true,
    drawerClickCount: 2,
    minimumDwellMs: 15_000,
    allowedRoutes: ["coin-pc-index"],
    pathPrefixes: ["/p/coin-pc-index/index.html"]
  },
  {
    id: "surprise_items",
    groupId: "552001",
    title: "Browse surprise items",
    goal: 2,
    policy: "surprise",
    navigation: "required-child",
    requiresMobileIdentity: true,
    allowedRoutes: ["surprise-items", "item"],
    pathPrefixes: ["/p/coin-index/adclick.html", "/item/"]
  },
  {
    id: "recently_viewed",
    groupId: "556001",
    title: "Browse recently viewed items",
    goal: 1,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: false,
    minimumDwellMs: 15_000,
    allowedRoutes: ["other", "item", "coin-pc-index"],
    pathPrefixes: []
  },
  {
    id: "savings_recap",
    groupId: "1714001",
    title: "View your Coins Savings Recap",
    goal: 1,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: false,
    allowedRoutes: ["other", "item", "coin-pc-index", "stats"],
    pathPrefixes: []
  },
  {
    id: "super_discounts",
    groupId: "554001",
    title: "View Super discounts",
    goal: 3,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: true,
    drawerClickCount: 3,
    minimumDwellMs: 15_000,
    allowedRoutes: ["other"],
    pathPrefixes: ["/ssr/300000949/gamecenterpc", "/p/coin-index/hotsale.html"]
  },
  {
    id: "coin_search",
    groupId: "552002",
    title: "Search for what you love",
    goal: 1,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: false,
    allowedRoutes: ["other"],
    pathPrefixes: ["/p/coin-search/activation.html"]
  },
  {
    id: "coupons_credits",
    groupId: "566001",
    title: "Coupons & shopping credits for you!",
    goal: 1,
    policy: "passive",
    navigation: "optional-child",
    requiresMobileIdentity: false,
    allowedRoutes: ["other", "item", "coin-pc-index"],
    pathPrefixes: []
  },
  {
    id: "prize_land",
    groupId: "558001",
    title: "Items at $0.1 to get",
    goal: 1,
    policy: "assisted",
    navigation: "required-child",
    requiresMobileIdentity: true,
    launchUrl: "https://m.aliexpress.com/ssr/300000949/farmpc",
    minimumDwellMs: 5 * 60_000,
    allowedRoutes: ["other"],
    pathPrefixes: ["/ssr/300000949/farmpc"]
  },
  {
    id: "merge_boss",
    groupId: "658001",
    title: "Complete 1 Merge Boss game order",
    goal: 1,
    policy: "assisted",
    navigation: "required-child",
    requiresMobileIdentity: true,
    launchUrl: "https://m.aliexpress.com/p/merge-market/index.html",
    minimumDwellMs: 5 * 60_000,
    allowedRoutes: ["other"],
    pathPrefixes: ["/p/merge-market/index.html"]
  },
  {
    id: "daily_quiz",
    groupId: "2126001",
    title: "Daily quiz challenge",
    goal: 1,
    policy: "quiz",
    navigation: "required-child",
    requiresMobileIdentity: true,
    launchUrl: "https://m.aliexpress.com/p/coin-index/coinquest.html",
    allowedRoutes: ["quiz"],
    pathPrefixes: ["/p/coin-index/coinquest.html"]
  }
];

export const TASK_CATALOG_BY_ID = Object.fromEntries(
  TASK_CATALOG.map((task) => [task.id, task])
) as Record<TaskId, TaskCatalogEntry>;

export const DEFAULT_ENABLED_TASK_IDS: TaskId[] = TASK_CATALOG
  .filter((task) => task.policy !== "assisted")
  .map((task) => task.id);

export function taskForGroupId(groupId: string): TaskCatalogEntry | undefined {
  return TASK_CATALOG.find((task) => task.groupId === groupId);
}

export function taskDestinationMatches(task: TaskCatalogEntry, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !["m.aliexpress.com", "www.aliexpress.com"].includes(url.hostname)) {
      return false;
    }
    if (!task.pathPrefixes.length) {
      const path = url.pathname.toLocaleLowerCase();
      return !/(?:\/login|\/signin|\/auth|\/captcha|\/challenge|\/checkout|\/payment|\/order|\/buy|\/address)/u.test(path);
    }
    return task.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

export function taskAllowsRoute(task: TaskCatalogEntry, route: RouteKind): boolean {
  return task.allowedRoutes.includes(route);
}

export function taskRequiresChildNavigation(task: TaskCatalogEntry, itemId?: string): boolean {
  return Boolean(itemId && task.id === "surprise_items") || task.navigation === "required-child";
}

export function taskDestinationMatters(task: TaskCatalogEntry): boolean {
  return task.navigation !== "optional-child" || task.policy !== "passive";
}

export function taskRowDisappearsOnCompletion(task: TaskCatalogEntry): boolean {
  return task.rowDisappearsOnCompletion === true;
}

export function taskOutcomeWaitMs(task: TaskCatalogEntry, itemId?: string): number {
  if (task.policy === "passive" && task.navigation === "optional-child") return AGGRESSIVE_TASK_OUTCOME_WAIT_MS;
  return NAVIGATION_OUTCOME_WAIT_MS + (taskRequiresChildNavigation(task, itemId) ? 0 : OPTIONAL_DIRECT_CREDIT_GRACE_MS);
}

export function taskClicksRemaining(task: TaskCatalogEntry, progress?: Progress): number {
  if (progress) return Math.max(0, progress.total - progress.current);
  return Math.max(1, task.drawerClickCount ?? task.goal);
}

export function mostAdvancedTaskProgress(observed?: Progress, recorded?: Progress): Progress | undefined {
  if (!observed) return recorded;
  if (!recorded || observed.total !== recorded.total) return observed;
  return observed.current >= recorded.current ? observed : recorded;
}

export function taskActionAttemptLimit(task: TaskCatalogEntry): number {
  const baseLimit = Math.min(12, Math.max(1, task.drawerClickCount ?? task.goal));
  return Math.min(12, baseLimit + AGGRESSIVE_EXTRA_TASK_ATTEMPTS);
}

export function taskRetriesUntilComplete(task: TaskCatalogEntry): boolean {
  return task.policy === "passive" || task.policy === "surprise";
}

export function taskChildDwellMs(task: TaskCatalogEntry, passiveDwellMs: number, assistedDwellMs: number): number {
  if (task.policy === "assisted") return Math.max(task.minimumDwellMs ?? 0, assistedDwellMs);
  if (task.navigation === "optional-child") {
    return task.minimumDwellMs ? Math.max(task.minimumDwellMs, passiveDwellMs) : OPTIONAL_CHILD_CLOSE_MS;
  }
  return task.minimumDwellMs ? Math.max(task.minimumDwellMs, passiveDwellMs) : 0;
}
