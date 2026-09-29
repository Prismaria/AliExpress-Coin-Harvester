import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type ContentMessageListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

describe("saved-credential login automation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("waits for the drawer, submits email, submits password, and waits for the signed-in Coins SPA", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(`<!doctype html><body>
      <div class="aecoin-loginButtonContainer-2rtjc"><button class="aecoin-loginButton-3pcZm">Log in</button></div>
    </body>`);
    const { document } = dom.window;
    let listener: ContentMessageListener | undefined;
    let continueClicked = false;
    let submittedEmail = "";
    let submittedPassword = "";
    const fakeSetTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => globalThis.setTimeout(callback, timeout, ...args)) as typeof dom.window.setTimeout;
    dom.window.setTimeout = fakeSetTimeout;
    Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 180, height: 42, top: 10, right: 190, bottom: 52, left: 10, x: 10, y: 10, toJSON: () => ({}) })
    });

    const renderPasswordPanel = (email: string): void => {
      document.body.innerHTML = `<div class="cosmos-drawer cosmos-drawer-right"><div class="cosmos-drawer-body">
        <h1>Sign in</h1>
        <input autocomplete="username webauthn" name="account" aria-label="Email or phone number" value="${email}" />
        <input id="fm-login-password" name="fm-login-password" type="password" aria-label="Password" maxlength="40" />
        <button type="button" aria-label="Sign in" disabled>Sign in</button>
        <div id="baxia-login-check-code"></div>
      </div></div>`;
      const account = document.querySelector<HTMLInputElement>('input[name="account"]')!;
      const password = document.querySelector<HTMLInputElement>('input[type="password"]')!;
      const signIn = document.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]')!;
      password.addEventListener("input", () => { signIn.disabled = !password.value; });
      signIn.addEventListener("click", () => {
        submittedEmail = account.value;
        submittedPassword = password.value;
        dom.window.setTimeout(() => {
          document.body.innerHTML = `<div id="root"><div data-version="daily"><div id="sign-main-card" class="aecoin-today-checked-example"><button id="signButton" class="aecoin-taskButton-example">Earn more coins</button></div></div></div>`;
        }, 100);
      });
    };

    document.querySelector(".aecoin-loginButton-3pcZm")?.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        document.body.innerHTML = `<div class="cosmos-drawer cosmos-drawer-right"><div class="cosmos-drawer-body">
          <h1>Register/Sign in</h1>
          <input autocomplete="username webauthn" aria-label="Email or phone number" />
          <button type="button" aria-label="Continue" disabled>Continue</button>
          <button type="button" aria-label="Sign in with email code">Sign in with email code</button>
          <div id="baxia-login-check-code"></div>
        </div></div>`;
        const account = document.querySelector<HTMLInputElement>('input[aria-label="Email or phone number"]')!;
        const continueButton = document.querySelector<HTMLButtonElement>('button[aria-label="Continue"]')!;
        account.addEventListener("input", () => { continueButton.disabled = !account.value; });
        continueButton.addEventListener("click", () => {
          continueClicked = true;
          renderPasswordPanel(account.value);
        });
      }, 5_000);
    });

    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("Event", dom.window.Event);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage(message: unknown, callback: (response: unknown) => void) {
          const command = message as { type?: string; field?: "username" | "password"; value?: string };
          const input = command.field === "password"
            ? document.querySelector<HTMLInputElement>("#fm-history-login-password")
            : undefined;
          if (command.type === "AUTOMATION_LOGIN_TRUSTED_INPUT" && input && typeof command.value === "string") {
            input.value = command.value;
            input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            callback({ ok: true });
            return;
          }
          callback({ ok: false });
        },
        onMessage: {
          addListener(callback: ContentMessageListener) {
            listener = callback;
          }
        }
      }
    });

    await import("../src/content/automation-controller");
    if (!listener) throw new Error("Automation content listener was not registered");
    const responsePromise = new Promise<{ result: string; coinIndex?: { state: string } }>((resolve) => {
      listener?.({
        type: "AUTOMATION_COMMAND",
        command: "sign-in",
        username: "account@example.test",
        password: "test-password"
      }, {}, (response) => resolve(response as { result: string; coinIndex?: { state: string } }));
    });

    await vi.advanceTimersByTimeAsync(6_000);
    const response = await responsePromise;
    expect(continueClicked).toBe(true);
    expect(submittedEmail).toBe("account@example.test");
    expect(submittedPassword).toBe("test-password");
    expect(response).toMatchObject({ result: "success", coinIndex: { state: "already-checked" } });
    dom.window.close();
  });

  it("continues from an already-open sign-in drawer without reopening it", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM(`<!doctype html><body>
      <div class="aecoin-loginButtonContainer-2rtjc"><button id="coin-login" class="aecoin-loginButton-3pcZm">Log in</button></div>
      <div class="_3M6j9">
        <div class="_1clQC"><div aria-label="Saved account">Saved account</div></div>
        <input id="fm-history-login-password" name="fm-history-login-password" type="password" aria-label="Password" maxlength="40" />
        <div id="baxia-login-check-code" class="fm-baxia-box"></div>
        <button aria-label="Sign in with passkey">Sign in with passkey</button>
        <button aria-label="Sign in with email code">Sign in with email code</button>
        <button type="button" aria-label="Sign in" disabled>Sign in</button>
      </div>
    </body>`);
    const { document } = dom.window;
    let listener: ContentMessageListener | undefined;
    let loginButtonClicks = 0;
    dom.window.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => globalThis.setTimeout(callback, timeout, ...args)) as typeof dom.window.setTimeout;
    Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 180, height: 42, top: 10, right: 190, bottom: 52, left: 10, x: 10, y: 10, toJSON: () => ({}) })
    });
    document.querySelector("#coin-login")?.addEventListener("click", () => { loginButtonClicks += 1; });
    const passwordInput = document.querySelector<HTMLInputElement>("#fm-history-login-password")!;
    const signInButton = document.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]')!;
    passwordInput.addEventListener("input", () => { signInButton.disabled = !passwordInput.value; });
    signInButton.addEventListener("click", () => {
      dom.window.setTimeout(() => {
        document.body.innerHTML = `<div id="root"><div data-version="daily"><div id="sign-main-card" class="aecoin-today-checked-example"><button id="signButton" class="aecoin-taskButton-example">Earn more coins</button></div></div></div>`;
      }, 100);
    });

    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("Event", dom.window.Event);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage(message: unknown, callback: (response: unknown) => void) {
          const command = message as { type?: string; field?: "username" | "password"; value?: string };
          if (command.type === "AUTOMATION_LOGIN_TRUSTED_INPUT" && command.field === "password" && typeof command.value === "string") {
            passwordInput.value = command.value;
            passwordInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            callback({ ok: true });
            return;
          }
          callback({ ok: false });
        },
        onMessage: {
          addListener(callback: ContentMessageListener) {
            listener = callback;
          }
        }
      }
    });

    await import("../src/content/automation-controller");
    if (!listener) throw new Error("Automation content listener was not registered");
    const responsePromise = new Promise<{ result: string; coinIndex?: { state: string } }>((resolve) => {
      listener?.({
        type: "AUTOMATION_COMMAND",
        command: "sign-in",
        username: "account@example.test",
        password: "test-password"
      }, {}, (response) => resolve(response as { result: string; coinIndex?: { state: string } }));
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const response = await responsePromise;
    expect(loginButtonClicks).toBe(0);
    expect(response).toMatchObject({ result: "success", coinIndex: { state: "already-checked" } });
    dom.window.close();
  });
});
