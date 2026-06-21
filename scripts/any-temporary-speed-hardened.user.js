// ==UserScript==
// @name         Temporary Speed Kit
// @namespace    local.temporary-speed.kit
// @version      2026.06.21
// @description  Hold a key to speed up playing videos, release to restore.
// @author       Gholts
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addStyle
// @run-at       document-start
// @downloadURL https://update.greasyfork.org/scripts/564842/Temporary%20Speed%20%28Hold%20to%20Speed%20Up%29.user.js
// @updateURL https://update.greasyfork.org/scripts/564842/Temporary%20Speed%20%28Hold%20to%20Speed%20Up%29.meta.js
// ==/UserScript==

(function () {
    "use strict";

    const DEFAULTS = Object.freeze({
        speed: 3,
        key: "c",
        pitch: true,
        syncFix: true,
    });
    const MIN_SPEED = 0.25;
    const MAX_SPEED = 16;

    const originalByVideo = new Map();
    let active = false;
    let toastNode = null;
    let settings = loadSettings();
    let menuCommandIds = [];

    function clampSpeed(value) {
        const speed = Number.parseFloat(value);
        if (!Number.isFinite(speed)) return DEFAULTS.speed;
        return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
    }

    function normalizeKey(value) {
        const key = String(value || DEFAULTS.key)
            .trim()
            .toLowerCase();
        return key.length === 1 ? key : DEFAULTS.key;
    }

    function loadSettings() {
        return {
            speed: clampSpeed(GM_getValue("target_speed", DEFAULTS.speed)),
            key: normalizeKey(GM_getValue("trigger_key", DEFAULTS.key)),
            pitch: Boolean(GM_getValue("preserve_pitch", DEFAULTS.pitch)),
            syncFix: Boolean(GM_getValue("av_sync_fix", DEFAULTS.syncFix)),
        };
    }

    function setSpeed(value) {
        settings.speed = clampSpeed(value);
        GM_setValue("target_speed", settings.speed);
        return settings.speed;
    }

    function setKey(value) {
        settings.key = normalizeKey(value);
        GM_setValue("trigger_key", settings.key);
        return settings.key;
    }

    function setPitch(value) {
        settings.pitch = Boolean(value);
        GM_setValue("preserve_pitch", settings.pitch);
        return settings.pitch;
    }

    function setSyncFix(value) {
        settings.syncFix = Boolean(value);
        GM_setValue("av_sync_fix", settings.syncFix);
        return settings.syncFix;
    }

    function getPlayingVideos(root = document, out = new Set()) {
        if (!root || !root.querySelectorAll) return out;

        root.querySelectorAll("video").forEach((video) => {
            if (!video.paused && !video.ended) out.add(video);
        });

        root.querySelectorAll("*").forEach((element) => {
            if (element.shadowRoot) getPlayingVideos(element.shadowRoot, out);
        });

        return out;
    }

    function getPitch(video) {
        if ("preservesPitch" in video) return video.preservesPitch;
        if ("mozPreservesPitch" in video) return video.mozPreservesPitch;
        if ("webkitPreservesPitch" in video) return video.webkitPreservesPitch;
        return true;
    }

    function setVideoPitch(video, value) {
        try {
            if ("preservesPitch" in video) video.preservesPitch = value;
            else if ("mozPreservesPitch" in video)
                video.mozPreservesPitch = value;
            else if ("webkitPreservesPitch" in video)
                video.webkitPreservesPitch = value;
        } catch (_) {}
    }

    function setVideoSpeed(video, speed) {
        try {
            video.playbackRate = speed;
            return true;
        } catch (_) {
            return false;
        }
    }

    function applySpeed(video) {
        if (!originalByVideo.has(video)) {
            originalByVideo.set(video, {
                speed: video.playbackRate,
                pitch: getPitch(video),
            });
        }

        if (!setVideoSpeed(video, settings.speed)) return false;
        setVideoPitch(video, settings.pitch);
        return true;
    }

    function restoreVideo(video, original) {
        setVideoSpeed(video, original.speed);
        setVideoPitch(video, original.pitch);

        if (!settings.syncFix || !Number.isFinite(video.currentTime)) return;
        try {
            video.currentTime = video.currentTime;
        } catch (_) {}
    }

    function activateSpeed() {
        if (active) return;

        let changed = false;
        getPlayingVideos().forEach((video) => {
            changed = applySpeed(video) || changed;
        });

        if (!changed) {
            originalByVideo.clear();
            return;
        }

        active = true;
        showToast(`Speed x${settings.speed}`);
    }

    function restoreSpeed() {
        if (!active) return;

        originalByVideo.forEach((original, video) =>
            restoreVideo(video, original),
        );
        originalByVideo.clear();
        active = false;
        hideToast();
    }

    function isEditableTarget(target) {
        if (!target || !target.tagName) return false;
        const tag = target.tagName.toUpperCase();
        return (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            tag === "SELECT" ||
            Boolean(target.isContentEditable)
        );
    }

    function isTriggerEvent(event) {
        return (
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.metaKey &&
            typeof event.key === "string" &&
            event.key.toLowerCase() === settings.key
        );
    }

    function showToast(text) {
        const container =
            document.fullscreenElement ||
            document.body ||
            document.documentElement;
        if (!container) return;

        if (!toastNode) {
            toastNode = document.createElement("div");
            toastNode.className = "vm-speed-toast";
            toastNode.setAttribute("aria-hidden", "true");
        }

        if (toastNode.parentNode !== container) {
            appendToast(container);
        }

        toastNode.textContent = text;
        toastNode.style.opacity = "1";
    }

    function appendToast(container) {
        try {
            container.appendChild(toastNode);
        } catch (_) {
            const fallback = document.body || document.documentElement;
            if (fallback && toastNode.parentNode !== fallback)
                fallback.appendChild(toastNode);
        }
    }

    function hideToast() {
        if (toastNode) toastNode.style.opacity = "0";
    }

    document.addEventListener(
        "keydown",
        (event) => {
            if (
                event.repeat ||
                active ||
                !isTriggerEvent(event) ||
                isEditableTarget(event.target)
            )
                return;
            activateSpeed();
        },
        true,
    );

    document.addEventListener(
        "keyup",
        (event) => {
            if (isTriggerEvent(event)) restoreSpeed();
        },
        true,
    );

    window.addEventListener("blur", restoreSpeed);
    window.addEventListener("pagehide", restoreSpeed);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) restoreSpeed();
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

        const commands = [
            [
                `Set speed (${settings.speed}x)`,
                () => {
                    const value = prompt(
                        `Target speed (${MIN_SPEED}-${MAX_SPEED}):`,
                        settings.speed,
                    );
                    if (value !== null) {
                        setSpeed(value);
                        registerMenuCommands();
                    }
                },
            ],
            [
                `Set trigger key (${settings.key.toUpperCase()})`,
                () => {
                    const value = prompt("Single trigger key:", settings.key);
                    if (value !== null) {
                        setKey(value);
                        registerMenuCommands();
                    }
                },
            ],
            [
                `Audio pitch = ${settings.pitch ? "on" : "off"}`,
                () => {
                    setPitch(!settings.pitch);
                    registerMenuCommands();
                },
            ],
            [
                `A/V sync fix = ${settings.syncFix ? "on" : "off"}`,
                () => {
                    setSyncFix(!settings.syncFix);
                    registerMenuCommands();
                },
            ],
        ];

        for (const [label, action] of commands) {
            try {
                const id = GM_registerMenuCommand(
                    canRefresh ? label : label.replace(/ = .+$/, ""),
                    action,
                );
                menuCommandIds.push(id);
            } catch {}
        }
    }

    registerMenuCommands();

    GM_addStyle(`
.vm-speed-toast {
    all: initial !important;
    position: fixed !important;
    top: 20px !important;
    right: 20px !important;
    box-sizing: border-box !important;
    max-width: min(220px, calc(100vw - 40px)) !important;
    background: rgba(0, 0, 0, 0.72) !important;
    color: #fff !important;
    padding: 6px 10px !important;
    border-radius: 6px !important;
    font: 14px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
    user-select: none !important;
    opacity: 0 !important;
    transition: opacity 150ms ease-out !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
}
    `);
})();
