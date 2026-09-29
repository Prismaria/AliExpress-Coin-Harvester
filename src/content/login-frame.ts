import {
  findLoginAccountInput,
  findLoginActionButton,
  findLoginPasswordInput,
  isVisible,
  observeLoginPanel
} from "./dom-contracts";
import { AUTOMATION_POLL_INTERVAL_MS, LOGIN_FLOW_WAIT_MS } from "../shared/constants";
import type { AutomationContentResponse, AutomationLoginFormCommand, AutomationResult, Phase0Message, Phase0Response } from "../shared/types";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitFor<T>(read: () => T, ready: (value: T) => boolean, timeoutMs = 15_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!ready(value) && Date.now() < deadline) {
    await delay(AUTOMATION_POLL_INTERVAL_MS);
    value = read();
  }
  return ready(value) ? value : undefined;
}

function response(result: AutomationResult, error?: string, extra: Partial<AutomationContentResponse> = {}): AutomationContentResponse {
  return { ok: result === "success", operation: "login-frame", result, error, ...extra };
}

function sendWorker(message: Phase0Message): Promise<Phase0Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (result: Phase0Response | undefined) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(result ?? { ok: false, error: "No response from service worker" });
    });
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const prototype = input.ownerDocument.defaultView?.HTMLInputElement.prototype;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function fillLoginInput(input: HTMLInputElement, value: string, field: "username" | "password"): Promise<boolean> {
  input.focus({ preventScroll: true });
  input.select();
  const trustedInput = await sendWorker({ type: "AUTOMATION_LOGIN_TRUSTED_INPUT", field, value });
  if (trustedInput.ok) {
    const applied = await waitFor(() => input.value, (current) => current === value, 2_000);
    if (applied) return true;
  }
  setInputValue(input, value);
  return input.value === value;
}

function isDisabled(button: HTMLButtonElement): boolean {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

async function clickVerified(button: HTMLButtonElement, keyboardFallback: HTMLInputElement): Promise<boolean> {
  if (!isVisible(button) || isDisabled(button)) return false;
  button.scrollIntoView?.({ block: "center", inline: "center" });
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    keyboardFallback.focus({ preventScroll: true });
    for (const type of ["keydown", "keypress", "keyup"]) {
      keyboardFallback.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }
    return true;
  }

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0
  };
  if (typeof PointerEvent !== "undefined") {
    const pointerInit: PointerEventInit = { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
  }
  button.dispatchEvent(new MouseEvent("mousedown", eventInit));
  button.focus({ preventScroll: true });
  if (typeof PointerEvent !== "undefined") {
    const pointerInit: PointerEventInit = { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerup", pointerInit));
  }
  button.dispatchEvent(new MouseEvent("mouseup", eventInit));
  button.click();
  return true;
}

async function completeLoginForm(username: string, password: string): Promise<AutomationContentResponse> {
  let panel = await waitFor(
    observeLoginPanel.bind(null, document),
    (value) => value.stage !== "closed" && value.stage !== "unknown",
    LOGIN_FLOW_WAIT_MS
  );
  if (!panel) return response("manual_action_required", "AliExpress login form was not found in the login document");
  if (panel.stage === "challenge") return response("manual_action_required", "AliExpress requires a manual security check", { loginPanel: panel });

  let accountInput = findLoginAccountInput(document);
  if (accountInput) {
    if (!(await fillLoginInput(accountInput, username, "username"))) {
      return response("manual_action_required", "AliExpress did not accept the account name", { loginPanel: panel });
    }
  }

  if (panel.stage === "email") {
    accountInput = findLoginAccountInput(document);
    if (!accountInput) return response("manual_action_required", "AliExpress email field was not available", { loginPanel: panel });
    const continueButton = await waitFor(
      () => findLoginActionButton(document, "continue"),
      (button) => Boolean(button && !isDisabled(button)),
      5_000
    );
    if (!continueButton || !(await clickVerified(continueButton, accountInput))) {
      return response("manual_action_required", "AliExpress did not enable Continue", { loginPanel: observeLoginPanel(document) });
    }
    panel = await waitFor(
      observeLoginPanel.bind(null, document),
      (value) => value.stage === "password" || value.stage === "challenge",
      LOGIN_FLOW_WAIT_MS
    );
    if (!panel) return response("manual_action_required", "AliExpress did not advance to the password step");
    if (panel.stage === "challenge") return response("manual_action_required", "AliExpress requires a manual security check", { loginPanel: panel });
  }

  const passwordInput = findLoginPasswordInput(document);
  if (!passwordInput || passwordInput.disabled) {
    return response("manual_action_required", "AliExpress password field was not available", { loginPanel: observeLoginPanel(document) });
  }
  if (passwordInput.maxLength > 0 && password.length > passwordInput.maxLength) {
    return response("manual_action_required", "Saved password is longer than AliExpress accepts", { loginPanel: observeLoginPanel(document) });
  }
  if (!(await fillLoginInput(passwordInput, password, "password"))) {
    return response("manual_action_required", "AliExpress did not accept the saved password", { loginPanel: observeLoginPanel(document) });
  }

  let signInButton = findLoginActionButton(document, "sign in");
  signInButton = await waitFor(
    () => findLoginActionButton(document, "sign in"),
    (button) => Boolean(button && !isDisabled(button)),
    5_000
  );
  if (!signInButton || !(await clickVerified(signInButton, passwordInput))) {
    const currentPanel = observeLoginPanel(document);
    if (currentPanel.stage === "challenge") return response("manual_action_required", "AliExpress requires a manual security check", { loginPanel: currentPanel });
    return response("manual_action_required", "AliExpress did not enable Sign in", { loginPanel: currentPanel });
  }

  return response("success", undefined, {
    loginSubmitted: true
  });
}

chrome.runtime.onMessage.addListener((message: Phase0Message, _sender, sendResponse) => {
  if (message.type !== "AUTOMATION_LOGIN_FORM") return false;
  let username = message.username;
  let password = message.password;
  message.username = "";
  message.password = "";
  void completeLoginForm(username, password)
    .then(sendResponse)
    .catch(() => sendResponse(response("manual_action_required", "Saved sign-in could not be completed safely")))
    .finally(() => {
      username = "";
      password = "";
    });
  return true;
});
