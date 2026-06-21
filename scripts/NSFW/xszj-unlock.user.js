// ==UserScript==
// @name         [NSFW] XSZJ Stream Kit
// @namespace    local.xszj.stream-kit
// @version      2026.06.21
// @description  Open list-page video thumbnails in a floating HLS overlay.
// @author       Gholts
// @license      GNU Affero General Public License v3.0
// @match        *://*.lupingik.top/*
// @match        *://*.shanxianzhijia.top/*
// @match        *://*.lubosp.com/*
// @match        *://*.zhiboluping.com/*
// @require      https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-end
// ==/UserScript==

(() => {
    "use strict";

    const DEFAULTS = Object.freeze({
        overlayPlayer: true,
        autoplay: true,
        debug: false,
    });
    const TOGGLES = Object.freeze([
        ["overlayPlayer", "Overlay player"],
        ["autoplay", "Autoplay"],
        ["debug", "Debug logs"],
    ]);
    const STORE_PREFIX = "xszjStreamKit.";
    const STYLE_ID = "xszj-stream-kit-css";
    const THUMB_SELECTOR = 'img[src*="/video/"][src*="vod.jpg"]';
    const CONFIG = { ...DEFAULTS };

    let overlayElement = null;
    let hlsInstance = null;
    let menuCommandIds = [];

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
        if (CONFIG.debug) console.debug("[XSZJStreamKit]", ...args);
    };

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
        if (key === "overlayPlayer" && !CONFIG.overlayPlayer) closeOverlay();
        registerMenuCommands();
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            #xszj-stream-overlay {
                position: fixed;
                inset: 0;
                background: rgba(15, 15, 15, 0.95);
                backdrop-filter: blur(5px);
                z-index: 9999999;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            #xszj-stream-video-wrap {
                width: min(100%, 1280px);
                background: #000;
                border: 1px solid #333;
                border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                overflow: hidden;
            }
            #xszj-stream-video {
                width: 100%;
                max-height: 80vh;
                display: block;
            }
            #xszj-stream-error {
                color: #ff6b6b;
                margin-top: 16px;
                font-weight: 500;
                background: rgba(255, 107, 107, 0.1);
                padding: 12px 20px;
                border-radius: 6px;
                border: 1px solid #ff6b6b;
                display: none;
            }
            .xszj-stream-controls {
                margin-top: 24px;
                display: flex;
                gap: 16px;
                flex-wrap: wrap;
                justify-content: center;
            }
            .xszj-stream-btn {
                padding: 12px 24px;
                border-radius: 6px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
                text-decoration: none;
                transition: background 0.2s ease;
                color: #fff;
            }
            .xszj-stream-copy {
                background: #2b8a3e;
                border: 1px solid #2f9e44;
            }
            .xszj-stream-copy:hover { background: #2f9e44; }
            .xszj-stream-close {
                background: #c92a2a;
                border: 1px solid #e03131;
            }
            .xszj-stream-close:hover { background: #e03131; }
        `;
        document.head.appendChild(style);
    }

    function closeOverlay() {
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }

        const video = document.getElementById("xszj-stream-video");
        if (video) {
            video.pause();
            video.removeAttribute("src");
            video.load();
        }

        overlayElement?.remove();
        overlayElement = null;
    }

    function showError(text) {
        const error = document.getElementById("xszj-stream-error");
        if (!error) return;
        if (text) error.textContent = text;
        error.style.display = "block";
    }

    function createOverlay(m3u8Url) {
        if (overlayElement) closeOverlay();

        injectStyles();

        overlayElement = document.createElement("div");
        overlayElement.id = "xszj-stream-overlay";
        overlayElement.tabIndex = -1;
        overlayElement.innerHTML = `
            <div id="xszj-stream-video-wrap">
                <video id="xszj-stream-video" controls ${CONFIG.autoplay ? "autoplay" : ""}></video>
            </div>
            <div id="xszj-stream-error">
                Video playback failed. Use the copied m3u8 URL in an external player.
            </div>
            <div class="xszj-stream-controls">
                <button id="xszj-stream-copy" class="xszj-stream-btn xszj-stream-copy">Copy m3u8 link</button>
                <button id="xszj-stream-close" class="xszj-stream-btn xszj-stream-close">Close overlay</button>
            </div>
        `;
        document.body.appendChild(overlayElement);

        setupOverlayEvents(m3u8Url);
        setupVideoPlayer(m3u8Url);
        document.getElementById("xszj-stream-video")?.focus();
    }

    function setupOverlayEvents(m3u8Url) {
        document
            .getElementById("xszj-stream-close")
            ?.addEventListener("click", closeOverlay);

        const copyButton = document.getElementById("xszj-stream-copy");
        copyButton?.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(m3u8Url);
                const originalText = copyButton.textContent;
                copyButton.textContent = "Link copied";
                copyButton.style.background = "#099268";
                setTimeout(() => {
                    copyButton.textContent = originalText;
                    copyButton.style.background = "";
                }, 2000);
            } catch (error) {
                log("copy failed", error);
                copyButton.textContent = "Copy failed";
            }
        });

        overlayElement.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeOverlay();
        });
        overlayElement.addEventListener("click", (event) => {
            if (event.target === overlayElement) closeOverlay();
        });
    }

    function setupVideoPlayer(m3u8Url) {
        const video = document.getElementById("xszj-stream-video");
        if (!video) return;

        const HlsCtor = typeof Hls === "undefined" ? null : Hls;
        if (HlsCtor?.isSupported()) {
            let networkRecoveries = 0;
            let mediaRecoveries = 0;
            hlsInstance = new HlsCtor({
                debug: false,
                enableWorker: true,
                backBufferLength: 90,
            });

            hlsInstance.loadSource(m3u8Url);
            hlsInstance.attachMedia(video);
            hlsInstance.on(HlsCtor.Events.ERROR, (event, data) => {
                if (!data?.fatal || !hlsInstance) return;

                log("fatal hls error", data);
                if (
                    data.type === HlsCtor.ErrorTypes.NETWORK_ERROR &&
                    networkRecoveries < 2
                ) {
                    networkRecoveries++;
                    hlsInstance.startLoad();
                    return;
                }

                if (
                    data.type === HlsCtor.ErrorTypes.MEDIA_ERROR &&
                    mediaRecoveries < 2
                ) {
                    mediaRecoveries++;
                    hlsInstance.recoverMediaError();
                    return;
                }

                showError();
                hlsInstance.destroy();
                hlsInstance = null;
            });
            return;
        }

        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = m3u8Url;
            video.addEventListener("error", () => showError(), { once: true });
            return;
        }

        showError("This browser does not support HLS playback.");
    }

    function getVideoUrlFromClick(event) {
        if (!CONFIG.overlayPlayer) return null;

        const anchor = event.target.closest?.("a");
        if (!anchor?.href) return null;

        let pageUrl;
        try {
            pageUrl = new URL(anchor.href, location.href);
        } catch {
            return null;
        }
        if (!pageUrl.pathname.endsWith(".html")) return null;

        const image =
            event.target.closest?.(THUMB_SELECTOR) ||
            anchor.querySelector(THUMB_SELECTOR);
        const imageSrc = image?.currentSrc || image?.src;
        if (!imageSrc) return null;

        try {
            const streamUrl = new URL(imageSrc, location.href);
            if (!/\/video\/.*vod\.jpg$/.test(streamUrl.pathname)) return null;
            streamUrl.pathname = streamUrl.pathname.replace(
                /vod\.jpg$/,
                "index.m3u8",
            );
            streamUrl.search = "";
            streamUrl.hash = "";
            return streamUrl.href;
        } catch {
            return null;
        }
    }

    document.addEventListener(
        "click",
        (event) => {
            const m3u8Url = getVideoUrlFromClick(event);
            if (!m3u8Url) return;

            event.preventDefault();
            event.stopPropagation();
            log("opening overlay", m3u8Url);
            createOverlay(m3u8Url);
        },
        true,
    );

    window.addEventListener("pagehide", closeOverlay);
    registerMenuCommands();
})();
