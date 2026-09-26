import type { RouteKind } from "./types";

export function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export function isAliExpressPageUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "https:" && ["m.aliexpress.com", "www.aliexpress.com"].includes(url.hostname)) ||
      (url.protocol === "http:" && url.hostname === "best.aliexpress.com")
    );
  } catch {
    return false;
  }
}

export function classifyRoute(rawUrl: string): RouteKind {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLocaleLowerCase();

    if (path.endsWith("/p/coin-index/index.html")) return "coin-index";
    if (path.endsWith("/p/coin-index/adclick.html")) return "surprise-items";
    if (path.endsWith("/p/coin-index/coinquest.html")) return "quiz";
    if (path.endsWith("/p/coin-pc-index/mycoin.html")) return "stats";
    if (path.includes("/p/ug-login-page/login.html")) return "login";
    if (path.includes("/p/coin-pc-index/")) return "coin-pc-index";
    if (path.startsWith("/item/")) return "item";
    return "other";
  } catch {
    return "other";
  }
}

export function isAllowedProbeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "m.aliexpress.com" && url.hostname !== "www.aliexpress.com") return false;
    return (
      url.pathname.startsWith("/p/coin-index/") ||
      url.pathname.startsWith("/p/coin-pc-index/") ||
      url.pathname.startsWith("/p/coin-search/") ||
      url.pathname.startsWith("/p/merge-market/") ||
      url.pathname.startsWith("/p/ug-login-page/") ||
      url.pathname.startsWith("/ssr/300000949/") ||
      url.pathname.startsWith("/item/")
    );
  } catch {
    return false;
  }
}

export function routeNeedsMobileIdentity(route: RouteKind): boolean {
  return route === "coin-index" || route === "surprise-items" || route === "quiz";
}
