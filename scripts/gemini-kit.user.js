// ==UserScript==
// @name         Gemini Stability Kit
// @namespace    local.gemini.stability-kit
// @version      2026.06.21
// @description  Lock preferred Gemini model, normalize send hotkeys, and trim noisy UI.
// @author       Gholts
// @license      GNU Affero General Public License v3.0
// @icon         https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg
// @match        https://gemini.google.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

(() => {
    "use strict";

    const DEFAULTS = Object.freeze({
        lockProModel: true,
        ctrlEnterSend: true,
        cleanUi: true,
        debug: false,
    });
    const TOGGLES = Object.freeze([
        ["lockProModel", "Lock Pro model"],
        ["ctrlEnterSend", "Ctrl+Enter send"],
        ["cleanUi", "Clean UI"],
        ["debug", "Debug logs"],
    ]);
    const STORE_PREFIX = "geminiStabilityKit.";
    const STYLE_ID = "gemini-kit-css";
    const LOCK_DELAY_MS = 150;
    const LOCK_STEP_MS = 1000;
    const LOCK_MAX_ATTEMPTS = 20;
    const ROUTE_FALLBACK_MS = 2000;
    const CONFIG = { ...DEFAULTS };

    function storageKey(key) {
        return `${STORE_PREFIX}${key}`;
    }

    function readBool(key, fallback) {
        try {
            if (typeof GM_getValue === "function") {
                const value = GM_getValue(storageKey(key), fallback);
                if (typeof value === "boolean") return value;
            }
        } catch {}
        try {
            const value = localStorage.getItem(storageKey(key));
            if (value === "true") return true;
            if (value === "false") return false;
        } catch {}
        return fallback;
    }

    function writeBool(key, value) {
        try {
            if (typeof GM_setValue === "function") {
                GM_setValue(storageKey(key), value);
                return;
            }
        } catch {}
        try {
            localStorage.setItem(storageKey(key), String(value));
        } catch {}
    }

    for (const [key] of TOGGLES) CONFIG[key] = readBool(key, DEFAULTS[key]);

    const log = (...args) => {
        if (CONFIG.debug) console.debug("[GeminiKit]", ...args);
    };

    function injectCleanerCss() {
        const existing = document.getElementById(STYLE_ID);
        if (!CONFIG.cleanUi) {
            existing?.remove();
            return;
        }
        if (existing) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            hallucination-disclaimer {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    let menuCommandIds = [];

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== "function") return;

        const canRefresh = typeof GM_unregisterMenuCommand === "function";
        if (menuCommandIds.length) {
            if (!canRefresh) return;
            for (const id of menuCommandIds) {
                try {
                    GM_unregisterMenuCommand(id);
                } catch {}
            }
            menuCommandIds = [];
        }

        for (const [key, label] of TOGGLES) {
            const state = CONFIG[key] ? "on" : "off";
            const commandLabel = canRefresh
                ? `${label} = ${state}`
                : `Toggle ${label}`;
            try {
                const id = GM_registerMenuCommand(commandLabel, () => {
                    setToggle(key, !CONFIG[key]);
                });
                menuCommandIds.push(id);
            } catch {}
        }
    }

    function setToggle(key, value) {
        if (typeof DEFAULTS[key] !== "boolean") return;
        CONFIG[key] = Boolean(value);
        writeBool(key, CONFIG[key]);
        applyToggleChange(key);
        registerMenuCommands();
    }

    function applyToggleChange(key) {
        if (key === "cleanUi") injectCleanerCss();
        if (key === "lockProModel") {
            if (CONFIG.lockProModel) scheduleLockCheck();
            else stopLockCheck();
        }
    }

    const MODE_ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitem"]';
    const MENU_SELECTOR =
        '.mat-mdc-menu-panel.gds-mode-switch-menu[role="menu"], mat-action-list.gds-mode-switch-menu-list, .mat-mdc-menu-panel[role="menu"]:not(.desktop-settings-menu)';
    const CHAT_INPUT_SELECTORS = [
        'main rich-textarea [contenteditable="true"]',
        'rich-textarea [contenteditable="true"]',
        'main div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][role="textbox"]',
        "main .input-area textarea",
        ".input-area textarea",
        'main [contenteditable="true"]',
        "main textarea",
    ];

    let lockTimer = 0;
    let lockRunId = 0;
    let locking = false;
    let lastCheckedPath = "";
    let routeTimer = 0;

    function isNewConversation() {
        return /^\/(u\/\d+\/)?(app\/?|gem\/.*)$/.test(location.pathname);
    }

    function getModeSelectorButton() {
        return (
            document.querySelector(".input-area-switch-label") ||
            document.querySelector('[data-test-id="model-selector"]') ||
            document.querySelector(
                'button[aria-haspopup="menu"].mat-mdc-menu-trigger',
            )
        );
    }

    function getModeMenu() {
        return document.querySelector(MENU_SELECTOR);
    }

    async function waitForMenu(timeoutMs) {
        const startedAt = performance.now();
        while (performance.now() - startedAt < timeoutMs) {
            const menu = getModeMenu();
            if (menu?.isConnected) return menu;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return null;
    }

    function focusChatInput() {
        setTimeout(() => {
            for (const selector of CHAT_INPUT_SELECTORS) {
                for (const element of document.querySelectorAll(selector)) {
                    if (!element.isConnected || element.disabled) continue;
                    try {
                        element.focus({ preventScroll: true });
                    } catch {
                        element.focus();
                    }
                    return;
                }
            }
        }, 120);
    }

    function closeMenu() {
        try {
            document.body?.click();
        } catch {}
    }

    async function tryLockProModel() {
        if (locking || !CONFIG.lockProModel || !isNewConversation()) {
            return false;
        }

        const targetRegex = /\b(advanced|pro)\b/i;
        const selectorButton = getModeSelectorButton();
        if (!selectorButton) return false;

        const currentText = (selectorButton.textContent || "").toLowerCase();
        if (targetRegex.test(currentText)) return true;

        locking = true;
        try {
            selectorButton.click();
            const menu = await waitForMenu(1500);
            if (!menu) return false;

            let found = false;
            let switched = false;
            for (const item of menu.querySelectorAll(MODE_ITEM_SELECTOR)) {
                const text = (item.textContent || "").toLowerCase();
                if (!targetRegex.test(text)) continue;

                found = true;
                const selected =
                    item.getAttribute("aria-checked") === "true" ||
                    item.classList.contains("is-selected");
                if (!selected) {
                    item.click();
                    switched = true;
                } else {
                    closeMenu();
                }
                break;
            }

            if (!found) closeMenu();
            if (switched) focusChatInput();
            return found;
        } catch (error) {
            log("model lock failed", error);
            return false;
        } finally {
            locking = false;
        }
    }

    function stopLockCheck() {
        lockRunId++;
        if (lockTimer) clearTimeout(lockTimer);
        lockTimer = 0;
    }

    function scheduleLockCheck(delayMs = LOCK_DELAY_MS) {
        if (!CONFIG.lockProModel || !isNewConversation()) return;

        stopLockCheck();
        const runId = lockRunId;
        let attempts = 0;
        lastCheckedPath = location.pathname;

        const tick = async () => {
            if (runId !== lockRunId || !CONFIG.lockProModel) return;
            if (!isNewConversation()) return;

            attempts++;
            const done = await tryLockProModel();
            if (done) {
                log("model locked");
                return;
            }

            if (attempts >= LOCK_MAX_ATTEMPTS) {
                log("model lock stopped", { attempts });
                return;
            }

            lockTimer = setTimeout(tick, LOCK_STEP_MS);
        };

        lockTimer = setTimeout(tick, delayMs);
    }

    function isEditableTarget(target) {
        if (!target || !target.tagName) return false;
        const tag = target.tagName.toUpperCase();
        return (
            tag === "TEXTAREA" ||
            tag === "INPUT" ||
            target.isContentEditable ||
            target.getAttribute("contenteditable") === "true"
        );
    }

    function findSendButton(target) {
        return target
            .closest('form, .text-input-field, chat-message, [role="dialog"]')
            ?.querySelector(
                'button[aria-label*="Send"], button[aria-label*="send"], button[data-tooltip*="Send"], .send-button, [data-send-button]',
            );
    }

    document.addEventListener(
        "keydown",
        (event) => {
            if (
                !CONFIG.ctrlEnterSend ||
                event.isComposing ||
                event.key !== "Enter" ||
                !isEditableTarget(event.target)
            ) {
                return;
            }

            if (event.ctrlKey || event.metaKey) {
                const sendButton = findSendButton(event.target);
                if (!sendButton) return;
                event.preventDefault();
                event.stopPropagation();
                sendButton.click();
                return;
            }

            if (!event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                event.target.dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Enter",
                        code: "Enter",
                        keyCode: 13,
                        which: 13,
                        shiftKey: true,
                        bubbles: true,
                        cancelable: true,
                    }),
                );
            }
        },
        true,
    );

    function patchHistoryMethod(name) {
        const original = history[name];
        if (typeof original !== "function") return;
        history[name] = function (...args) {
            const result = original.apply(this, args);
            scheduleLockCheck();
            return result;
        };
    }

    patchHistoryMethod("pushState");
    patchHistoryMethod("replaceState");
    window.addEventListener("popstate", () => scheduleLockCheck());

    document.addEventListener(
        "click",
        (event) => {
            const target = event.target;
            if (!target?.closest) return;
            const link =
                target.closest('a[href*="/app"]') ||
                target.closest('a[href*="/gem/"]');
            if (link) scheduleLockCheck();
        },
        true,
    );

    function startRouteTimer() {
        if (routeTimer) return;
        routeTimer = setInterval(() => {
            if (location.pathname === lastCheckedPath) return;
            lastCheckedPath = location.pathname;
            scheduleLockCheck(0);
        }, ROUTE_FALLBACK_MS);
    }

    window.addEventListener("pagehide", () => {
        stopLockCheck();
        if (routeTimer) {
            clearInterval(routeTimer);
            routeTimer = 0;
        }
    });
    window.addEventListener("pageshow", () => {
        startRouteTimer();
        scheduleLockCheck();
    });

    function start() {
        injectCleanerCss();
        registerMenuCommands();
        startRouteTimer();
        scheduleLockCheck();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();
