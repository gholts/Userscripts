// ==UserScript==
// @name         X Privacy Kit
// @namespace    local.x.privacy-kit
// @version      2026.06.21
// @description  Disable X personalization preferences when auth tokens are available.
// @author       Gholts
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    const DEFAULTS = Object.freeze({
        privacyOverwrite: true,
        debug: false,
    });
    const TOGGLES = Object.freeze([
        ["privacyOverwrite", "Privacy overwrite"],
        ["debug", "Debug logs"],
    ]);
    const STORE_PREFIX = "xPrivacyKit.";
    const PATCH_MARK = "__xPrivacyKitInstalled";
    const API_URL =
        "https://api.x.com/1.1/account/personalization/p13n_preferences.json";
    const SEND_DELAY_MS = 1500;
    const RETRY_DELAY_MS = 5000;
    const MAX_ATTEMPTS = 6;
    const CONFIG = { ...DEFAULTS };
    const pageWindow =
        typeof unsafeWindow === "object" && unsafeWindow
            ? unsafeWindow
            : window;

    let menuCommandIds = [];
    let bearerToken = "";
    let retryTimer = 0;
    let attempts = 0;
    let state = "idle";

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
        if (CONFIG.debug) console.debug("[XPrivacyKit]", ...args);
    };

    const PRIVACY_PAYLOAD = Object.freeze({
        preferences: {
            age_preferences: { use_age_for_personalization: false },
            gender_preferences: { use_gender_for_personalization: false },
            location_preferences: { use_location_for_personalization: false },
            allow_ads_personalization: false,
            use_cookie_personalization: false,
            link_logged_out_devices: false,
            share_data_with_third_party: false,
            interest_preferences: {
                disabled_interests: ["*"],
                disabled_partner_interests: ["*"],
            },
        },
    });

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
            const stateText = CONFIG[key] ? "on" : "off";
            const commandLabel = canRefresh
                ? `${label} = ${stateText}`
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
        if (key === "privacyOverwrite") {
            if (CONFIG.privacyOverwrite && bearerToken) schedulePrivacyFix();
            if (!CONFIG.privacyOverwrite) clearRetry();
        }
        registerMenuCommands();
    }

    function clearRetry() {
        if (retryTimer) pageWindow.clearTimeout(retryTimer);
        retryTimer = 0;
        if (state === "queued") state = "idle";
    }

    function getCsrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
        if (!match) return "";
        try {
            return decodeURIComponent(match[1]);
        } catch {
            return match[1];
        }
    }

    function schedulePrivacyFix(delayMs = SEND_DELAY_MS) {
        if (
            !CONFIG.privacyOverwrite ||
            !bearerToken ||
            retryTimer ||
            state === "sending" ||
            state === "done" ||
            attempts >= MAX_ATTEMPTS
        ) {
            return;
        }

        state = "queued";
        retryTimer = pageWindow.setTimeout(() => {
            retryTimer = 0;
            sendPrivacyFix();
        }, delayMs);
    }

    async function sendPrivacyFix() {
        if (
            !CONFIG.privacyOverwrite ||
            !bearerToken ||
            state === "sending" ||
            state === "done" ||
            attempts >= MAX_ATTEMPTS
        ) {
            return;
        }

        const csrfToken = getCsrfToken();
        if (!csrfToken) {
            state = "idle";
            attempts++;
            schedulePrivacyFix(RETRY_DELAY_MS);
            return;
        }

        state = "sending";
        attempts++;

        try {
            const response = await pageWindow.fetch(API_URL, {
                method: "POST",
                credentials: "include",
                headers: {
                    authorization: bearerToken,
                    "x-csrf-token": csrfToken,
                    "content-type": "application/json",
                    "x-twitter-auth-type": "OAuth2Session",
                    "x-twitter-active-user": "yes",
                },
                body: JSON.stringify(PRIVACY_PAYLOAD),
            });

            if (response.ok) {
                state = "done";
                log("privacy preferences updated");
                return;
            }

            log("privacy update failed", response.status);
            state = "idle";
            schedulePrivacyFix(RETRY_DELAY_MS);
        } catch (error) {
            log("privacy update error", error);
            state = "idle";
            schedulePrivacyFix(RETRY_DELAY_MS);
        }
    }

    function getHeader(headers, name) {
        if (!headers) return "";
        const wanted = name.toLowerCase();

        try {
            if (typeof headers.get === "function") {
                return headers.get(name) || headers.get(wanted) || "";
            }
        } catch {}

        if (Array.isArray(headers)) {
            for (const [key, value] of headers) {
                if (String(key).toLowerCase() === wanted) return value;
            }
            return "";
        }

        if (typeof headers === "object") {
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase() === wanted) return headers[key];
            }
        }

        return "";
    }

    function captureBearer(value) {
        const token = String(value || "").trim();
        if (!/^Bearer\s+/i.test(token)) return;
        bearerToken = token;
        schedulePrivacyFix();
    }

    function captureFetchHeaders(input, init) {
        try {
            captureBearer(getHeader(init?.headers, "authorization"));
            captureBearer(getHeader(input?.headers, "authorization"));
        } catch {}
    }

    function patchXhr() {
        const Xhr = pageWindow.XMLHttpRequest;
        const original = Xhr?.prototype?.setRequestHeader;
        if (typeof original !== "function") return;

        Xhr.prototype.setRequestHeader = function (header, value) {
            if (String(header || "").toLowerCase() === "authorization") {
                captureBearer(value);
            }
            return original.apply(this, arguments);
        };
    }

    function patchFetch() {
        const original = pageWindow.fetch;
        if (typeof original !== "function") return;

        pageWindow.fetch = function (input, init) {
            captureFetchHeaders(input, init);
            return original.apply(this, arguments);
        };
    }

    registerMenuCommands();

    if (!pageWindow[PATCH_MARK]) {
        pageWindow[PATCH_MARK] = true;
        patchXhr();
        patchFetch();
    }
})();
