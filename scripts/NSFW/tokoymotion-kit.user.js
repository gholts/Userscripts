// ==UserScript==
// @name         [NSFW] TokyoMotion Stability Kit
// @namespace    local.tokyomotion.stability-kit
// @version      2026.06.21
// @description  Keep TokyoMotion logged in, prefer HD playback, and clean distracting UI.
// @author       Gholts
// @license      GNU Affero General Public License v3.0
// @match        https://www.tokyomotion.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    const DEFAULTS = Object.freeze({
        autoLogin: true,
        autoHD: true,
        cleanUi: true,
        debug: false,
    });
    const TOGGLES = Object.freeze([
        ["autoLogin", "Auto login"],
        ["autoHD", "Auto HD"],
        ["cleanUi", "Clean UI"],
        ["debug", "Debug logs"],
    ]);
    const STORE_PREFIX = "tokyoMotionStabilityKit.";
    const STYLE_ID = "tokyomotion-kit-css";
    const LOGIN_TIMEOUT_MS = 10000;
    const HD_STEP_MS = 500;
    const HD_MAX_ATTEMPTS = 30;
    const CONFIG = { ...DEFAULTS };

    const SELECTORS = Object.freeze({
        loginForm: 'form[name="login_form"]',
        hdSourceButton: ".fluid_video_source_list_item.js-source_HD",
        sourceMenu: ".fluid_video_sources_list",
        navHidden: [
            'li.hidden-sm:has(> [href="/categories"])',
            'li.hidden-sm:has(> [href="/community"])',
            'li.hidden-sm:has(> [href="https://theporndude.com/ja"])',
            'li.hidden-sm:has(> [href="/tags"])',
        ],
    });
    const STORAGE = Object.freeze({
        user: "tm_username",
        pass: "tm_password",
        cooldown: "tm_login_cooldown",
    });

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

    function readValue(key, fallback = "") {
        try {
            if (typeof GM_getValue === "function")
                return GM_getValue(key, fallback);
        } catch {}
        return fallback;
    }

    function writeValue(key, value) {
        try {
            if (typeof GM_setValue === "function") GM_setValue(key, value);
        } catch {}
    }

    for (const [key] of TOGGLES) CONFIG[key] = readBool(key, DEFAULTS[key]);

    const log = (...args) => {
        if (CONFIG.debug) console.debug("[TokyoMotionKit]", ...args);
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
            ${SELECTORS.navHidden.join(",\n")} { display: none !important; }

            li.dropdown > a#search-drop { display: none !important; }
            li.dropdown .dropdown-menu.search-dropdown-menu {
                display: block !important;
                position: static !important;
                float: none !important;
                border: none !important;
                background-color: transparent !important;
                padding: 0 !important;
                margin: 0 !important;
                width: auto !important;
                min-width: 0 !important;
                box-shadow: none !important;
            }
            li.dropdown .dropdown-menu.search-dropdown-menu form { margin-top: 11px !important; }

            .fluid_video_wrapper.fluid_player_layout_default.fluid_theatre_mode {
                height: 70vh !important;
                margin-top: 90px !important;
            }
            @media (min-width: 992px) {
                .col-md-8 { width: 100% !important; max-width: 100%; flex: 0 0 100%; }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    let menuCommandIds = [];
    let autoHdTimer = 0;
    let initialized = false;

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

        try {
            menuCommandIds.push(
                GM_registerMenuCommand("Set username", () => {
                    const value = prompt(
                        "TokyoMotion username:",
                        readValue(STORAGE.user, ""),
                    );
                    if (value !== null) writeValue(STORAGE.user, value.trim());
                }),
            );
            menuCommandIds.push(
                GM_registerMenuCommand("Set password", () => {
                    const value = prompt(
                        "TokyoMotion password:",
                        readValue(STORAGE.pass, ""),
                    );
                    if (value !== null) writeValue(STORAGE.pass, value);
                }),
            );
        } catch {}
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
        if (key === "autoHD") {
            if (CONFIG.autoHD) startAutoHD();
            else stopAutoHD();
        }
    }

    function getCredentials() {
        return {
            user: String(readValue(STORAGE.user, "") || "").trim(),
            pass: String(readValue(STORAGE.pass, "") || ""),
        };
    }

    function needsLogin() {
        if (document.querySelector(SELECTORS.loginForm)) return true;
        return !/(^|;\s*)AVS=/.test(document.cookie);
    }

    function isCoolingDown() {
        try {
            if (!sessionStorage.getItem(STORAGE.cooldown)) return false;
            sessionStorage.removeItem(STORAGE.cooldown);
            return true;
        } catch {
            return false;
        }
    }

    function markCooldown() {
        try {
            sessionStorage.setItem(STORAGE.cooldown, "1");
        } catch {}
    }

    function performLogin(username, password) {
        if (!CONFIG.autoLogin || !username || !password) return false;
        log("background login");

        const formData = new URLSearchParams();
        formData.append("username", username);
        formData.append("password", password);
        formData.append("submit_login", "");

        GM_xmlhttpRequest({
            method: "POST",
            url: `${location.origin}/login`,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Referer: location.href,
                Origin: location.origin,
            },
            data: formData.toString(),
            timeout: LOGIN_TIMEOUT_MS,
            onload: (response) => {
                if (response.status >= 200 && response.status < 400) {
                    markCooldown();
                    location.reload();
                } else {
                    log("login failed", response.status);
                }
            },
            onerror: () => log("login request failed"),
            ontimeout: () => log("login request timed out"),
        });
        return true;
    }

    function stopAutoHD() {
        if (autoHdTimer) clearTimeout(autoHdTimer);
        autoHdTimer = 0;
    }

    function closeSourceMenu() {
        setTimeout(() => {
            const menu = document.querySelector(SELECTORS.sourceMenu);
            if (menu) menu.style.display = "none";
        }, 100);
    }

    function startAutoHD() {
        if (!CONFIG.autoHD || autoHdTimer) return;

        let attempts = 0;
        const tick = () => {
            autoHdTimer = 0;
            if (!CONFIG.autoHD || document.hidden) return;

            const hdButton = document.querySelector(SELECTORS.hdSourceButton);
            if (hdButton?.isConnected) {
                hdButton.click();
                closeSourceMenu();
                log("HD selected");
                return;
            }

            attempts++;
            if (attempts < HD_MAX_ATTEMPTS) {
                autoHdTimer = setTimeout(tick, HD_STEP_MS);
            }
        };

        autoHdTimer = setTimeout(tick, HD_STEP_MS);
    }

    function init() {
        if (initialized) return;
        initialized = true;

        injectCleanerCss();
        registerMenuCommands();

        const { user, pass } = getCredentials();
        if (
            CONFIG.autoLogin &&
            user &&
            pass &&
            !isCoolingDown() &&
            needsLogin()
        ) {
            if (performLogin(user, pass)) return;
        }

        startAutoHD();
    }

    window.addEventListener("pagehide", stopAutoHD);
    window.addEventListener("pageshow", () => {
        if (initialized) startAutoHD();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) stopAutoHD();
        else startAutoHD();
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
