import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

type LoginFrameListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void;

describe("AliExpress standalone login frame", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fills the history-account password form and submits its disabled Sign in button", async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div class="login-page-wrapper"><div id="root"><div class="_3M6j9">
        <h1 aria-label="Sign in" role="heading">Sign in</h1>
        <div class="_1clQC"><div aria-label="Saved account">Saved account</div></div>
        <span class="cosmos-input-label-wrapper cosmos-input-password">
          <span class="cosmos-input-label-content"><input aria-label="Password" maxlength="40" id="fm-history-login-password" name="fm-history-login-password" type="password" /></span>
        </span>
        <div class="fm-baxia-container"><div id="baxia-login-check-code" class="fm-baxia-box"></div></div>
        <div class="_1e0Ux"><button disabled aria-label="Sign in" type="button"><span>Sign in</span></button></div>
        <button aria-label="Switch account">Switch account</button>
      </div></div></div>
    </body>`);
    const { document } = dom.window;
    let listener: LoginFrameListener | undefined;
    let submitted = false;
    const password = document.querySelector<HTMLInputElement>("#fm-history-login-password")!;
    const signIn = document.querySelector<HTMLButtonElement>('button[aria-label="Sign in"]')!;
    password.addEventListener("input", () => { signIn.disabled = !password.value; });
    signIn.addEventListener("click", () => { submitted = true; });
    Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 180, height: 42, top: 10, right: 190, bottom: 52, left: 10, x: 10, y: 10, toJSON: () => ({}) })
    });

    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("Event", dom.window.Event);
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: undefined,
        sendMessage(message: unknown, callback: (response: unknown) => void) {
          const command = message as { type?: string; field?: string; value?: string };
          if (command.type === "AUTOMATION_LOGIN_TRUSTED_INPUT" && command.field === "password" && command.value) {
            password.value = command.value;
            password.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
            callback({ ok: true });
          } else callback({ ok: false });
        },
        onMessage: {
          addListener(callback: LoginFrameListener) {
            listener = callback;
          }
        }
      }
    });

    await import("../src/content/login-frame");
    if (!listener) throw new Error("Login-frame listener was not registered");
    const credentials = { type: "AUTOMATION_LOGIN_FORM", username: "account@example.test", password: "test-password" };
    const resultPromise = new Promise<{ result: string; loginSubmitted?: boolean }>((resolve) => {
      listener?.(credentials, {}, (result) => resolve(result as { result: string; loginSubmitted?: boolean }));
    });

    const result = await resultPromise;
    expect(password.value).toBe("test-password");
    expect(submitted).toBe(true);
    expect(result).toMatchObject({ result: "success", loginSubmitted: true });
    expect(credentials.password).toBe("");
    dom.window.close();
  });
});
