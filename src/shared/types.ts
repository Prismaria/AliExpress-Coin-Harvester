export type RouteKind =
  | "coin-index"
  | "surprise-items"
  | "quiz"
  | "stats"
  | "login"
  | "coin-pc-index"
  | "item"
  | "other";

export type TaskId =
  | "daily_checkin"
  | "sponsored_items"
  | "surprise_items"
  | "recently_viewed"
  | "savings_recap"
  | "super_discounts"
  | "coin_search"
  | "coupons_credits"
  | "prize_land"
  | "merge_boss"
  | "daily_quiz";

export type RunTrigger = "schedule" | "catch-up" | "retry" | "manual";

export type RunState =
  | "queued"
  | "preparing_mobile_tab"
  | "loading_coin_page"
  | "waiting_for_login"
  | "waiting_for_manual_action"
  | "collecting_daily"
  | "opening_task_drawer"
  | "running_tasks"
  | "refreshing_stats"
  | "closing"
  | "succeeded"
  | "partially_succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled"
  | "interrupted";

export type TaskRunState =
  | "pending"
  | "running"
  | "complete"
  | "skipped"
  | "waiting_for_manual_action"
  | "failed";

export type AutomationResult =
  | "success"
  | "already_complete"
  | "not_available"
  | "retryable_error"
  | "login_required"
  | "manual_action_required"
  | "unknown_state"
  | "fatal_error"
  | "clicked"
  | "waiting";

export type CompletionEvidenceKind =
  | "coin-state"
  | "drawer-progress"
  | "drawer-complete"
  | "drawer-disappeared"
  | "mission-completed"
  | "quiz-result"
  | "manual";

export type CompletionEvidence = {
  kind: CompletionEvidenceKind;
  detail: string;
  at: number;
};

export type TaskRun = {
  id: TaskId;
  state: TaskRunState;
  attempts: number;
  attemptsRemaining?: number;
  progressBefore?: Progress;
  progressAfter?: Progress;
  optimisticProgress?: Progress;
  startedAt?: number;
  finishedAt?: number;
  childTabIds: number[];
  closeNotBefore?: number;
  outcomeCheckNotBefore?: number;
  navigationMode?: "new-tab" | "same-tab";
  selectedItemIds: string[];
  completionEvidence?: CompletionEvidence;
  error?: string;
};

export type AutomationRun = {
  id: string;
  trigger: RunTrigger;
  logicalDay: string;
  state: RunState;
  attempt: number;
  executionMode: "parallel" | "sequential";
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  mainTabId?: number;
  mainWindowId?: number;
  currentTaskId?: TaskId;
  taskOrder: TaskId[];
  tasks: Record<TaskId, TaskRun>;
  lastError?: string;
  selectorContractVersion: number;
};

export type AutomationLogLevel = "debug" | "info" | "warn" | "error";

export type AutomationLogEntry = {
  at: number;
  level: AutomationLogLevel;
  event: string;
  message: string;
  runId?: string;
  taskId?: TaskId;
  tabId?: number;
  data?: Record<string, string | number | boolean | null>;
};

export type AutomationSettings = {
  schemaVersion: 5;
  schedule: {
    enabled: boolean;
    localTime: string;
    catchUp: "same-day" | "within-grace" | "never";
    graceMinutes: number;
    retryDelaysMinutes: number[];
    maxAttemptsPerDay: number;
  };
  automation: {
    enabledTaskIds: TaskId[];
    executionMode: "parallel" | "sequential";
    compactWindow: boolean;
    focusManualRuns: boolean;
    focusScheduledRuns: boolean;
    stopOnUnknownTaskState: boolean;
  };
  stats: {
    enabled: boolean;
    refreshMinutes: number;
  };
  notifications: {
    enabled: boolean;
    loginRequired: boolean;
    runCompleted: boolean;
    partialRun: boolean;
    failures: boolean;
  };
  privacy: {
    historyRetentionMonths: number;
    diagnosticsRetentionDays: number;
  };
  timeouts: {
    pageLoadMs: number;
    childCommitMs: number;
    passiveDwellMs: number;
    assistedDwellMs: number;
  };
};

export type AutomationChildTab = {
  tabId: number;
  parentTabId: number;
  windowId?: number;
  taskId: TaskId;
  expectedId: string;
  route?: RouteKind;
  itemId?: string;
  mobile: boolean;
  closeNotBefore?: number;
  closeAlarmName?: string;
  readyAlarmName?: string;
  committedAt?: number;
  contentReady?: boolean;
  controllerStarted?: boolean;
};

export type ExpectedNavigation = {
  id: string;
  runId: string;
  taskId: TaskId;
  sourceTabId: number;
  itemId?: string;
  allowedRoutes: RouteKind[];
  mobile: boolean;
  createdAt: number;
  expiresAt: number;
  itemNavigation?: boolean;
  returnFocusTabId?: number;
  returnFocusWindowId?: number;
  status?: "pending" | "direct-credited";
  launchRuleId?: number;
};

export type AutomationSession = {
  runId: string;
  mainTabId: number;
  mainWindowId?: number;
  mainWindowOwned?: boolean;
  loginAttemptInProgress?: boolean;
  childTabs: Record<string, AutomationChildTab>;
  expectedNavigations: Record<string, ExpectedNavigation>;
};

export type AutomationLease = {
  runId: string;
  token: string;
  expiresAt: number;
};

export type CoinIndexState =
  | "collectable"
  | "task-opener"
  | "already-checked"
  | "login-required"
  | "loading"
  | "unknown";

export type ActionState = "active" | "complete" | "unavailable" | "unknown";

export type Progress = {
  current: number;
  total: number;
};

export type TaskObservation = {
  groupId: string;
  title: string;
  progress?: Progress;
  actionText: string;
  actionState: ActionState;
  completed: boolean;
};

export type CoinIndexObservation = {
  rootFound: boolean;
  loginButtonFound: boolean;
  buttonFound: boolean;
  buttonVisible: boolean;
  buttonHasGeometry: boolean;
  buttonText: string;
  buttonDisabled: boolean;
  currentCardClasses: string;
  state: CoinIndexState;
};

export type LoginPanelStage = "email" | "password" | "challenge" | "closed" | "unknown";

export type LoginPanelObservation = {
  drawerFound: boolean;
  stage: LoginPanelStage;
  accountInputFound: boolean;
  passwordInputFound: boolean;
  continueButtonFound: boolean;
  continueButtonEnabled: boolean;
  signInButtonFound: boolean;
  signInButtonEnabled: boolean;
  challengeDetected: boolean;
};

export type CredentialStatus = {
  saved: boolean;
  username?: string;
};

export type PageObservation = {
  readyState: DocumentReadyState;
  bodyTextLength: number;
  rootFound: boolean;
  signButtonFound: boolean;
};

export type TaskDrawerObservation = {
  found: boolean;
  rowCount: number;
  tasks: TaskObservation[];
};

export type SurpriseObservation = {
  found: boolean;
  cardIds: string[];
  hasCoinAdClickAnchor: boolean;
};

export type QuizObservation = {
  found: boolean;
  question: string;
  options: string[];
};

export type StatsAccountState = "authenticated" | "logged-out" | "empty" | "loading" | "malformed" | "unavailable";

export type StatsSourceKind = "stats-html" | "controlled-tab" | "page-mtop";

export type StatsSource = {
  kind: StatsSourceKind;
  url?: string;
  observedAt: number;
};

export type StatsHistoryCategory = "earned" | "used" | "expired" | "unknown";

export type StatsHistoryEntry = {
  id: string;
  category: StatsHistoryCategory;
  dateLabel?: string;
  dateKey?: string;
  timestamp?: number;
  eventType?: string;
  title: string;
  amountRaw: string;
};

export type StatsHistoryEventType = {
  key: string;
  name: string;
};

export type StatsSnapshot = {
  accountState: StatsAccountState;
  coinCountRaw?: string;
  currentSavingsRaw?: string;
  lifetimeSavingsRaw?: string;
  history: StatsHistoryEntry[];
  historyEventTypes?: {
    earned?: StatsHistoryEventType[];
    used?: StatsHistoryEventType[];
  };
  source: StatsSource;
  stale: boolean;
  warnings: string[];
};

export type StatsParseOptions = {
  rawUrl?: string;
  source?: StatsSourceKind;
  observedAt?: number;
  historyCategory?: StatsHistoryCategory;
};

export type StatsParseResult = {
  snapshot: StatsSnapshot;
};

export type StatsCacheRecord = {
  schemaVersion: 1;
  snapshot: StatsSnapshot;
  fetchedAt?: number;
  checkedAt: number;
};

export type StatsHistoryCacheRecord = {
  schemaVersion: 1;
  entries: StatsHistoryEntry[];
  updatedAt: number;
};

export type DiagnosticsTask = {
  id: TaskId;
  state: TaskRunState;
  attempts: number;
  attemptsRemaining?: number;
  optimisticProgress?: Progress;
  startedAt?: number;
  finishedAt?: number;
  navigationMode?: TaskRun["navigationMode"];
  completionEvidence?: CompletionEvidence;
  error?: string;
};

export type SelectorMismatch = {
  route: RouteKind;
  contract: string;
  observedAt: number;
  detail: string;
};

export type DiagnosticsSnapshot = {
  schemaVersion: 1;
  generatedAt: number;
  run?: {
    id: string;
    logicalDay: string;
    state: RunState;
    trigger: RunTrigger;
    attempt: number;
    executionMode: AutomationRun["executionMode"];
    mainTabId?: number;
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    currentTaskId?: TaskId;
    lastError?: string;
    tasks: DiagnosticsTask[];
  };
  reports: Array<{
    at: number;
    tabId?: number;
    url: string;
    route: RouteKind;
    page: Pick<PageObservation, "readyState" | "bodyTextLength" | "rootFound" | "signButtonFound">;
    environment: {
      navigatorUserAgent: string;
      userAgentData?: {
        mobile?: boolean;
        platform?: string;
        brands?: Array<{ brand: string; version: string }>;
      };
      innerWidth: number;
      innerHeight: number;
      devicePixelRatio: number;
      maxTouchPoints: number;
      hasTouchEvent: boolean;
    };
    coinIndex?: Pick<CoinIndexObservation, "state" | "buttonText" | "buttonDisabled" | "buttonVisible" | "buttonHasGeometry">;
    taskDrawer?: Pick<TaskDrawerObservation, "found" | "rowCount">;
    surprise?: Pick<SurpriseObservation, "found" | "cardIds" | "hasCoinAdClickAnchor">;
    quiz?: Pick<QuizObservation, "found" | "options">;
    stats?: Pick<StatsObservation, "found" | "historyEntryCount">;
    overlays: string[];
  }>;
  selectorMismatches: SelectorMismatch[];
  stats?: {
    accountState: StatsAccountState;
    stale: boolean;
    source: StatsSource;
    historyEntryCount: number;
    warnings: string[];
  };
  logs: Array<{
    at: number;
    level: AutomationLogLevel;
    event: string;
    message: string;
    taskId?: TaskId;
    tabId?: number;
    data?: Record<string, string | number | boolean | null>;
  }>;
};

export type StatsObservation = {
  found: boolean;
  coinCount?: string;
  currentSavings?: string;
  lifetimeSavings?: string;
  historyEntryCount: number;
};

export type PhraseMatch = {
  phrase: string;
  text: string;
  tagName: string;
  id: string;
  className: string;
};

export type Phase0Report = {
  at: number;
  tabId?: number;
  url: string;
  route: RouteKind;
  page: PageObservation;
  environment: {
    navigatorUserAgent: string;
    userAgentData?: {
      mobile?: boolean;
      platform?: string;
      brands?: Array<{ brand: string; version: string }>;
    };
    innerWidth: number;
    innerHeight: number;
    devicePixelRatio: number;
    maxTouchPoints: number;
    hasTouchEvent: boolean;
  };
  coinIndex?: CoinIndexObservation;
  taskDrawer?: TaskDrawerObservation;
  surprise?: SurpriseObservation;
  quiz?: QuizObservation;
  stats?: StatsObservation;
  overlays: PhraseMatch[];
};

export type ProbeSession = {
  id: string;
  tabId: number;
  windowId?: number;
  mobile: boolean;
  ruleId?: number;
  createdAt: number;
  owner?: "manual" | "automation";
  runId?: string;
  role?: "main" | "child";
  loginAutomationState?: "attempting" | "complete" | "manual";
};

export type AutomationContentCommand =
  | { type: "AUTOMATION_COMMAND"; command: "observe-coin" }
  | { type: "AUTOMATION_COMMAND"; command: "sign-in"; username: string; password: string }
  | { type: "AUTOMATION_COMMAND"; command: "collect-daily" }
  | { type: "AUTOMATION_COMMAND"; command: "open-drawer" }
  | { type: "AUTOMATION_COMMAND"; command: "observe-drawer" }
  | { type: "AUTOMATION_COMMAND"; command: "click-task"; taskId: TaskId; mode?: "prepare" | "synthetic" }
  | { type: "AUTOMATION_COMMAND"; command: "run-surprise"; selectedItemIds: string[] }
  | { type: "AUTOMATION_COMMAND"; command: "run-quiz" }
  | { type: "AUTOMATION_COMMAND"; command: "refresh-stats" }
  | { type: "AUTOMATION_COMMAND"; command: "observe-stats" };

export type AutomationLoginFormCommand = {
  type: "AUTOMATION_LOGIN_FORM";
  username: string;
  password: string;
};

export type AutomationContentResponse = {
  ok: boolean;
  operation: string;
  result: AutomationResult;
  error?: string;
  evidence?: CompletionEvidence;
  coinIndex?: CoinIndexObservation;
  loginPanel?: LoginPanelObservation;
  loginFrameRequired?: boolean;
  loginSubmitted?: boolean;
  loginRedirectedToDesktopHome?: boolean;
  taskDrawer?: TaskDrawerObservation;
  surprise?: SurpriseObservation;
  quiz?: QuizObservation;
  stats?: StatsSnapshot;
  clicked?: boolean;
  clickCount?: number;
  clickPoint?: { x: number; y: number };
  clickTarget?: {
    tagName: string;
    className: string;
    text: string;
    role?: string;
  };
};

export type Phase0Message =
  | { type: "PHASE0_OPEN_MOBILE" }
  | { type: "PHASE0_OPEN_URL"; url: string; mobile: boolean; compact: boolean }
  | { type: "PHASE0_CLOSE_MOBILE"; tabId?: number }
  | { type: "PHASE0_GET_STATE" }
  | { type: "PHASE0_CONTENT_READY"; route: RouteKind; url: string }
  | { type: "PHASE0_REPORT"; report: Phase0Report }
  | { type: "STATS_GET_STATE" }
  | { type: "STATS_REFRESH"; force?: boolean }
  | { type: "AUTOMATION_START"; trigger?: RunTrigger }
  | { type: "AUTOMATION_STOP" }
  | { type: "AUTOMATION_RESUME" }
  | { type: "AUTOMATION_VIEW_TAB" }
  | { type: "AUTOMATION_GET_STATE" }
  | { type: "AUTOMATION_SAVE_SETTINGS"; settings: AutomationSettings }
  | { type: "CREDENTIALS_GET_STATUS" }
  | { type: "CREDENTIALS_SAVE"; username: string; password: string }
  | { type: "CREDENTIALS_CLEAR" }
  | { type: "AUTOMATION_CLEAR_LOGS" }
  | { type: "STATS_CLEAR_HISTORY" }
  | { type: "DIAGNOSTICS_CLEAR" }
  | { type: "DIAGNOSTICS_EXPORT" }
  | { type: "AUTOMATION_ARM_NAVIGATION"; taskId: TaskId; itemId?: string }
  | { type: "AUTOMATION_DISARM_NAVIGATION"; expectedId: string }
  | { type: "AUTOMATION_LOGIN_TRUSTED_INPUT"; field: "username" | "password"; value: string }
  | AutomationLoginFormCommand
  | { type: "AUTOMATION_SURPRISE_TRUSTED_CLICK"; itemId: string; round: number; selector: string; x: number; y: number }
  | { type: "AUTOMATION_SURPRISE_CARD_ACCEPTED"; itemId: string }
  | AutomationContentCommand
  | { type: "AUTOMATION_CHILD_FINISHED"; expectedId: string; result: AutomationResult };

export type Phase0Response = {
  ok: boolean;
  error?: string;
  owned?: boolean;
  session?: ProbeSession;
  sessions?: ProbeSession[];
  reports?: Phase0Report[];
  run?: AutomationRun;
  logs?: AutomationLogEntry[];
  settings?: AutomationSettings;
  automation?: AutomationContentResponse;
  expectedId?: string;
  automationSessionActive?: boolean;
  stats?: StatsSnapshot;
  statsRefreshing?: boolean;
  diagnostics?: DiagnosticsSnapshot;
  diagnosticsExport?: string;
  credentialStatus?: CredentialStatus;
};
