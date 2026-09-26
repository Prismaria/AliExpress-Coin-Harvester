import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  classifyRoute,
  findExpectedOverlays,
  findQuizSuccess,
  findSurpriseAwardDialog,
  findSurpriseCompletion,
  findSurpriseContinuationTarget,
  findSurpriseItemId,
  findCoinButton,
  findTaskAction,
  findVisiblePhrase,
  hasClickGeometry,
  observeCoinIndex,
  observePage,
  observeQuiz,
  observeStats,
  observeSurprise,
  observeTaskDrawer
} from "../src/content/dom-contracts";
import { parseStatsDocument } from "../src/content/stats-contracts";
import { STATS_URL } from "../src/shared/constants";
import { isAliExpressPageUrl, isAllowedProbeUrl, safeUrl } from "../src/shared/routes";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceDocument(fileName: string): Document {
  const html = readFileSync(resolve(projectRoot, "tests/fixtures", fileName), "utf8");
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

const fixtureDocument = sourceDocument;

describe("supplied DOM contracts", () => {
  it("recognizes the unchecked coin page and Collect button", () => {
    const observation = observeCoinIndex(sourceDocument("coin-index.html"));
    const page = observePage(sourceDocument("coin-index.html"));
    expect(page.rootFound).toBe(true);
    expect(page.signButtonFound).toBe(true);
    expect(observation.rootFound).toBe(true);
    expect(observation.buttonFound).toBe(true);
    expect(observation.buttonVisible).toBe(true);
    expect(observation.buttonHasGeometry).toBe(false);
    expect(observation.buttonText).toBe("collect");
    expect(observation.state).toBe("collectable");
  });

  it("does not treat a wireframe button as safely clickable", () => {
    const document = sourceDocument("coin-index.html");
    const button = document.querySelector("button#signButton");
    if (!button) throw new Error("Supplied coin fixture is missing the check-in button");

    expect(hasClickGeometry(button)).toBe(false);
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 120, height: 40, top: 10, right: 130, bottom: 50, left: 10 })
    });
    expect(hasClickGeometry(button)).toBe(true);
  });

  it("chooses a visible coin button when a hidden duplicate is present", () => {
    const document = new JSDOM(`<!doctype html><body>
      <button id="signButton" style="display: none">Collect</button>
      <button id="signButton">Collect</button>
    </body>`).window.document;
    expect(findCoinButton(document)?.style.display).toBe("");
  });

  it("recognizes the checked coin page task-opener state", () => {
    const document = sourceDocument("coin-index.html");
    const card = document.querySelector("#sign-main-card");
    const button = document.querySelector("button#signButton");
    if (!card || !button) throw new Error("Supplied coin fixture is missing the check-in controls");
    card.className = "aecoin-today-checked-example";
    button.className = "aecoin-taskButton-example";
    button.textContent = "Earn more coins";
    expect(observeCoinIndex(document).state).toBe("already-checked");
  });

  it("maps task rows by group ID and uses representative row states", () => {
    const observation = observeTaskDrawer(sourceDocument("task drawer.html"));
    const tasks = new Map(observation.tasks.map((task) => [task.groupId, task]));
    expect(observation.found).toBe(true);
    expect(observation.rowCount).toBe(10);

    for (const groupId of ["550001", "552001", "556001", "1714001", "552002", "566001", "2126001"]) {
      expect(tasks.get(groupId)?.completed, `group ${groupId}: ${JSON.stringify(tasks.get(groupId))}`).toBe(true);
    }
    expect(tasks.get("550001")?.progress).toEqual({ current: 2, total: 2 });
    expect(tasks.get("552001")?.progress).toEqual({ current: 2, total: 2 });
    expect(tasks.get("554001")?.progress).toEqual({ current: 2, total: 3 });
    expect(tasks.get("554001")?.actionState).toBe("active");
    expect(tasks.get("554001")?.completed).toBe(false);
    expect(tasks.get("558001")?.actionState).toBe("active");
    expect(tasks.get("658001")?.actionState).toBe("active");
  });

  it("uses the fresh drawer statusText as the remaining-attempt source", () => {
    const observation = observeTaskDrawer(sourceDocument("task drawer_fresh.html"));
    const sponsored = observation.tasks.find((task) => task.groupId === "550001");
    const daily = observation.tasks.find((task) => task.groupId === "548001");
    expect(sponsored).toMatchObject({
      progress: { current: 1, total: 2 },
      actionState: "active",
      completed: false
    });
    expect(observation.tasks.find((task) => task.groupId === "552001")).toMatchObject({
      progress: { current: 0, total: 2 },
      actionState: "active",
      completed: false
    });
    expect(observation.tasks.find((task) => task.groupId === "554001")).toMatchObject({
      progress: { current: 0, total: 3 },
      actionState: "active",
      completed: false
    });
    expect(daily?.actionState).toBe("active");
  });

  it("recognizes a delayed progress update as completion when the total is reached", () => {
    const document = sourceDocument("task drawer_fresh.html");
    const right = document.querySelector('[data-groupid="554001"]');
    const status = right?.querySelector(".statusText");
    if (!right || !status) throw new Error("Fresh drawer fixture is missing the Super discounts status");

    status.textContent = "2/3";
    expect(observeTaskDrawer(document).tasks.find((task) => task.groupId === "554001")).toMatchObject({
      progress: { current: 2, total: 3 },
      completed: false
    });

    status.textContent = "3/3";
    expect(observeTaskDrawer(document).tasks.find((task) => task.groupId === "554001")).toMatchObject({
      progress: { current: 3, total: 3 },
      completed: true,
      actionState: "complete"
    });
  });

  it("preserves a visible drawer observation when daily check-in removes its row", () => {
    const document = sourceDocument("task drawer_fresh.html");
    const dailyRow = document.querySelector('[data-groupid="548001"]')?.closest(".e2e_normal_task");
    if (!dailyRow) throw new Error("Fresh drawer fixture is missing the daily check-in row");
    dailyRow.remove();

    const observation = observeTaskDrawer(document);
    expect(observation.found).toBe(true);
    expect(observation.tasks.some((task) => task.groupId === "548001")).toBe(false);
    expect(observation.rowCount).toBeGreaterThan(0);
  });

  it("resolves task actions from the visible drawer instead of a stale duplicate", () => {
    const document = new JSDOM(`<!doctype html><body>
      <div class="e2e_content" style="display: none">
        <div class="e2e_content_normal"><div class="e2e_normal_task">
          <div class="e2e_normal_task_right" data-groupid="548001"><div class="e2e_normal_task_right_btn">GO</div></div>
        </div></div>
      </div>
      <div class="e2e_content">
        <div class="e2e_content_normal"><div class="e2e_normal_task">
          <div class="e2e_normal_task_content_title">Daily check-in</div>
          <div class="e2e_normal_task_right" data-groupid="548001"><div id="live-go" class="e2e_normal_task_right_btn">GO</div></div>
        </div></div>
      </div>
    </body>`).window.document;
    expect(findTaskAction(document, "548001")?.id).toBe("live-go");
    expect(observeTaskDrawer(document).tasks).toMatchObject([
      { groupId: "548001", actionState: "active", completed: false }
    ]);
  });

  it("recognizes the live completed checkmark asset even without progress text", () => {
    const document = sourceDocument("task drawer_fresh.html");
    const action = document.querySelector('[data-groupid="550001"] .e2e_normal_task_right_btn');
    if (!action) throw new Error("Fresh drawer fixture is missing the sponsored-items action");
    action.textContent = " ";
    action.setAttribute("style", "background: url(\"https://ae-pic-a1.aliexpress-media.com/kf/S8b875cee0b02476e96ddebfedef1fc07v.png\") 0% 0% / cover;");
    expect(observeTaskDrawer(document).tasks.find((task) => task.groupId === "550001")?.completed).toBe(true);
  });

  it("does not treat generic action labels as completion evidence", () => {
    const document = sourceDocument("task drawer_fresh.html");
    const action = document.querySelector('[data-groupid="548001"] .e2e_normal_task_right_btn');
    if (!action) throw new Error("Fresh drawer fixture is missing the daily check-in action");
    action.textContent = "Done";
    expect(observeTaskDrawer(document).tasks.find((task) => task.groupId === "548001")?.completed).toBe(false);
  });

  it("rejects zero-total progress as completion evidence", () => {
    const document = sourceDocument("task drawer_fresh.html");
    const right = document.querySelector('[data-groupid="548001"]');
    const action = right?.querySelector(".e2e_normal_task_right_btn");
    if (!right || !action) throw new Error("Fresh drawer fixture is missing the daily check-in action");
    const status = document.createElement("div");
    status.className = "statusText";
    status.textContent = "0/0";
    right.prepend(status);
    action.removeAttribute("style");
    expect(observeTaskDrawer(document).tasks.find((task) => task.groupId === "548001")?.completed).toBe(false);
  });

  it("only treats the route-scoped ad waterfall as a surprise grid", () => {
    const surprise = observeSurprise(sourceDocument("surprise_items.html"), "surprise-items");
    const coinPage = observeSurprise(sourceDocument("coin-index.html"), "coin-index");
    expect(surprise.found).toBe(true);
    expect(surprise.cardIds.length).toBe(16);
    expect(new Set(surprise.cardIds).size).toBe(16);
    expect(surprise.hasCoinAdClickAnchor).toBe(true);
    expect(coinPage.found).toBe(false);
  });

  it("recognizes the actual Surprise Items page and award dialog contract", () => {
    const actual = sourceDocument("surprise_items_actual.html");
    const surprise = observeSurprise(actual, "surprise-items");
    expect(surprise.found).toBe(true);
    expect(surprise.cardIds.length).toBe(19);
    const dialog = actual.createElement("div");
    dialog.className = "aecoin-awardDialog-cm0gE";
    dialog.textContent = "Next round";
    actual.body.append(dialog);
    expect(findSurpriseAwardDialog(actual)).toBe(dialog);
  });

  it("maps a Surprise card key to the product ID in its item link", () => {
    const document = new JSDOM(`<!doctype html><body>
      <div class="product-list" data-spm="coinsWaterFall">
        <div class="feeds-discount-card ad-product" data-id="1">
          <a class="product-click" href="https://www.aliexpress.com/item/1005008962986694.html?spm=coin"></a>
        </div>
      </div>
    </body>`).window.document;
    const card = document.querySelector(".feeds-discount-card");
    expect(card).toBeTruthy();
    expect(findSurpriseItemId(card!)).toBe("1005008962986694");
  });

  it("detects the visible Surprise mission completion overlay", () => {
    const document = new JSDOM("<!doctype html><body><div>Mission Completed</div></body>").window.document;
    expect(findSurpriseCompletion(document)?.text).toBe("mission completed");
    const awardDocument = new JSDOM(`<!doctype html><body>
      <div class="aecoin-awardDialog-cm0gE">
        <div class="aecoin-text-2CmMp" data-spm-anchor-id="a2g0n.coinadclick.0.11.165490p9s0rPsG0">Mission Completed</div>
      </div>
    </body>`).window.document;
    expect(findSurpriseCompletion(awardDocument)).toMatchObject({
      phrase: "mission completed",
      text: "mission completed",
      className: "aecoin-text-2CmMp"
    });
    const finishedDocument = new JSDOM("<!doctype html><body><div>Finished</div></body>").window.document;
    expect(findSurpriseCompletion(finishedDocument)).toBeUndefined();
    const classOnlyDocument = new JSDOM("<!doctype html><body><div class=mission-complete-overlay></div></body>").window.document;
    expect(findSurpriseCompletion(classOnlyDocument)).toBeUndefined();
    const counterDocument = new JSDOM("<!doctype html><body><div class=aecoin-rightAreaNum-Mt1YG>3 / 3</div></body>").window.document;
    expect(findSurpriseCompletion(counterDocument)).toBeUndefined();
  });

  it("does not mistake a next-round overlay for mission completion", () => {
    const document = new JSDOM(`<!doctype html><body>
      <div class="aecoin-awardDialog-cm0gE"><div class="aecoin-text-2CmMp">Next round</div></div>
    </body>`).window.document;
    expect(findSurpriseAwardDialog(document)).toBeTruthy();
    expect(findSurpriseCompletion(document)).toBeUndefined();
    expect(findSurpriseContinuationTarget(document)?.className).toBe("aecoin-text-2CmMp");
    const counter = document.createElement("div");
    counter.className = "aecoin-rightAreaNum-Mt1YG";
    counter.textContent = "3 / 3";
    document.body.prepend(counter);
    expect(findSurpriseCompletion(document)).toBeUndefined();
    expect(findSurpriseContinuationTarget(document)?.textContent).toBe("Next round");
  });

  it("finds a next-round continuation target without relying on the award-dialog class", () => {
    const document = new JSDOM("<!doctype html><body><section><button>Next round</button></section></body>").window.document;
    expect(findSurpriseContinuationTarget(document)?.textContent).toBe("Next round");
  });

  it("uses the chat-provided quiz and stats snippets as parser fixtures", () => {
    const quiz = observeQuiz(fixtureDocument("quiz.html"));
    const stats = observeStats(fixtureDocument("stats.html"));
    expect(quiz).toMatchObject({
      found: true,
      question: "how can you access the coins page?",
      options: ["homepage", "my account", "all of the above"]
    });
    expect(stats).toMatchObject({
      found: true,
      coinCount: "729",
      currentSavings: "C$10.37",
      lifetimeSavings: "Coins have saved C$325.58",
      historyEntryCount: 3
    });
    const questionWithKeyword = fixtureDocument("quiz.html");
    questionWithKeyword.querySelector(".aecoin-questionText-1N3S5")!.textContent = "Q: Which answer is correct?";
    expect(findQuizSuccess(questionWithKeyword)).toBeUndefined();
    const completedQuiz = fixtureDocument("quiz.html");
    const result = completedQuiz.createElement("div");
    result.setAttribute("role", "alert");
    result.textContent = "Correct!";
    completedQuiz.body.append(result);
    expect(findQuizSuccess(completedQuiz)?.phrase).toBe("correct");
  });

  it("normalizes authenticated stats and preserves raw values and history", () => {
    const result = parseStatsDocument(fixtureDocument("stats.html"), {
      rawUrl: "https://www.aliexpress.com/p/coin-pc-index/mycoin.html?from=coin",
      observedAt: 1_700_000_000_000
    });
    expect(result.snapshot).toMatchObject({
      accountState: "authenticated",
      coinCountRaw: "729",
      currentSavingsRaw: "C$10.37",
      lifetimeSavingsRaw: "Coins have saved C$325.58",
      stale: false,
      source: {
        kind: "stats-html",
        url: "https://www.aliexpress.com/p/coin-pc-index/mycoin.html",
        observedAt: 1_700_000_000_000
      }
    });
    expect(result.snapshot.history).toEqual([
      {
        id: "unknown|9/15/2026 PT|coin page task|+5",
        category: "unknown",
        dateLabel: "9/15/2026 PT",
        dateKey: "2026-09-15",
        title: "Coin page task",
        amountRaw: "+5"
      },
      {
        id: "unknown|9/15/2026 PT|app daily check-in|+10",
        category: "unknown",
        dateLabel: "9/15/2026 PT",
        dateKey: "2026-09-15",
        title: "App daily check-in",
        amountRaw: "+10"
      },
      {
        id: "unknown|9/6/2026 PT|placing order|+60",
        category: "unknown",
        dateLabel: "9/6/2026 PT",
        dateKey: "2026-09-06",
        title: "Placing order",
        amountRaw: "+60"
      }
    ]);
  });

  it("distinguishes logged-out stats redirects from empty accounts", () => {
    expect(
      parseStatsDocument(fixtureDocument("stats-logged-out.html"), {
        rawUrl: "https://m.aliexpress.com/p/ug-login-page/login.html?from=stats"
      }).snapshot.accountState
    ).toBe("logged-out");
    const softLogin = parseStatsDocument(fixtureDocument("stats-logged-out.html"), {
      rawUrl: STATS_URL
    });
    expect(softLogin.snapshot.accountState).toBe("logged-out");
    expect(softLogin.snapshot.warnings).toContain("Stats response contains a login prompt without redirecting to the login route");
    expect(parseStatsDocument(fixtureDocument("stats-empty.html")).snapshot.accountState).toBe("empty");
  });

  it("distinguishes loading and malformed stats documents", () => {
    expect(parseStatsDocument(fixtureDocument("stats-loading.html")).snapshot.accountState).toBe("loading");
    const malformed = parseStatsDocument(fixtureDocument("stats-malformed.html"));
    expect(malformed.snapshot.accountState).toBe("malformed");
    expect(malformed.snapshot.warnings).toContain("A stats value did not match the expected numeric or currency shape");
  });

  it("maps history categories and stable source IDs when the page exposes them", () => {
    const history = parseStatsDocument(fixtureDocument("stats-history-categories.html")).snapshot.history;
    expect(history).toEqual([
      {
        id: "earned:earned-1",
        category: "earned",
        dateLabel: "9/17/2026 PT",
        dateKey: "2026-09-17",
        title: "Daily check-in",
        amountRaw: "+12"
      },
      {
        id: "used:used-1",
        category: "used",
        dateLabel: "9/17/2026 PT",
        dateKey: "2026-09-17",
        title: "Applied discount",
        amountRaw: "-4"
      }
    ]);
  });

  it("finds visible overlay phrases globally but ignores hidden text", () => {
    const document = new JSDOM(
      '<div class="wrapper"><span hidden>next round</span></div><div class="overlay"><span>Mission Completed</span></div>'
    ).window.document;
    expect(findVisiblePhrase(document, "next round")).toBeUndefined();
    expect(findVisiblePhrase(document, "mission completed")?.text).toBe("mission completed");
    expect(findExpectedOverlays(document).map((match) => match.phrase)).toEqual(["mission completed"]);
  });

  it("classifies supplied route forms and strips query strings from reports", () => {
    expect(classifyRoute("https://m.aliexpress.com/p/coin-index/index.html?foo=bar")).toBe("coin-index");
    expect(classifyRoute(STATS_URL)).toBe("stats");
    expect(classifyRoute("https://m.aliexpress.com/p/ug-login-page/login.html?from=coin")).toBe("login");
    expect(safeUrl("https://m.aliexpress.com/p/coin-index/adclick.html?taskInstanceId=secret")).toBe(
      "https://m.aliexpress.com/p/coin-index/adclick.html"
    );
    expect(isAllowedProbeUrl("https://www.aliexpress.com/p/coin-pc-index/mycoin.html")).toBe(true);
    expect(isAllowedProbeUrl("https://example.test/coin-index.html")).toBe(false);
    expect(isAliExpressPageUrl("https://www.aliexpress.com/search.html")).toBe(true);
    expect(isAliExpressPageUrl("https://m.aliexpress.com/item/123.html")).toBe(true);
    expect(isAliExpressPageUrl("http://best.aliexpress.com/")).toBe(true);
    expect(isAliExpressPageUrl("https://example.test/search.html")).toBe(false);
    expect(isAliExpressPageUrl("http://www.aliexpress.com/search.html")).toBe(false);
  });

  it("uses the canonical stats URL when no source URL is supplied", () => {
    expect(parseStatsDocument(fixtureDocument("stats.html")).snapshot.source).toMatchObject({
      kind: "stats-html",
      url: STATS_URL,
      observedAt: expect.any(Number)
    });
  });
});
