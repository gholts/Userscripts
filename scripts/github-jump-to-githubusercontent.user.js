// ==UserScript==
// @name         GitHub Raw Jump Kit
// @namespace    local.github.jump-to-githubusercontent
// @version      2026.06.21
// @description  Add GitHub-style jumps between blob pages and raw.githubusercontent.com.
// @author       Gholts
// @license      GNU Affero General Public License v3.0
// @match        https://github.com/*/*/blob/*
// @match        https://raw.githubusercontent.com/*/*/*
// @icon         https://github.githubassets.com/favicons/favicon.svg
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    "use strict";

    const STORE = "githubRawJumpKit.";
    const HEADER_ID = "github-raw-jump-header-button";
    const RAW_ID = "github-raw-jump-page-button";
    const WRAP = "data-github-raw-jump";
    const RAW_LINKS =
        'a[data-testid="raw-button"],a[href*="/raw/"],a[href*="?raw=1"]';
    const BUTTON_GROUP = '[data-component="ButtonGroup"]';
    const FALLBACK_CLASS =
        "prc-Button-ButtonBase-9n-Xk LinkButton-module__linkButton__nFnov BlobViewHeader-module__LinkButton__X9kx2";
    const FALLBACK_HTML =
        '<span data-component="buttonContent" data-align="center" class="prc-Button-ButtonContent-Iohp5"><span data-component="text" class="prc-Button-Label-FWkx3">Raw CDN</span></span>';
    const DEFAULTS = { headerButton: true, rawPageButton: true, debug: false };
    const MENUS = [
        ["headerButton", "Header button"],
        ["rawPageButton", "Raw page button"],
        ["debug", "Debug logs"],
    ];
    const config = { ...DEFAULTS };
    const state = { menus: [], observer: null, timer: 0, started: false };

    function read(key) {
        try {
            const value = GM_getValue(`${STORE}${key}`, DEFAULTS[key]);
            if (typeof value === "boolean") return value;
        } catch {}
        return DEFAULTS[key];
    }

    function write(key, value) {
        try {
            GM_setValue(`${STORE}${key}`, value);
        } catch {}
    }

    function log(...args) {
        if (config.debug) console.debug("[GitHubRawJumpKit]", ...args);
    }

    function menus() {
        if (typeof GM_registerMenuCommand !== "function") return;
        for (const id of state.menus) {
            try {
                GM_unregisterMenuCommand(id);
            } catch {}
        }
        state.menus = MENUS.map(([key, label]) =>
            GM_registerMenuCommand(
                `${label} = ${config[key] ? "on" : "off"}`,
                () => {
                    config[key] = !config[key];
                    write(key, config[key]);
                    menus();
                    render();
                },
            ),
        );
    }

    for (const [key] of MENUS) config[key] = read(key);

    function asUrl(href) {
        try {
            return new URL(href, location.href);
        } catch {
            return null;
        }
    }

    function toRaw(href) {
        const url = asUrl(href);
        if (!url) return "";
        if (url.hostname === "raw.githubusercontent.com") return url.href;
        if (url.hostname !== "github.com") return "";

        const parts = url.pathname.split("/").filter(Boolean);
        const marker = parts.findIndex(
            (part) => part === "blob" || part === "raw",
        );
        if (marker !== 2 || parts.length < 5) return "";
        parts.splice(marker, 1);

        const raw = new URL(
            `https://raw.githubusercontent.com/${parts.join("/")}`,
        );
        raw.search = url.search;
        raw.hash = url.hash;
        return raw.href;
    }

    function toGitHub(href) {
        const url = asUrl(href);
        if (!url || url.hostname !== "raw.githubusercontent.com") return "";
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length < 4) return "";

        const [owner, repo, ...file] = parts;
        const github = new URL(
            `https://github.com/${owner}/${repo}/blob/${file.join("/")}`,
        );
        github.hash = url.hash;
        return github.href;
    }

    function rawLink() {
        return [...document.querySelectorAll(RAW_LINKS)].find((link) => {
            if (link.id === HEADER_ID) return false;
            return (
                link.dataset.testid === "raw-button" ||
                /\braw\b/i.test(link.textContent)
            );
        });
    }

    function setLabel(button, label) {
        const node =
            button.querySelector("[data-component='text']") ||
            button.querySelector(".Button-label");
        if (node) node.textContent = label;
        else button.textContent = label;
    }

    function normalize(button, template, href) {
        button.id = HEADER_ID;
        button.href = href;
        button.className = template?.className || FALLBACK_CLASS;
        button.dataset.testid = "raw-githubusercontent-button";
        button.setAttribute("aria-label", "Open raw.githubusercontent.com");
        button.setAttribute("data-component", "LinkButton");
        button.setAttribute("data-loading", "false");
        button.setAttribute("data-no-visuals", "true");
        button.setAttribute("data-size", "small");
        button.setAttribute("data-turbo", "false");
        button.setAttribute("data-variant", "default");
        button.removeAttribute("aria-labelledby");
        button.removeAttribute("data-discover");
        button.removeAttribute("download");
        button.removeAttribute("target");
        if (!button.querySelector("[data-component='buttonContent']")) {
            button.innerHTML = FALLBACK_HTML;
        }
        setLabel(button, "Raw CDN");
    }

    function removeHeader() {
        const button = document.getElementById(HEADER_ID);
        const wrap = button?.closest(`[${WRAP}="true"]`);
        if (wrap) wrap.remove();
        else button?.remove();
    }

    function renderGitHub() {
        document.getElementById(RAW_ID)?.remove();
        if (!config.headerButton) {
            removeHeader();
            return;
        }

        const raw = rawLink();
        const href = toRaw(raw?.href || location.href);
        const group = raw?.closest(BUTTON_GROUP);
        const parent = raw?.parentElement;
        if (!raw || !href || !group || parent?.parentElement !== group) {
            log("toolbar not ready");
            return;
        }

        const current = document.getElementById(HEADER_ID);
        if (current?.closest(BUTTON_GROUP) === group) {
            normalize(current, raw, href);
            return;
        }

        removeHeader();
        const wrap = document.createElement("div");
        wrap.setAttribute(WRAP, "true");
        const button = raw.cloneNode(true);
        normalize(button, raw, href);
        wrap.appendChild(button);
        parent.after(wrap);
    }

    function renderRaw() {
        removeHeader();
        const href = toGitHub(location.href);
        const current = document.getElementById(RAW_ID);
        if (!config.rawPageButton || !href || !document.body) {
            current?.remove();
            return;
        }
        if (current) {
            current.href = href;
            return;
        }

        const button = document.createElement("a");
        button.id = RAW_ID;
        button.href = href;
        button.textContent = "View on GitHub";
        button.setAttribute("aria-label", "View on GitHub");
        button.style.cssText = [
            "position:fixed",
            "top:12px",
            "right:12px",
            "z-index:2147483647",
            "padding:5px 12px",
            "border:1px solid #d0d7de",
            "border-radius:6px",
            "background:#f6f8fa",
            "color:#24292f",
            "font:600 12px/20px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "text-decoration:none",
            "box-shadow:0 1px 0 rgba(27,31,36,.04)",
        ].join(";");
        document.body.appendChild(button);
    }

    function render() {
        if (location.hostname === "github.com") renderGitHub();
        if (location.hostname === "raw.githubusercontent.com") renderRaw();
    }

    function schedule() {
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = 0;
            render();
        }, 120);
    }

    function patchHistory() {
        for (const key of ["pushState", "replaceState"]) {
            const original = history[key];
            if (original.__githubRawJumpKit) continue;
            history[key] = function patchedHistory(...args) {
                const result = original.apply(this, args);
                schedule();
                return result;
            };
            history[key].__githubRawJumpKit = true;
        }
    }

    function start() {
        if (!state.started) {
            state.started = true;
            menus();
            patchHistory();
            window.addEventListener("popstate", schedule);
            window.addEventListener("pageshow", schedule);
            document.addEventListener("turbo:load", schedule);
            document.addEventListener("turbo:render", schedule);
        }
        if (!state.observer && document.documentElement) {
            state.observer = new MutationObserver(schedule);
            state.observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
        }
        render();
    }

    start();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    }
})();
