import type {
  CoinIndexObservation,
  LoginPanelObservation,
  LoginPanelStage,
  PhraseMatch,
  Progress,
  QuizObservation,
  RouteKind,
  StatsObservation,
  SurpriseObservation,
  TaskDrawerObservation,
  TaskObservation
} from "../shared/types";
import { classifyRoute } from "../shared/routes";
export { classifyRoute } from "../shared/routes";

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

export function compactText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function observePage(document: Document) {
  return {
    readyState: document.readyState,
    bodyTextLength: compactText(document.body?.textContent).length,
    rootFound: Boolean(document.querySelector("#root")),
    signButtonFound: Boolean(document.querySelector("button#signButton"))
  };
}

function hasHiddenAttribute(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden")) return true;
    if (current.getAttribute("aria-hidden") === "true") return true;

    const style = current.getAttribute("style")?.toLocaleLowerCase() ?? "";
    if (
      /(?:^|;)\s*display\s*:\s*none\b/u.test(style) ||
      /(?:^|;)\s*visibility\s*:\s*hidden\b/u.test(style) ||
      /(?:^|;)\s*opacity\s*:\s*0(?:\D|$)/u.test(style)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

export function isVisible(element: Element): boolean {
  if (hasHiddenAttribute(element)) return false;

  const ownerWindow = element.ownerDocument.defaultView;
  if (ownerWindow) {
    let current: Element | null = element;
    while (current) {
      const computed = ownerWindow.getComputedStyle(current);
      if (computed.display === "none" || computed.visibility === "hidden" || computed.opacity === "0") {
        return false;
      }
      current = current.parentElement;
    }
  }

  // JSDOM has no layout engine, so geometry is intentionally not required here.
  // Live controllers add a geometry check immediately before clicking.
  return true;
}

export function hasClickGeometry(element: Element | undefined): boolean {
  if (!element || !isVisible(element)) return false;
  const rect = (element as HTMLElement).getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function findCoinButton(document: Document, requireGeometry = false): HTMLButtonElement | undefined {
  const buttons = [...document.querySelectorAll("button#signButton")] as HTMLButtonElement[];
  const visible = buttons.filter((button) => isVisible(button));
  const enabled = visible.find((button) => !isDisabled(button));
  if (!requireGeometry) return enabled ?? visible[0] ?? buttons[0];
  return visible.find((button) => !isDisabled(button) && hasClickGeometry(button));
}

function isDisabled(element: Element): boolean {
  return (
    (element as HTMLButtonElement).disabled === true ||
    element.getAttribute("aria-disabled") === "true"
  );
}

function parseProgress(value: string): Progress | undefined {
  const match = value.match(/(\d+)\s*\/\s*(\d+)/u);
  if (!match) return undefined;
  const total = Number(match[2]);
  if (total <= 0) return undefined;
  return { current: Number(match[1]), total };
}

const COMPLETED_TASK_BUTTON_ASSET = "s8b875cee0b02476e96ddebfedef1fc07v.png";

function actionHasCompletionAsset(action: Element): boolean {
  const style = action.getAttribute("style")?.toLocaleLowerCase() ?? "";
  return style.includes(COMPLETED_TASK_BUTTON_ASSET);
}

function actionIsCompleted(action: Element): boolean {
  return actionHasCompletionAsset(action);
}

export function observeCoinIndex(document: Document): CoinIndexObservation {
  const root = document.querySelector('#root [data-version="daily"]');
  const loginButton = document.querySelector(".aecoin-loginButtonContainer-2rtjc button.aecoin-loginButton-3pcZm");
  const button = findCoinButton(document);
  const currentCard = document.querySelector("#sign-main-card");
  const buttonText = normalizeText(button?.textContent);
  const buttonDisabled = button ? isDisabled(button) : false;
  const buttonVisible = button ? isVisible(button) : false;
  const buttonHasGeometry = button ? hasClickGeometry(button) : false;
  const currentCardClasses = currentCard?.className?.toString() ?? "";
  const unchecked = /today-unchecked-/u.test(currentCardClasses);
  const checked = /today-(?:checked|checkedin|complete)/iu.test(currentCardClasses);
  const taskButton = /taskbutton-/iu.test(currentCardClasses) || /earn more coins/u.test(buttonText);
  const collectButton = /checkinbutton-/iu.test(button?.className ?? "") || /collect/u.test(buttonText);

  let state: CoinIndexObservation["state"] = "loading";
  if (loginButton) state = "login-required";
  else if (!root) state = "unknown";
  else if (button && !buttonDisabled && currentCard && checked && taskButton) state = "already-checked";
  else if (button && !buttonDisabled && taskButton) state = "task-opener";
  else if (button && !buttonDisabled && (unchecked || collectButton)) state = "collectable";
  else if (root && button) state = "unknown";

  return {
    rootFound: Boolean(root),
    loginButtonFound: Boolean(loginButton),
    buttonFound: Boolean(button),
    buttonVisible,
    buttonHasGeometry,
    buttonText,
    buttonDisabled,
    currentCardClasses,
    state
  };
}

function findLoginDrawer(document: Document): Element | undefined {
  const drawers = [
    ...document.querySelectorAll(".cosmos-drawer-right .cosmos-drawer-body"),
    ...document.querySelectorAll(".cosmos-drawer-right .cosmos-drawer-content"),
    ...document.querySelectorAll(".cosmos-drawer-right")
  ];
  const drawer = drawers.find((candidate) => isVisible(candidate));
  if (drawer) return drawer;

  // The standalone login document can render its form without the drawer wrapper.
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some((input) => isVisible(input));
  const signInActionVisible = [...document.querySelectorAll("button")].some((button) =>
    isVisible(button) && normalizeText(button.getAttribute("aria-label") || button.textContent) === "sign in"
  );
  const accountVisible = [...document.querySelectorAll('input[autocomplete~="username"], input[name="account"], input[aria-label="Email or phone number"]')]
    .some((input) => isVisible(input));
  const continueActionVisible = [...document.querySelectorAll("button")].some((button) =>
    isVisible(button) && normalizeText(button.getAttribute("aria-label") || button.textContent) === "continue"
  );
  return (passwordVisible && signInActionVisible) || (accountVisible && continueActionVisible)
    ? document.body ?? undefined
    : undefined;
}

export function findLoginAccountInput(document: Document): HTMLInputElement | undefined {
  const drawer = findLoginDrawer(document);
  if (!drawer) return undefined;
  const inputs = [...drawer.querySelectorAll("input")].filter((input) => isVisible(input)) as HTMLInputElement[];
  return inputs.find((input) => input.matches('input[autocomplete~="username"], input[name="account"], input[aria-label="Email or phone number"]'));
}

export function findLoginPasswordInput(document: Document): HTMLInputElement | undefined {
  const drawer = findLoginDrawer(document);
  if (!drawer) return undefined;
  const inputs = [...drawer.querySelectorAll("input")].filter((input) => isVisible(input)) as HTMLInputElement[];
  return inputs.find((input) => input.matches('#fm-history-login-password, input[name="fm-history-login-password"]')) ??
    inputs.find((input) => input.matches('input[type="password"]'));
}

export function findLoginActionButton(document: Document, action: "continue" | "sign in"): HTMLButtonElement | undefined {
  const drawer = findLoginDrawer(document);
  if (!drawer) return undefined;
  return [...drawer.querySelectorAll("button")]
    .filter((button) => isVisible(button))
    .find((button) => normalizeText(button.getAttribute("aria-label") || button.textContent) === action) as HTMLButtonElement | undefined;
}

function hasActiveLoginChallenge(drawer: Element): boolean {
  if ([...drawer.querySelectorAll('input[autocomplete~="one-time-code"], input[aria-label*="verification code" i], input[aria-label*="security code" i], input[aria-label*="email code" i], input[aria-label*="SMS code" i]')].some((input) => isVisible(input))) {
    return true;
  }
  const captcha = drawer.querySelector("#baxia-login-check-code");
  if (captcha && isVisible(captcha) && (captcha.children.length > 0 || compactText(captcha.textContent))) return true;
  const headings = [...drawer.querySelectorAll('h1, h2, [role="heading"]')]
    .filter((heading) => isVisible(heading))
    .map((heading) => normalizeText(heading.textContent));
  return headings.some((heading) => /(?:verification|security check|verify it's you|enter.*code)/u.test(heading));
}

export function observeLoginPanel(document: Document): LoginPanelObservation {
  const drawer = findLoginDrawer(document);
  if (!drawer) {
    return {
      drawerFound: false,
      stage: "closed",
      accountInputFound: false,
      passwordInputFound: false,
      continueButtonFound: false,
      continueButtonEnabled: false,
      signInButtonFound: false,
      signInButtonEnabled: false,
      challengeDetected: false
    };
  }

  const account = findLoginAccountInput(document);
  const password = findLoginPasswordInput(document);
  const continueButton = findLoginActionButton(document, "continue");
  const signInButton = findLoginActionButton(document, "sign in");
  const challengeDetected = hasActiveLoginChallenge(drawer);
  let stage: LoginPanelStage = "unknown";
  if (challengeDetected) stage = "challenge";
  else if (password) stage = "password";
  else if (account) stage = "email";

  return {
    drawerFound: true,
    stage,
    accountInputFound: Boolean(account),
    passwordInputFound: Boolean(password),
    continueButtonFound: Boolean(continueButton),
    continueButtonEnabled: Boolean(continueButton && !isDisabled(continueButton)),
    signInButtonFound: Boolean(signInButton),
    signInButtonEnabled: Boolean(signInButton && !isDisabled(signInButton)),
    challengeDetected
  };
}

export function findSurpriseCard(document: Document, itemId: string): Element | undefined {
  const list = document.querySelector('.product-list[data-spm="coinsWaterFall"]');
  const card = [...(list?.querySelectorAll('.feeds-discount-card.ad-product[data-id]') ?? [])].find(
    (candidate) => candidate.getAttribute("data-id") === itemId
  );
  return card && isVisible(card) ? card : undefined;
}

export function findSurpriseItemId(card: Element): string | undefined {
  const links = [
    ...(card.matches("[href]") ? [card] : []),
    ...card.querySelectorAll("[href]")
  ];
  for (const link of links) {
    try {
      const url = new URL(link.getAttribute("href") ?? "", card.ownerDocument.baseURI);
      if (!url.pathname.toLocaleLowerCase().startsWith("/item/")) continue;
      const segment = decodeURIComponent(url.pathname.slice("/item/".length).split("/")[0] ?? "");
      const itemId = segment.replace(/\.html?$/iu, "");
      if (itemId) return itemId;
    } catch {
      // Ignore malformed or non-item card links.
    }
  }
  return undefined;
}

export function findQuizOption(document: Document, answer: string): Element | undefined {
  const wanted = normalizeText(answer);
  return [...document.querySelectorAll(".aecoin-optionButton-2GZFf")].find((option) => {
    const text = normalizeText(option.querySelector(".aecoin-optionText-WTY0C")?.textContent || option.textContent);
    return text === wanted && isVisible(option) && !isDisabled(option);
  });
}

function findVisiblePhraseInternal(
  document: Document,
  phrase: string,
  ignored: (element: Element) => boolean = () => false
): PhraseMatch | undefined {
  const wanted = normalizeText(phrase);
  if (!wanted || !document.body) return undefined;

  const candidates: Array<{ element: Element; text: string }> = [];
  const collectVisibleText = (element: Element): string => {
    if (ignored(element) || !isVisible(element)) return "";
    let text = "";
    for (const child of [...element.childNodes]) {
      if (child.nodeType === 3) text += child.textContent ?? "";
      else if (child.nodeType === 1) text += collectVisibleText(child as Element);
    }
    const normalized = normalizeText(text);
    candidates.push({ element, text: normalized });
    return text;
  };

  collectVisibleText(document.body);
  const best = candidates
    .filter(({ text }) => text.includes(wanted))
    .sort((left, right) => left.text.length - right.text.length)[0];
  if (!best) return undefined;

  return {
    phrase: wanted,
    text: best.text,
    tagName: best.element.tagName.toLocaleLowerCase(),
    id: best.element.id,
    className: typeof best.element.className === "string" ? best.element.className : ""
  };
}

export function findQuizSuccess(document: Document): PhraseMatch | undefined {
  const isQuizPrompt = (element: Element): boolean => element.matches(
    ".aecoin-questionText-1N3S5, .aecoin-optionList-32vht, .aecoin-optionButton-2GZFf"
  );
  for (const phrase of ["correct", "congratulations", "mission completed", "quiz completed"]) {
    const match = findVisiblePhraseInternal(document, phrase, isQuizPrompt);
    if (match) return match;
  }
  return undefined;
}

function taskRows(document: Document): Element[] {
  const drawers = [...document.querySelectorAll(".e2e_content")].filter((element) =>
    element.querySelector(".e2e_content_normal .e2e_normal_task")
  );
  const drawer = drawers.find(isVisible);
  return drawer ? [...drawer.querySelectorAll(".e2e_content_normal .e2e_normal_task")] : [];
}

export function findTaskAction(document: Document, groupId: string): Element | undefined {
  for (const row of taskRows(document)) {
    const right = [...row.querySelectorAll(".e2e_normal_task_right[data-groupid]")].find(
      (candidate) => candidate.getAttribute("data-groupid") === groupId && isVisible(candidate)
    );
    const action = right?.querySelector(".e2e_normal_task_right_btn");
    if (action && isVisible(action) && !isDisabled(action)) return action;
  }
  return undefined;
}

export function observeTaskDrawer(document: Document): TaskDrawerObservation {
  const rows = taskRows(document);
  const tasks: TaskObservation[] = [];

  for (const row of rows) {
    const right = row.querySelector(".e2e_normal_task_right[data-groupid]");
    if (!right) continue;

    const action = right.querySelector(".e2e_normal_task_right_btn");
    const title = normalizeText(row.querySelector(".e2e_normal_task_content_title")?.textContent);
    const statusText = normalizeText(right.querySelector(".statusText")?.textContent);
    const progress = parseProgress(statusText);
    const actionText = normalizeText(action?.textContent);
    const completeByProgress = Boolean(progress && progress.current >= progress.total);
    const completeByAction = Boolean(action && actionIsCompleted(action));
    const completed = completeByProgress || completeByAction;
    const actionState: TaskObservation["actionState"] = completed
      ? "complete"
      : action && isVisible(action) && !isDisabled(action) && actionText === "go"
        ? "active"
        : action
          ? "unavailable"
          : "unknown";

    tasks.push({
      groupId: right.getAttribute("data-groupid") ?? "",
      title,
      progress,
      actionText,
      actionState,
      completed
    });
  }

  return { found: rows.length > 0, rowCount: rows.length, tasks };
}

export function observeSurprise(document: Document, route: RouteKind): SurpriseObservation {
  if (route !== "surprise-items") {
    return { found: false, cardIds: [], hasCoinAdClickAnchor: false };
  }

  const list = [...document.querySelectorAll('.product-list[data-spm="coinsWaterFall"]')].find((candidate) =>
    candidate.querySelector('.feeds-discount-card.ad-product[data-id]')
  );
  if (!list) return { found: false, cardIds: [], hasCoinAdClickAnchor: false };

  const cards = [...list.querySelectorAll('.feeds-discount-card.ad-product[data-id]')]
    .map((card) => card.getAttribute("data-id"))
    .filter((id): id is string => Boolean(id));
  return {
    found: cards.length > 0,
    cardIds: [...new Set(cards)].sort((left, right) => Number(left) - Number(right)),
    hasCoinAdClickAnchor: Boolean(document.querySelector('#root [data-spm-anchor-id*="coinadclick"]'))
  };
}

export function observeQuiz(document: Document): QuizObservation {
  const question = normalizeText(document.querySelector(".aecoin-questionText-1N3S5")?.textContent)
    .replace(/^q\s*:\s*/u, "");
  const options = [...document.querySelectorAll(".aecoin-optionButton-2GZFf")]
    .map((option) => normalizeText(option.querySelector(".aecoin-optionText-WTY0C")?.textContent || option.textContent))
    .filter(Boolean);
  return { found: Boolean(question || options.length), question, options };
}

export function observeStats(document: Document): StatsObservation {
  const coinCount = compactText(document.querySelector(".coin-info-content-head-text")?.textContent);
  const currentSavings = compactText(document.querySelector(".coin-info-content-money-num")?.textContent);
  const lifetimeSavings = compactText(document.querySelector(".coin-history-head-subtitle")?.textContent);
  const historyEntryCount = document.querySelectorAll(".data-history-item-content").length;
  return {
    found: Boolean(coinCount || currentSavings || lifetimeSavings || historyEntryCount),
    coinCount: coinCount || undefined,
    currentSavings: currentSavings || undefined,
    lifetimeSavings: lifetimeSavings || undefined,
    historyEntryCount
  };
}

export function findVisiblePhrase(document: Document, phrase: string): PhraseMatch | undefined {
  return findVisiblePhraseInternal(document, phrase);
}

export function findSurpriseAwardDialog(document: Document): Element | undefined {
  return [...document.querySelectorAll('[class*="aecoin-awardDialog-"]')].find(isVisible);
}

export function findSurpriseContinuationTarget(document: Document): Element | undefined {
  if (findSurpriseCompletion(document)) return undefined;
  const awardDialog = findSurpriseAwardDialog(document);
  const scope = awardDialog ?? document.body;
  if (!scope) return undefined;
  for (const phrase of ["next round", "continue", "play again"]) {
    const wanted = normalizeText(phrase);
    const candidates = [scope, ...scope.querySelectorAll("*")]
      .filter((element) => isVisible(element) && normalizeText(element.textContent).includes(wanted))
      .sort((left, right) => {
        const leftAction = left.matches('button, a, [role="button"], [onclick], [class*="button" i], [class*="btn" i]') ? 0 : 1;
        const rightAction = right.matches('button, a, [role="button"], [onclick], [class*="button" i], [class*="btn" i]') ? 0 : 1;
        if (leftAction !== rightAction) return leftAction - rightAction;
        if (left.contains(right)) return 1;
        if (right.contains(left)) return -1;
        return normalizeText(left.textContent).length - normalizeText(right.textContent).length;
      });
    if (candidates[0]) return candidates[0];
  }
  return undefined;
}

export function findSurpriseCompletion(document: Document): PhraseMatch | undefined {
  const awardDialog = findSurpriseAwardDialog(document);
  const awardTextElement = awardDialog?.querySelector('[class*="aecoin-text-"]') ?? awardDialog;
  const awardText = normalizeText(awardTextElement?.textContent);
  if (awardText.includes("mission completed") || awardText.includes("mission complete")) {
    const element = awardTextElement ?? awardDialog;
    return {
      phrase: "mission completed",
      text: awardText,
      tagName: element?.tagName.toLocaleLowerCase() ?? "div",
      id: element?.id ?? "",
      className: typeof element?.className === "string" ? element.className : ""
    };
  }

  for (const phrase of ["mission completed", "mission complete"]) {
    const match = findVisiblePhrase(document, phrase);
    if (match) return match;
  }

  const renderedText = normalizeText(document.body?.innerText);
  for (const phrase of ["mission completed", "mission complete"]) {
    if (renderedText.includes(phrase)) {
      return {
        phrase,
        text: phrase,
        tagName: "body",
        id: "",
        className: ""
      };
    }
  }

  const candidates = [...document.querySelectorAll('[role="dialog"], [class*="mission"], [id*="mission"]')].filter(isVisible);
  for (const candidate of candidates) {
    const text = normalizeText(candidate.textContent);
    if (/\bmission\s+complete(?:d)?\b/u.test(text)) {
      return {
        phrase: "mission completed",
        text,
        tagName: candidate.tagName.toLocaleLowerCase(),
        id: candidate.id,
        className: typeof candidate.className === "string" ? candidate.className : ""
      };
    }
  }

  return undefined;
}

export function findExpectedOverlays(document: Document): PhraseMatch[] {
  return ["next round", "mission completed"]
    .map((phrase) => findVisiblePhrase(document, phrase))
    .filter((match): match is PhraseMatch => Boolean(match));
}
