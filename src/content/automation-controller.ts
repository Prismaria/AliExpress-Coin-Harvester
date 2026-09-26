import {
  findQuizOption,
  findQuizSuccess,
  findSurpriseCard,
  findSurpriseContinuationTarget,
  findSurpriseCompletion,
  findSurpriseItemId,
  findCoinButton,
  findTaskAction,
  hasClickGeometry,
  isVisible,
  normalizeText,
  observeCoinIndex,
  observeQuiz,
  observeSurprise,
  observeTaskDrawer
} from "./dom-contracts";
import {
  AUTOMATION_POLL_INTERVAL_MS,
  HISTORY_NO_GROWTH_LIMIT,
  MAX_HISTORY_SCROLL_ROUNDS,
  SURPRISE_COMPLETION_WAIT_MS
} from "../shared/constants";
import { historyCategoryFromText, parseStatsDocument } from "./stats-contracts";
import { historyCutoffKey, MAX_STORED_HISTORY_ENTRIES } from "../shared/stats-history";
import type {
  AutomationContentCommand,
  AutomationContentResponse,
  AutomationResult,
  CompletionEvidence,
  Phase0Message,
  Phase0Response,
  StatsHistoryCategory,
  StatsHistoryEntry,
  TaskId
} from "../shared/types";
import { TASK_CATALOG_BY_ID } from "../shared/task-catalog";
import { MTOP_BRIDGE_SOURCE, type MtopBridgeResponse } from "../shared/mtop-stats";

const QUIZ_ANSWERS: Record<string, string> = {
  "how can you access the coins page?": "all of the above"
};

const surpriseChildWaiters = new Map<string, {
  resolve: (result: AutomationResult | undefined) => void;
  timeoutId: number;
}>();
let activeSurpriseController: Promise<AutomationContentResponse> | undefined;
let activeQuizController: Promise<AutomationContentResponse> | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => T, isReady: (value: T) => boolean, timeoutMs = 15_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!isReady(value) && Date.now() < deadline) {
    await delay(AUTOMATION_POLL_INTERVAL_MS);
    value = read();
  }
  return isReady(value) ? value : undefined;
}

function sendWorker(message: Phase0Message): Promise<Phase0Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: Phase0Response | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from service worker" });
    });
  });
}

function waitForSurpriseChild(expectedId: string, timeoutMs = 20_000): Promise<AutomationResult | undefined> {
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      surpriseChildWaiters.delete(expectedId);
      resolve(undefined);
    }, timeoutMs);
    surpriseChildWaiters.set(expectedId, { resolve, timeoutId });
  });
}

function finishSurpriseChildWait(expectedId: string, result?: AutomationResult): void {
  const waiter = surpriseChildWaiters.get(expectedId);
  if (!waiter) return;
  surpriseChildWaiters.delete(expectedId);
  window.clearTimeout(waiter.timeoutId);
  waiter.resolve(result);
}

function evidence(kind: CompletionEvidence["kind"], detail: string): CompletionEvidence {
  return { kind, detail, at: Date.now() };
}

function response(operation: string, result: AutomationResult, extra: Partial<AutomationContentResponse> = {}): AutomationContentResponse {
  return { ok: result === "success" || result === "already_complete" || result === "clicked", operation, result, ...extra };
}

function isDisabled(element: Element): boolean {
  return (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  );
}

function isVerifiedCoinState(state: ReturnType<typeof observeCoinIndex>["state"]): boolean {
  return state === "collectable" || state === "task-opener" || state === "already-checked";
}

function clickPoint(element: Element): { x: number; y: number } | undefined {
  if (!isVisible(element) || isDisabled(element)) return undefined;
  const htmlElement = element as HTMLElement;
  htmlElement.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = htmlElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

async function clickVerified(element: Element, point = clickPoint(element)): Promise<boolean> {
  if (!point) return false;
  const htmlElement = element as HTMLElement;
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    button: 0
  };
  if (typeof PointerEvent !== "undefined") {
    const pointerInit: PointerEventInit = {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };
    htmlElement.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
  }
  htmlElement.dispatchEvent(new MouseEvent("mousedown", eventInit));
  htmlElement.focus?.({ preventScroll: true });
  if (typeof PointerEvent !== "undefined") {
    const pointerInit: PointerEventInit = {
      ...eventInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true
    };
    htmlElement.dispatchEvent(new PointerEvent("pointerup", pointerInit));
  }
  htmlElement.dispatchEvent(new MouseEvent("mouseup", eventInit));
  htmlElement.click();
  return true;
}

async function observeCoin(): Promise<AutomationContentResponse> {
  const observation = await waitFor(
    observeCoinIndex.bind(null, document),
    (value) => value.rootFound && value.buttonFound && isVerifiedCoinState(value.state)
  );
  if (!observation) return response("observe-coin", "retryable_error", { error: "Coin page did not stabilize" });
  return response("observe-coin", "success", { coinIndex: observation });
}

async function collectDaily(): Promise<AutomationContentResponse> {
  const initial = await waitFor(
    observeCoinIndex.bind(null, document),
    (value) => value.rootFound && value.buttonFound && isVerifiedCoinState(value.state)
  );
  if (!initial) return response("collect-daily", "retryable_error", { error: "Coin page did not stabilize" });
  if (initial.state === "already-checked" || initial.state === "task-opener") {
    return response("collect-daily", "already_complete", {
      coinIndex: initial,
      evidence: evidence("coin-state", `Initial state was ${initial.state}`)
    });
  }
  if (initial.state !== "collectable") {
    return response("collect-daily", "unknown_state", { coinIndex: initial, error: "Collect state was not verified" });
  }

  const renderedButton = await waitFor(
    () => findCoinButton(document, true),
    (value) => Boolean(value)
  );
  const button = renderedButton ?? findCoinButton(document);
  if (!button || isDisabled(button) || !/collect/iu.test(normalizeText(button.textContent))) {
    return response("collect-daily", "retryable_error", {
      coinIndex: initial,
      error: "Coin page did not finish rendering a clickable Collect button"
    });
  }
  const clicked = renderedButton
    ? await clickVerified(renderedButton)
    : (() => {
        (button as HTMLButtonElement).click();
        return true;
      })();
  if (!clicked) {
    return response("collect-daily", "unknown_state", { coinIndex: initial, error: "Collect button was not safely clickable" });
  }

  const after = await waitFor(
    observeCoinIndex.bind(null, document),
    (value) => value.state === "task-opener" || value.state === "already-checked",
    15_000
  );
  if (!after) return response("collect-daily", "retryable_error", { error: "Collect did not produce checked-state evidence" });
  return response("collect-daily", "success", {
    coinIndex: after,
    evidence: evidence("coin-state", `Collect transitioned to ${after.state}`)
  });
}

async function openDrawer(): Promise<AutomationContentResponse> {
  const immediate = observeTaskDrawer(document);
  if (immediate.found) {
    const existing = await stableTaskDrawer();
    return response("open-drawer", "success", { taskDrawer: existing });
  }

  const coin = await waitFor(
    observeCoinIndex.bind(null, document),
    (value) => value.rootFound && value.buttonFound && isVerifiedCoinState(value.state)
  );
  if (!coin) return response("open-drawer", "retryable_error", { error: "Coin page did not expose a verified task opener" });
  if (coin.state !== "task-opener" && coin.state !== "already-checked") {
    return response("open-drawer", "unknown_state", { coinIndex: coin, error: "Task opener state was not verified" });
  }
  const renderedButton = await waitFor(
    () => findCoinButton(document, true),
    (value) => Boolean(value)
  );
  const button = renderedButton ?? findCoinButton(document);
  if (!button || isDisabled(button) || !isVisible(button)) {
    return response("open-drawer", "retryable_error", {
      coinIndex: coin,
      error: "Task opener did not finish rendering a visible clickable button"
    });
  }
  const clicked = renderedButton
    ? await clickVerified(renderedButton)
    : (() => {
        // The compact scheduled window can report zero layout geometry while
        // still exposing a visible, enabled React button.
        (button as HTMLButtonElement).click();
        return true;
      })();
  if (!clicked) return response("open-drawer", "retryable_error", { coinIndex: coin, error: "Task opener was not safely clickable" });

  const drawer = await stableTaskDrawer(15_000);
  if (!drawer.found) return response("open-drawer", "unknown_state", { error: "Task drawer did not appear" });
  return response("open-drawer", "success", { taskDrawer: drawer });
}

async function observeDrawer(): Promise<AutomationContentResponse> {
  const drawer = await stableTaskDrawer();
  if (!drawer.found) return response("observe-drawer", "retryable_error", { error: "Task drawer was not found" });
  return response("observe-drawer", "success", { taskDrawer: drawer });
}

function drawerFingerprint(drawer: ReturnType<typeof observeTaskDrawer>): string {
  return JSON.stringify(drawer.tasks.map((task) => [
    task.groupId,
    task.actionState,
    task.actionText,
    task.completed,
    task.progress?.current,
    task.progress?.total
  ]));
}

async function stableTaskDrawer(timeoutMs = 3_000): Promise<ReturnType<typeof observeTaskDrawer>> {
  const deadline = Date.now() + timeoutMs;
  let latest = observeTaskDrawer(document);
  let fingerprint = latest.found ? drawerFingerprint(latest) : "";
  let stableReads = latest.found ? 1 : 0;
  while (Date.now() < deadline) {
    await delay(AUTOMATION_POLL_INTERVAL_MS);
    latest = observeTaskDrawer(document);
    const nextFingerprint = latest.found ? drawerFingerprint(latest) : "";
    stableReads = nextFingerprint && nextFingerprint === fingerprint ? stableReads + 1 : nextFingerprint ? 1 : 0;
    fingerprint = nextFingerprint;
    if (stableReads >= 2) return latest;
  }
  return latest;
}

async function clickTask(taskId: TaskId, mode: "prepare" | "synthetic" = "prepare"): Promise<AutomationContentResponse> {
  const catalogEntry = TASK_CATALOG_BY_ID[taskId];
  const drawer = await stableTaskDrawer();
  const task = drawer.tasks.find((candidate) => candidate.groupId === catalogEntry.groupId);
  if (!task) {
    return response("click-task", "unknown_state", { taskDrawer: drawer, error: `Task ${taskId} is not in the drawer` });
  }
  if (task.completed) {
    return response("click-task", "already_complete", {
      taskDrawer: drawer,
      evidence: evidence("drawer-complete", `${taskId} was already complete`)
    });
  }
  if (task.actionState !== "active" || task.actionText !== "go") {
    return response("click-task", "manual_action_required", {
      taskDrawer: drawer,
      error: `Task ${taskId} action was ${task.actionState}`
    });
  }

  const action = findTaskAction(document, task.groupId);
  const point = action ? clickPoint(action) : undefined;
  if (!action || !point) {
    return response("click-task", "unknown_state", { taskDrawer: drawer, error: "Task action was not safely clickable" });
  }
  if (mode === "synthetic" && !(await clickVerified(action, point))) {
    return response("click-task", "unknown_state", { taskDrawer: drawer, error: "Task action was not safely clickable" });
  }

  return response("click-task", "clicked", {
    taskDrawer: drawer,
    clicked: mode === "synthetic",
    clickCount: 1,
    clickPoint: point,
    clickTarget: {
      tagName: action.tagName.toLocaleLowerCase(),
      className: typeof action.className === "string" ? action.className : "",
      text: normalizeText(action.textContent),
      role: action.getAttribute("role") ?? undefined
    }
  });
}

function surpriseCardReady(card: Element | undefined): boolean {
  if (!card || !isVisible(card)) return false;
  return hasClickGeometry(card.querySelector(".product-click") ?? undefined) || hasClickGeometry(card);
}

type SurpriseClickCandidate = {
  selector: string;
  element: Element;
};

function surpriseClickCandidates(card: Element): SurpriseClickCandidate[] {
  const selectors = [
    ".product-click",
    "a[href]",
    "[role='button']",
    ".product-cover",
    ".product-cover-img",
    ".product-sale-info-group",
    ".product-title-name"
  ];
  const candidates: SurpriseClickCandidate[] = [];
  const seen = new Set<Element>();
  for (const selector of selectors) {
    const element = card.querySelector(selector);
    if (!element || seen.has(element)) continue;
    seen.add(element);
    candidates.push({ selector, element });
  }
  if (!seen.has(card)) candidates.push({ selector: ".feeds-discount-card", element: card });
  return candidates;
}

async function clickSurpriseCard(card: Element, itemId: string, round: number): Promise<boolean> {
  const candidates = surpriseClickCandidates(card);
  const usable = candidates.filter((candidate) => hasClickGeometry(candidate.element));
  const target = usable[0];
  if (!target) return false;
  const destinationItemId = findSurpriseItemId(card);
  const armed = await sendWorker({ type: "AUTOMATION_ARM_NAVIGATION", taskId: "surprise_items", itemId: destinationItemId });
  if (!armed.ok || !armed.expectedId) return false;
  const childFinished = waitForSurpriseChild(armed.expectedId);
  const clicked = await trustedClickElement(target.element, itemId, round, target.selector);
  if (!clicked) {
    finishSurpriseChildWait(armed.expectedId);
    await sendWorker({ type: "AUTOMATION_DISARM_NAVIGATION", expectedId: armed.expectedId });
    return false;
  }
  const result = await childFinished;
  if (result === undefined) await sendWorker({ type: "AUTOMATION_DISARM_NAVIGATION", expectedId: armed.expectedId });
  return result === "success";
}

async function trustedClickElement(element: Element, itemId: string, round: number, selector: string): Promise<boolean> {
  element.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = (element as HTMLElement).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
  const x = Math.min(window.innerWidth - 1, Math.max(1, rect.left + rect.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(1, rect.top + rect.height / 2));
  const trusted = await sendWorker({
    type: "AUTOMATION_SURPRISE_TRUSTED_CLICK",
    itemId,
    round,
    selector,
    x,
    y
  });
  return trusted.ok;
}

type SurpriseRoundState =
  | { kind: "complete"; evidence: NonNullable<ReturnType<typeof findSurpriseCompletion>> }
  | { kind: "next-round"; overlay: Element };

async function waitForSurpriseRoundState(timeoutMs = 15_000): Promise<SurpriseRoundState | undefined> {
  return waitFor(
    () => {
      const completion = findSurpriseCompletion(document);
      if (completion) return { kind: "complete", evidence: completion } satisfies SurpriseRoundState;
      const overlay = findSurpriseContinuationTarget(document);
      return overlay ? { kind: "next-round", overlay } satisfies SurpriseRoundState : undefined;
    },
    (state): state is SurpriseRoundState => Boolean(state),
    timeoutMs
  );
}

async function continueSurpriseRound(round: number, initialOverlay: Element): Promise<"continued" | "complete" | "retry"> {
  let overlay: Element | undefined = initialOverlay;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const completed = findSurpriseCompletion(document);
    if (completed) return "complete";
    overlay ??= findSurpriseContinuationTarget(document);
    if (!overlay) return "continued";

    await trustedClickElement(overlay, "next-round", round, ".aecoin-next-round");
    await delay(300);
    const stillVisible = findSurpriseContinuationTarget(document);
    if (stillVisible) {
      await clickVerified(stillVisible);
      const dialog = findSurpriseContinuationTarget(document)?.closest('[class*="aecoin-awardDialog-"]');
      if (dialog && dialog !== stillVisible) await clickVerified(dialog);
      await delay(300);
    }
    overlay = findSurpriseContinuationTarget(document);
  }
  return "retry";
}

async function runSurprise(selectedItemIds: string[]): Promise<AutomationContentResponse> {
  const selected = new Set(selectedItemIds);
  for (let round = 0; ; round += 1) {
    const alreadyCompleted = findSurpriseCompletion(document);
    if (alreadyCompleted) {
      return response("run-surprise", "success", {
        evidence: evidence("mission-completed", alreadyCompleted.text)
      });
    }
    const existingContinuation = findSurpriseContinuationTarget(document);
    if (existingContinuation) {
      const continuation = await continueSurpriseRound(round + 1, existingContinuation);
      if (continuation === "complete") {
        const completed = findSurpriseCompletion(document);
        return response("run-surprise", "success", {
          evidence: evidence("mission-completed", completed?.text ?? "mission completed")
        });
      }
      if (continuation === "retry") {
        return response("run-surprise", "retryable_error", { error: "Next-round overlay remained after repeated trusted and synthetic clicks" });
      }
      continue;
    }
    const observation = await waitFor(
      () => observeSurprise(document, "surprise-items"),
      (value) => value.found && value.cardIds.some((id) => !selected.has(id)),
      20_000
    );
    if (!observation) {
      return response("run-surprise", "retryable_error", { error: "No unused surprise cards are currently available" });
    }

    const cardIds = observation.cardIds.filter((id) => !selected.has(id));
    const itemResults: Array<{ itemId: string; result: AutomationResult; error?: string }> = [];
    let acceptedThisRound = 0;
    let continued = false;
    for (const itemId of cardIds) {
      const earlyState = await waitForSurpriseRoundState(0);
      if (earlyState?.kind === "complete") {
        return response("run-surprise", "success", {
          evidence: evidence("mission-completed", earlyState.evidence.text)
        });
      }
      if (earlyState?.kind === "next-round") {
        const continuation = await continueSurpriseRound(round + 1, earlyState.overlay);
        if (continuation === "complete") {
          const completed = findSurpriseCompletion(document);
          return response("run-surprise", "success", {
            evidence: evidence("mission-completed", completed?.text ?? "mission completed")
          });
        }
        if (continuation === "retry") {
          return response("run-surprise", "retryable_error", { error: "Next-round overlay remained after repeated trusted and synthetic clicks" });
        }
        continued = true;
        break;
      }
      const card = await waitFor(
        () => findSurpriseCard(document, itemId),
        (candidate) => surpriseCardReady(candidate),
        10_000
      );
      if (!card) {
        itemResults.push({ itemId, result: "unknown_state", error: `Surprise card ${itemId} was not clickable` });
        continue;
      }
      if (!(await clickSurpriseCard(card, itemId, round + 1))) {
        const completed = await waitFor(() => findSurpriseCompletion(document), Boolean, SURPRISE_COMPLETION_WAIT_MS);
        if (completed) {
          return response("run-surprise", "success", {
            evidence: evidence("mission-completed", completed.text)
          });
        }
        itemResults.push({ itemId, result: "unknown_state", error: `Surprise card ${itemId} failed safe click validation` });
        continue;
      }
      itemResults.push({ itemId, result: "success" });
      const accepted = await sendWorker({ type: "AUTOMATION_SURPRISE_CARD_ACCEPTED", itemId });
      if (!accepted.ok) {
        return response("run-surprise", "retryable_error", { error: accepted.error ?? `Could not persist accepted item ${itemId}` });
      }
      selected.add(itemId);
      acceptedThisRound += 1;
      const state = await waitForSurpriseRoundState(SURPRISE_COMPLETION_WAIT_MS);
      if (state?.kind === "complete") {
        return response("run-surprise", "success", {
          evidence: evidence("mission-completed", state.evidence.text)
        });
      }
      if (state?.kind === "next-round") {
        const continuation = await continueSurpriseRound(round + 1, state.overlay);
        if (continuation === "complete") {
          const completed = findSurpriseCompletion(document);
          return response("run-surprise", "success", {
            evidence: evidence("mission-completed", completed?.text ?? "mission completed")
          });
        }
        if (continuation === "retry") {
          return response("run-surprise", "retryable_error", { error: "Next-round overlay remained after repeated trusted and synthetic clicks" });
        }
        continued = true;
        break;
      }
      if (acceptedThisRound >= 3) break;
    }

    if (continued) continue;
    const failedItem = itemResults.find((item) => item.result !== "success");
    if (failedItem && acceptedThisRound < 3) {
      const completed = await waitFor(() => findSurpriseCompletion(document), Boolean, SURPRISE_COMPLETION_WAIT_MS);
      if (completed) {
        return response("run-surprise", "success", {
          evidence: evidence("mission-completed", completed.text)
        });
      }
      return response("run-surprise", "retryable_error", { error: failedItem.error ?? `Item ${failedItem.itemId} was not completed` });
    }

    const roundState = await waitForSurpriseRoundState();
    if (!roundState) {
      return response("run-surprise", "retryable_error", { error: "Neither next-round nor mission-complete evidence was observed" });
    }
    if (roundState.kind === "complete") {
      return response("run-surprise", "success", {
        evidence: evidence("mission-completed", roundState.evidence.text)
      });
    }
    const continuation = await continueSurpriseRound(round + 1, roundState.overlay);
    if (continuation === "complete") {
      const completed = findSurpriseCompletion(document);
      return response("run-surprise", "success", {
        evidence: evidence("mission-completed", completed?.text ?? "mission completed")
      });
    }
    if (continuation === "retry") {
      return response("run-surprise", "retryable_error", { error: "Next-round overlay remained after repeated trusted and synthetic clicks" });
    }
  }
}

async function runQuiz(): Promise<AutomationContentResponse> {
  const quiz = await waitFor(observeQuiz.bind(null, document), (value) => value.found, 15_000);
  if (!quiz) return response("run-quiz", "retryable_error", { error: "Quiz did not appear" });
  const answer = QUIZ_ANSWERS[quiz.question];
  if (!answer) {
    return response("run-quiz", "manual_action_required", {
      quiz,
      error: "Unknown quiz question; no answer was guessed"
    });
  }
  const option = findQuizOption(document, answer);
  if (!option || !(await clickVerified(option))) {
    return response("run-quiz", "unknown_state", { quiz, error: "Mapped quiz option was not safely clickable" });
  }
  const success = await waitFor(() => findQuizSuccess(document), Boolean, 15_000);
  if (!success) return response("run-quiz", "manual_action_required", { quiz, error: "Quiz result evidence was not observed" });
  return response("run-quiz", "success", {
    quiz,
    evidence: evidence("quiz-result", success.text)
  });
}

function historyFingerprint(entries: StatsHistoryEntry[]): string {
  return entries.map((entry) => `${entry.id}:${entry.dateKey ?? ""}`).join(";");
}

function historyTabSelected(tab: Element): boolean {
  const owner = tab.closest("[role=tab], button, [aria-selected]") ?? tab;
  return owner.getAttribute("aria-selected") === "true" || /(?:active|selected)/iu.test(owner.className.toString());
}

function historyEndReached(): boolean {
  const footer = document.querySelector(".coin-history-content-data-list-footer");
  if (!footer || !isVisible(footer)) return false;
  return /end|no more|no data|no records/u.test(normalizeText(footer.textContent));
}

function scrollHistoryList(): void {
  const list = document.querySelector<HTMLElement>(".coin-history-content-data-list");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
  list.dispatchEvent(new Event("scroll", { bubbles: true }));
  const rows = [...list.querySelectorAll<HTMLElement>(".data-history-item-content")];
  rows.at(-1)?.scrollIntoView?.({ block: "end", inline: "nearest" });
}

async function collectHistoryCategory(category: StatsHistoryCategory, tab?: Element): Promise<StatsHistoryEntry[]> {
  const before = parseStatsDocument(document, { rawUrl: location.href, source: "controlled-tab" }).snapshot.history;
  if (tab && !historyTabSelected(tab)) {
    if (!(await clickVerified(tab))) return [];
    await waitFor(
      () => ({ selected: historyTabSelected(tab), fingerprint: historyFingerprint(parseStatsDocument(document, { rawUrl: location.href, source: "controlled-tab", historyCategory: category }).snapshot.history) }),
      (value) => value.selected || value.fingerprint !== historyFingerprint(before),
      5_000
    );
  }

  let previousFingerprint = "";
  let noGrowth = 0;
  let entries: StatsHistoryEntry[] = [];
  const cutoff = historyCutoffKey();
  for (let round = 0; round < MAX_HISTORY_SCROLL_ROUNDS; round += 1) {
    entries = parseStatsDocument(document, { rawUrl: location.href, source: "controlled-tab", historyCategory: category }).snapshot.history
      .slice(0, MAX_STORED_HISTORY_ENTRIES);
    const fingerprint = historyFingerprint(entries);
    if (fingerprint === previousFingerprint) noGrowth += 1;
    else noGrowth = 0;
    previousFingerprint = fingerprint;

    if (entries.some((entry) => entry.dateKey !== undefined && entry.dateKey < cutoff) || historyEndReached() || noGrowth >= HISTORY_NO_GROWTH_LIMIT || entries.length >= MAX_STORED_HISTORY_ENTRIES) {
      break;
    }
    scrollHistoryList();
    await delay(250);
  }
  return entries;
}

async function collectAllHistory(): Promise<StatsHistoryEntry[]> {
  const tabs = [...document.querySelectorAll(".coin-history-content-tab-text")]
    .map((element) => ({ element, category: historyCategoryFromText(element.textContent) }))
    .filter(({ category }) => category !== "unknown")
    .filter((candidate, index, all) => all.findIndex((other) => other.category === candidate.category) === index);

  if (!tabs.length) return collectHistoryCategory("unknown");
  const entries: StatsHistoryEntry[] = [];
  for (const tab of tabs) entries.push(...await collectHistoryCategory(tab.category, tab.element));
  return entries.length ? entries : collectHistoryCategory("unknown");
}

async function observeStatsPage(): Promise<AutomationContentResponse> {
  let emptySince: number | undefined;
  const parsed = await waitFor(
    () => {
      const value = parseStatsDocument(document, { rawUrl: location.href, source: "controlled-tab" });
      if (value.snapshot.accountState === "empty") emptySince ??= Date.now();
      else emptySince = undefined;
      return value;
    },
    (value) =>
      ["authenticated", "logged-out"].includes(value.snapshot.accountState) ||
      (value.snapshot.accountState === "empty" && emptySince !== undefined && Date.now() - emptySince >= 1_000),
    20_000
  );
  const snapshot = parsed?.snapshot ?? parseStatsDocument(document, { rawUrl: location.href, source: "controlled-tab" }).snapshot;
  if (snapshot.accountState === "logged-out") {
    return response("observe-stats", "login_required", { stats: snapshot, error: "Stats page redirected to login" });
  }
  if (snapshot.accountState !== "authenticated" && snapshot.accountState !== "empty") {
    return response("observe-stats", "retryable_error", { stats: snapshot, error: "Stats page did not produce a usable snapshot" });
  }
  const history = await collectAllHistory();
  return response("observe-stats", "success", { stats: { ...snapshot, history: history.length ? history : snapshot.history } });
}

function requestPageMtopSnapshot(): Promise<NonNullable<AutomationContentResponse["stats"]>> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const value = event.data as Partial<MtopBridgeResponse> | undefined;
      if (
        value?.source !== MTOP_BRIDGE_SOURCE ||
        value.type !== "ALI_COIN_MTOP_RESPONSE" ||
        value.requestId !== requestId
      ) return;

      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (value.ok && value.snapshot) resolve(value.snapshot);
      else reject(new Error(value.error ?? "The page-context MTop bridge returned no snapshot"));
    };
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("The page-context MTop bridge timed out"));
    }, 100_000);

    window.addEventListener("message", onMessage);
    window.postMessage({
      source: MTOP_BRIDGE_SOURCE,
      type: "ALI_COIN_MTOP_REQUEST",
      requestId
    }, window.location.origin);
  });
}

async function refreshStatsPageContext(): Promise<AutomationContentResponse> {
  try {
    const snapshot = await requestPageMtopSnapshot();
    if (snapshot.accountState === "logged-out") {
      return response("refresh-stats", "login_required", { stats: snapshot, error: "MTop reported a logged-out account" });
    }
    if (![
      "authenticated",
      "logged-out",
      "empty"
    ].includes(snapshot.accountState)) {
      return response("refresh-stats", "retryable_error", { stats: snapshot, error: "MTop did not produce a usable snapshot" });
    }
    return response("refresh-stats", "success", { stats: snapshot });
  } catch (error) {
    return response("refresh-stats", "retryable_error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleCommand(command: AutomationContentCommand): Promise<AutomationContentResponse> {
  switch (command.command) {
    case "observe-coin":
      return observeCoin();
    case "collect-daily":
      return collectDaily();
    case "open-drawer":
      return openDrawer();
    case "observe-drawer":
      return observeDrawer();
    case "click-task":
      return clickTask(command.taskId, command.mode);
    case "run-surprise":
      activeSurpriseController ??= runSurprise(command.selectedItemIds).finally(() => {
        activeSurpriseController = undefined;
      });
      return activeSurpriseController;
    case "run-quiz":
      activeQuizController ??= runQuiz().finally(() => {
        activeQuizController = undefined;
      });
      return activeQuizController;
    case "refresh-stats":
      return refreshStatsPageContext();
    case "observe-stats":
      return observeStatsPage();
  }
}

chrome.runtime.onMessage.addListener((message: Phase0Message, _sender, sendResponse) => {
  if (message.type === "AUTOMATION_CHILD_FINISHED") {
    finishSurpriseChildWait(message.expectedId, message.result);
    return false;
  }
  if (message.type !== "AUTOMATION_COMMAND") return false;
  void handleCommand(message)
    .then(sendResponse)
    .catch((error: unknown) => sendResponse(response("command", "fatal_error", { error: error instanceof Error ? error.message : String(error) })));
  return true;
});
