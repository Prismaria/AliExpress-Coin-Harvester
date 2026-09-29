export const COIN_INDEX_URL = "https://m.aliexpress.com/p/coin-index/index.html";
export const STATS_URL = "https://www.aliexpress.com/p/coin-pc-index/mycoin.html";
export const ALIEXPRESS_LOGIN_URL = "https://www.aliexpress.com/p/ug-login-page/login.html";
export const STATS_CACHE_KEY = "statsCache";
export const STATS_HISTORY_KEY = "statsHistory";
export const CREDENTIAL_KEY_STORAGE_KEY = "loginCredentialKey";
export const CREDENTIALS_STORAGE_KEY = "loginCredentials";
export const STATS_REFRESH_ALARM_NAME = "stats-refresh";
export const MAX_HISTORY_SCROLL_ROUNDS = 24;
export const HISTORY_NO_GROWTH_LIMIT = 2;
export const NOTIFICATION_ICON_URL =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22128%22%20height%3D%22128%22%20viewBox%3D%220%200%20128%20128%22%3E%3Crect%20width%3D%22128%22%20height%3D%22128%22%20rx%3D%2224%22%20fill%3D%22%23ffc83d%22%2F%3E%3Cpath%20d%3D%22M64%2020l11%2023%2025%204-18%2018%204%2025-22-12-22%2012%204-25-18-18%2025-4z%22%20fill%3D%22%2317130a%22%2F%3E%3C%2Fsvg%3E";
export const POPUP_THEME_KEY = "popupTheme";
export const POPUP_LOGIN_START_SEEN_KEY = "popupLoginStartSeen";
export const ACTION_ICON_PATHS: Record<"light" | "dark", Record<number, string>> = {
  light: {
    16: "icons/icon-light-16.png",
    48: "icons/icon-light-48.png",
    128: "icons/icon-light-128.png"
  },
  dark: {
    16: "icons/icon-dark-16.png",
    48: "icons/icon-dark-48.png",
    128: "icons/icon-dark-128.png"
  }
};

// Keep this in one place so the Phase 0 probe can compare the network identity
// with the JavaScript-visible identity reported by the page.
export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

export const MOBILE_RULE_ID_START = 10_000;
export const AUTOMATION_POPUP_WIDTH = 430;
export const AUTOMATION_POPUP_HEIGHT = 860;
export const AUTOMATION_WINDOW_GAP = 16;
export const MOBILE_SESSION_KEY = "phase0MobileSessions";
export const PHASE0_REPORTS_KEY = "phase0Reports";
export const MAX_STORED_REPORTS = 20;
export const AUTOMATION_SETTINGS_KEY = "automationSettings";
export const AUTOMATION_RUN_KEY = "automationRun";
export const AUTOMATION_LOGS_KEY = "automationLogs";
export const AUTOMATION_SESSION_KEY = "automationSession";
export const AUTOMATION_LEASE_KEY = "automationLease";
export const MAX_AUTOMATION_LOGS = 500;
export const DAILY_ALARM_NAME = "automation-daily-run";
export const RECONCILE_ALARM_NAME = "automation-scheduler-reconcile";
export const CHILD_CLOSE_ALARM_PREFIX = "automation-child-close:";
export const CHILD_READY_WATCHDOG_PREFIX = "automation-child-ready:";
export const TASK_OUTCOME_CHECK_PREFIX = "automation-task-outcome:";
export const NAVIGATION_WATCHDOG_PREFIX = "automation-navigation-watchdog:";
export const OPTIONAL_NAVIGATION_GRACE_PREFIX = "automation-navigation-grace:";
export const CONTROLLED_CHILD_LAUNCH_PREFIX = "automation-controlled-child:";
export const RETRY_ALARM_PREFIX = "automation-retry:";
export const OPTIONAL_CHILD_CLOSE_MS = 1_000;
export const CONTROLLED_CHILD_LAUNCH_DELAY_MS = 500;
export const TASK_ROW_WAIT_MS = 1_000;
export const AUTOMATION_POLL_INTERVAL_MS = 100;
export const DAILY_COLLECT_RETRY_DELAY_MS = 750;
export const POST_CHILD_RESUME_DELAY_MS = 150;
export const SURPRISE_COMPLETION_WAIT_MS = 1_000;
export const NAVIGATION_OUTCOME_WAIT_MS = 20_000;
export const OPTIONAL_DIRECT_CREDIT_GRACE_MS = 15_000;
export const AGGRESSIVE_TASK_OUTCOME_WAIT_MS = 5_000;
export const TASK_DRAWER_CONFIRMATION_WAIT_MS = 30_000;
export const LOGIN_DRAWER_WAIT_MS = 5_000;
export const LOGIN_FLOW_WAIT_MS = 30_000;
export const LOGIN_FORM_FRAME_WAIT_MS = 15_000;
export const AGGRESSIVE_EXTRA_TASK_ATTEMPTS = 3;

export const ALIEXPRESS_RESOURCE_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  "main_frame" as chrome.declarativeNetRequest.ResourceType,
  "sub_frame" as chrome.declarativeNetRequest.ResourceType,
  "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
  "script" as chrome.declarativeNetRequest.ResourceType,
  "stylesheet" as chrome.declarativeNetRequest.ResourceType,
  "image" as chrome.declarativeNetRequest.ResourceType,
  "font" as chrome.declarativeNetRequest.ResourceType,
  "ping" as chrome.declarativeNetRequest.ResourceType,
  "other" as chrome.declarativeNetRequest.ResourceType
];
