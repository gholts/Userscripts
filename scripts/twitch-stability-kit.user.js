// ==UserScript==
// @name         Twitch Stability Kit
// @namespace    local.twitch.stability-kit
// @version      2026.06.21
// @description  Max quality, channel points, live recovery, UI cleanup, and gentle playback keepalive for Twitch.
// @match        https://www.twitch.tv/*
// @match        https://player.twitch.tv/*
// @match        https://embed.twitch.tv/*
// @icon         https://assets.twitch.tv/assets/favicon-32-e29e246c157142c94346.png
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(() => {
    "use strict";

    const DEFAULTS = Object.freeze({
        maxQuality: true,
        autoClaimPoints: true,
        autoBackToLive: true,
        autoStartWatching: true,
        cleanUi: true,
        keepPlaying: true,
        wakeLock: false,
        debug: false,
        qualityBurstMs: 10000,
        qualityStepMs: 500,
        playerCacheMs: 3000,
        playerMissCacheMs: 1000,
        playerMissBackoffMaxMs: 30000,
        maxFiberNodes: 1000,
        maxFiberAncestors: 60,
        domCooldownMs: 250,
        claimCooldownMs: 3500,
        liveCooldownMs: 2500,
        gateCooldownMs: 3000,
        manualPauseWindowMs: 1500,
        pipKeepaliveMs: 12000,
        qualityStallWindowMs: 60000,
        qualityStallLimit: 3,
        qualitySuspendMs: 60000,
    });

    const TOGGLES = Object.freeze([
        ["maxQuality", "Max quality"],
        ["autoClaimPoints", "Claim points"],
        ["autoBackToLive", "Back to live"],
        ["autoStartWatching", "Start watching"],
        ["cleanUi", "Clean UI"],
        ["keepPlaying", "Keep playing"],
        ["wakeLock", "Wake lock"],
        ["debug", "Debug logs"],
    ]);
    const STORE_PREFIX = "twitchStabilityKit.";
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

    const host = location.hostname;
    const path = location.pathname || "";
    const isFrame = (() => {
        try {
            return window.frameElement !== null;
        } catch {
            return true;
        }
    })();
    const isEmbed =
        host === "player.twitch.tv" ||
        host === "embed.twitch.tv" ||
        path.startsWith("/embed/");
    if (isFrame && !isEmbed) return;

    const pageGlobal =
        typeof unsafeWindow === "object" && unsafeWindow
            ? unsafeWindow
            : window;
    const CHAT_MUTATION_SELECTOR =
        '.chat-room, .chat-list, [data-a-target="chat-container"], [data-test-selector="chat-scrollable-area__message-container"]';

    const log = (...args) => {
        if (CONFIG.debug) console.debug("[TwitchKit]", ...args);
    };

    const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
    };

    const onceBody = (fn) => {
        let done = false;
        let mo = null;
        const run = () => {
            if (done || !document.body) return;
            done = true;
            mo?.disconnect();
            fn();
        };
        if (document.body) {
            run();
            return;
        }
        document.addEventListener("DOMContentLoaded", run, { once: true });
        if (document.documentElement) {
            mo = new MutationObserver(run);
            mo.observe(document.documentElement, { childList: true });
        }
    };

    const PLAYER_ROOT_SELECTOR =
        '[data-a-target="video-player"], [data-a-target="player-container"], .video-player';
    let lastMainVideo = null;

    function getPlayerRoot() {
        const root = document.querySelector(PLAYER_ROOT_SELECTOR);
        if (root) return root;
        return isEmbed ? document.body : null;
    }

    function getMainVideo() {
        const root = getPlayerRoot();
        const pipVideo = document.pictureInPictureElement;
        if (pipVideo?.tagName === "VIDEO" && pipVideo.isConnected) {
            lastMainVideo = pipVideo;
            return pipVideo;
        }
        if (!root) return lastMainVideo?.isConnected ? lastMainVideo : null;
        const video = [...root.querySelectorAll("video")].find(
            (video) =>
                isVisible(video) && !video.closest('[class*="carousel"]'),
        );
        if (video) {
            lastMainVideo = video;
            return video;
        }
        return root.contains(lastMainVideo) ? lastMainVideo : null;
    }

    function injectCleanerCss() {
        const existing = document.getElementById("twitch-kit-css");
        if (!CONFIG.cleanUi) {
            existing?.remove();
            return;
        }
        if (existing) return;
        const style = document.createElement("style");
        style.id = "twitch-kit-css";
        style.textContent = `
      [data-test-selector="extension-disclaimer"],
      [data-a-target="top-nav-get-bits-button"],
      .top-nav__prime,
      [data-a-target="side-nav-stories-root"],
      [class*="storiesLeftNavSection"],
      [class*="storiesLeftNavSectionCollapsedButton"] {
        display: none !important;
      }
    `;
        (document.head || document.documentElement).appendChild(style);
    }

    function getFiber(el) {
        if (!el) return null;
        for (const key in el) {
            if (
                key.startsWith("__reactFiber$") ||
                key.startsWith("__reactInternalInstance$") ||
                key.startsWith("__reactContainer$")
            ) {
                return el[key];
            }
        }
        return null;
    }

    function asPlayer(value) {
        if (!value) return null;
        const direct =
            value.mediaPlayerInstance ||
            value.playerInstance ||
            value.player ||
            value;
        if (
            direct &&
            typeof direct.getQualities === "function" &&
            typeof direct.setQuality === "function"
        )
            return direct;
        if (
            direct?.core &&
            typeof direct.core.getQualities === "function" &&
            typeof direct.setQuality === "function"
        )
            return direct;
        return null;
    }

    function playerFromFiber(node) {
        const buckets = [
            node.memoizedProps,
            node.pendingProps,
            node.stateNode,
            node.stateNode?.props,
        ];
        for (const bucket of buckets) {
            const player = asPlayer(bucket);
            if (player) return player;
        }
        return null;
    }

    function scanFiberAncestors(start) {
        const seen = new Set();
        let node = start;
        let count = 0;

        while (node && count++ < CONFIG.maxFiberAncestors) {
            if (seen.has(node)) return null;
            seen.add(node);
            const player = playerFromFiber(node);
            if (player) return player;
            node = node.return;
        }

        return null;
    }

    function scanFiber(start) {
        if (!start) return null;
        const seen = new Set();
        const stack = [start];
        let count = 0;

        while (stack.length && count < CONFIG.maxFiberNodes) {
            const node = stack.pop();
            if (!node || seen.has(node)) continue;
            seen.add(node);
            count += 1;

            const player = playerFromFiber(node);
            if (player) return player;

            if (node.child) stack.push(node.child);
            if (node !== start && node.sibling) stack.push(node.sibling);
        }

        return null;
    }

    let cachedPlayer = null;
    let cachedVideo = null;
    let cachedAt = 0;
    let playerMissCount = 0;
    let playerBackoffUntil = 0;

    function findPlayer() {
        const now = Date.now();
        const video = getMainVideo();
        if (
            cachedPlayer &&
            cachedVideo === video &&
            now - cachedAt < CONFIG.playerCacheMs
        )
            return cachedPlayer;
        if (
            !cachedPlayer &&
            cachedVideo === video &&
            now - cachedAt < CONFIG.playerMissCacheMs
        )
            return null;
        if (!cachedPlayer && now < playerBackoffUntil) return null;

        const root = getPlayerRoot();
        const roots = [video, root].filter(Boolean);

        for (const root of roots) {
            const fiber = getFiber(root);
            const player = scanFiberAncestors(fiber) || scanFiber(fiber);
            if (player) {
                cachedPlayer = player;
                cachedVideo = video;
                cachedAt = now;
                playerMissCount = 0;
                playerBackoffUntil = 0;
                return player;
            }
        }

        cachedPlayer = null;
        cachedVideo = video;
        cachedAt = now;
        playerMissCount += 1;
        if (playerMissCount >= 5) {
            const delay = Math.min(
                CONFIG.playerMissBackoffMaxMs,
                CONFIG.playerMissCacheMs *
                    2 ** Math.min(playerMissCount - 5, 5),
            );
            playerBackoffUntil = now + delay;
        }
        return null;
    }

    const qualityLabel = (q) =>
        String(q?.group || q?.name || q?.quality || q || "");
    const qualityParts = (q) =>
        [
            q?.group,
            q?.name,
            q?.quality,
            q?.label,
            q?.displayName,
            typeof q === "string" ? q : null,
        ]
            .filter(Boolean)
            .map(String);
    const qualityHeight = (q) => {
        const label = qualityLabel(q).toLowerCase();
        const parsed = label.match(/(\d{3,4})p/);
        if (Number(q?.height)) return Number(q.height);
        if (parsed) return Number(parsed[1]);
        if (label === "source" || label === "chunked") return 10000;
        return 0;
    };
    const qualityFps = (q) => {
        const parsed = qualityLabel(q).match(/p(\d{2,3})/);
        return Number(
            q?.frameRate || q?.framerate || (parsed && parsed[1]) || 0,
        );
    };
    const isAutoQuality = (q) => {
        return qualityParts(q).some((part) => {
            const label = part.toLowerCase();
            return label === "auto" || label.includes("auto");
        });
    };

    function getQualities(player) {
        try {
            const qs = player.getQualities?.();
            if (Array.isArray(qs) && qs.length) return qs;
        } catch {}
        try {
            const qs = player.core?.getQualities?.();
            if (Array.isArray(qs)) return qs;
        } catch {}
        return [];
    }

    function currentQualityMatches(player, best) {
        let current;
        try {
            current = player.getQuality?.();
        } catch {}
        const bestIds = new Set(
            [best?.group, best?.name, best?.quality]
                .filter(Boolean)
                .map(String),
        );
        const currentIds = [
            current?.group,
            current?.name,
            current?.quality,
            typeof current === "string" ? current : null,
        ]
            .filter(Boolean)
            .map(String);
        return currentIds.some((id) => bestIds.has(id));
    }

    function disableAutoQuality(player) {
        try {
            player.setAutoQualityMode?.(false);
        } catch {}
    }

    function applyQuality(player, best) {
        disableAutoQuality(player);
        const targets = [best?.group, best?.name, best?.quality, best].filter(
            (x) => x !== undefined && x !== null && x !== "",
        );
        for (const target of targets) {
            try {
                player.setQuality(target, false);
                return true;
            } catch {}
            try {
                player.setQuality(target);
                return true;
            } catch {}
        }
        return false;
    }

    function forceBestQuality() {
        if (!CONFIG.maxQuality || qualityBlocked()) return false;
        const player = findPlayer();
        if (!player) return false;

        const choices = getQualities(player)
            .filter((q) => q && !isAutoQuality(q))
            .sort(
                (a, b) =>
                    qualityHeight(b) - qualityHeight(a) ||
                    qualityFps(b) - qualityFps(a) ||
                    Number(b?.bitrate || 0) - Number(a?.bitrate || 0),
            );

        const best = choices[0];
        if (!best) return false;
        disableAutoQuality(player);
        if (currentQualityMatches(player, best)) return true;
        const applied = applyQuality(player, best);
        if (applied) log("quality", qualityLabel(best));
        return applied;
    }

    let qualityTimer = 0;
    let qualityUntil = 0;
    let qualityOk = 0;
    let qualitySuspendedUntil = 0;
    const qualityStalls = [];

    function qualityBlocked() {
        return Date.now() < qualitySuspendedUntil;
    }

    function recordQualityStall() {
        const now = Date.now();
        while (
            qualityStalls.length &&
            now - qualityStalls[0] > CONFIG.qualityStallWindowMs
        ) {
            qualityStalls.shift();
        }
        qualityStalls.push(now);
        if (qualityStalls.length >= CONFIG.qualityStallLimit) {
            qualitySuspendedUntil = now + CONFIG.qualitySuspendMs;
            stopQualityBurst();
            qualityStalls.length = 0;
            log("quality suspended");
        }
    }

    function burstQuality(durationMs = CONFIG.qualityBurstMs) {
        if (!CONFIG.maxQuality || qualityBlocked() || !getPlayerRoot()) return;
        qualityUntil = Math.max(qualityUntil, Date.now() + durationMs);
        qualityOk = 0;
        if (qualityTimer) return;

        const tick = () => {
            qualityTimer = 0;
            let ok = false;
            try {
                ok = forceBestQuality();
            } catch (err) {
                log("quality error", err);
            }
            if (ok && ++qualityOk >= 2) return;
            if (Date.now() <= qualityUntil)
                qualityTimer = window.setTimeout(tick, CONFIG.qualityStepMs);
        };

        qualityTimer = window.setTimeout(tick, 0);
    }

    function stopQualityBurst() {
        if (qualityTimer) window.clearTimeout(qualityTimer);
        qualityTimer = 0;
        qualityUntil = 0;
        qualityOk = 0;
    }

    function claimPoints() {
        if (!CONFIG.autoClaimPoints) return;
        const now = Date.now();
        if (now - claimPoints.lastClick < CONFIG.claimCooldownMs) return;

        const selectors = [
            '[data-test-selector="community-points-summary"] .claimable-bonus__icon',
            ".claimable-bonus__icon",
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            const button =
                el?.closest?.("button") ||
                (el?.tagName === "BUTTON" ? el : null);
            if (button && !button.disabled && isVisible(button)) {
                claimPoints.lastClick = now;
                button.click();
                log("claimed points");
                return;
            }
        }

        const buttons = document.querySelectorAll(
            "button[aria-label], button[data-test-selector]",
        );
        for (const button of buttons) {
            const label =
                `${button.getAttribute("aria-label") || ""} ${button.getAttribute("data-test-selector") || ""}`.toLowerCase();
            if (
                !button.disabled &&
                isVisible(button) &&
                label.includes("claim") &&
                (label.includes("bonus") || label.includes("point"))
            ) {
                claimPoints.lastClick = now;
                button.click();
                log("claimed points");
                return;
            }
        }
    }
    claimPoints.lastClick = 0;

    const backToLivePatterns = [
        /\bback\s+to\s+live\b/,
        /\breturn\s+to\s+live\b/,
        /\bgo\s+to\s+live\b/,
        /voltar.*(live|vivo)/,
        /retour.*direct/,
        /zur[u\u00fc]ck.*live/,
        /volver.*(live|directo|vivo)/,
        /regresar.*(live|directo|vivo)/,
        /\u623b\u308b.*(\u30e9\u30a4\u30d6|live)/,
        /\u8fd4\u56de.*(\u76f4\u64ad|live)/,
    ];
    const blockWords = [
        "clip",
        "settings",
        "config",
        "follow",
        "subscribe",
        "chat",
        "share",
    ];

    function clickBackToLive() {
        if (!CONFIG.autoBackToLive) return;
        const now = Date.now();
        if (now - clickBackToLive.lastClick < CONFIG.liveCooldownMs) return;

        const root = getPlayerRoot();
        if (!root) return;

        const buttons = root.querySelectorAll("button");
        for (const button of buttons) {
            if (!isVisible(button) || button.disabled) continue;
            const label =
                `${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.dataset?.aTarget || ""}`.toLowerCase();
            if (
                label.length > 90 ||
                blockWords.some((word) => label.includes(word))
            )
                continue;
            if (
                button.dataset?.aTarget?.includes("back-to-live") ||
                backToLivePatterns.some((pattern) => pattern.test(label))
            ) {
                clickBackToLive.lastClick = now;
                button.click();
                burstQuality(4000);
                log("back to live");
                return;
            }
        }
    }
    clickBackToLive.lastClick = 0;

    function clickContentGate() {
        if (!CONFIG.autoStartWatching) return;
        const now = Date.now();
        if (now - clickContentGate.lastClick < CONFIG.gateCooldownMs) return;
        const root = getPlayerRoot();
        if (!root) return;

        const selectors = [
            '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
            '[data-a-target="player-overlay-content-gate"] button:not([disabled])',
        ];

        for (const selector of selectors) {
            const button = root.querySelector(selector);
            if (button && !button.disabled && isVisible(button)) {
                clickContentGate.lastClick = now;
                button.click();
                log("content gate");
                return;
            }
        }
    }
    clickContentGate.lastClick = 0;

    function restoreCarousel() {
        document
            .querySelectorAll('[data-twitch-kit-hidden="1"]')
            .forEach((box) => {
                box.hidden = false;
                delete box.dataset.twitchKitHidden;
            });
    }

    function cleanCarousel() {
        if (!CONFIG.cleanUi) {
            restoreCarousel();
            return;
        }
        document
            .querySelectorAll('[class*="carousel"] video')
            .forEach((video) => {
                try {
                    video.muted = true;
                    video.volume = 0;
                    video.pause();
                } catch {}
                const box = video.closest('[class*="carousel"]');
                if (box && !box.hidden) {
                    box.dataset.twitchKitHidden = "1";
                    box.hidden = true;
                }
            });
    }

    const boundVideos = new WeakSet();
    let wasPlaying = false;
    let lastPlayerInputAt = 0;
    let lastManualPauseAt = 0;
    let inPictureInPicture = false;
    let pipKeepaliveTimer = 0;

    function isManagedVideo(video) {
        return video?.isConnected && video === getMainVideo();
    }

    function isPiPVideo(video = getMainVideo()) {
        return (
            !!video &&
            (inPictureInPicture || document.pictureInPictureElement === video)
        );
    }

    function stopPiPKeepalive() {
        if (pipKeepaliveTimer) window.clearInterval(pipKeepaliveTimer);
        pipKeepaliveTimer = 0;
    }

    function shouldPiPKeepalive() {
        const video = getMainVideo();
        return (
            !!video &&
            isPiPVideo(video) &&
            (CONFIG.maxQuality || CONFIG.keepPlaying)
        );
    }

    function runPiPKeepalive() {
        const video = getMainVideo();
        if (!video || !isPiPVideo(video)) return;
        if (CONFIG.maxQuality) forceBestQuality();
        if (CONFIG.keepPlaying && wasPlaying && video.paused && !video.ended)
            resumeVideo();
    }

    function updatePiPKeepalive() {
        if (!shouldPiPKeepalive()) {
            stopPiPKeepalive();
            return;
        }
        runPiPKeepalive();
        if (!pipKeepaliveTimer) {
            pipKeepaliveTimer = window.setInterval(() => {
                if (shouldPiPKeepalive()) runPiPKeepalive();
                else stopPiPKeepalive();
            }, CONFIG.pipKeepaliveMs);
        }
    }

    function recoverPlaybackSoon(delayMs = 1000) {
        if (!CONFIG.keepPlaying || !wasPlaying || !isPiPVideo()) return;
        window.setTimeout(() => {
            resumeVideo();
            if (CONFIG.maxQuality) forceBestQuality();
        }, delayMs);
    }

    function bindVideo(video) {
        if (!video || boundVideos.has(video)) return;
        boundVideos.add(video);
        video.addEventListener(
            "play",
            () => {
                if (!isManagedVideo(video)) return;
                wasPlaying = true;
                burstQuality(6000);
                updatePiPKeepalive();
            },
            true,
        );
        video.addEventListener(
            "playing",
            () => {
                if (!isManagedVideo(video)) return;
                wasPlaying = true;
                burstQuality(6000);
                updatePiPKeepalive();
            },
            true,
        );
        video.addEventListener(
            "pause",
            () => {
                if (!isManagedVideo(video)) return;
                const now = Date.now();
                if (
                    !document.hidden ||
                    now - lastPlayerInputAt < CONFIG.manualPauseWindowMs
                ) {
                    wasPlaying = false;
                    lastManualPauseAt = now;
                } else {
                    recoverPlaybackSoon();
                }
            },
            true,
        );
        video.addEventListener(
            "enterpictureinpicture",
            () => {
                if (!isManagedVideo(video)) return;
                inPictureInPicture = true;
                wasPlaying = !video.paused && !video.ended;
                burstQuality(15000);
                updatePiPKeepalive();
            },
            true,
        );
        video.addEventListener(
            "leavepictureinpicture",
            () => {
                inPictureInPicture = false;
                stopPiPKeepalive();
            },
            true,
        );
        for (const name of ["waiting", "stalled"]) {
            video.addEventListener(
                name,
                () => {
                    if (isManagedVideo(video)) recordQualityStall();
                    recoverPlaybackSoon(1500);
                },
                true,
            );
        }
        video.addEventListener(
            "suspend",
            () => recoverPlaybackSoon(1500),
            true,
        );
        video.addEventListener(
            "loadedmetadata",
            () => {
                if (isManagedVideo(video)) burstQuality(8000);
            },
            true,
        );
        video.addEventListener(
            "canplay",
            () => {
                if (isManagedVideo(video)) burstQuality(5000);
            },
            true,
        );
    }

    function bindVideos() {
        bindVideo(getMainVideo());
        updatePiPKeepalive();
    }

    function resumeVideo() {
        if (!CONFIG.keepPlaying || !wasPlaying) return;
        const video = getMainVideo();
        try {
            if (
                video?.paused &&
                !video.ended &&
                (video.readyState >= 2 || isPiPVideo(video))
            ) {
                const promise = video.play();
                if (promise?.catch) promise.catch(() => {});
            }
        } catch {}
    }

    let wakeLock = null;
    let wakeLockRequest = null;
    let wakeLockReleaseQueued = false;
    function releaseWakeLock() {
        wakeLockReleaseQueued = !!wakeLockRequest;
        const lock = wakeLock;
        wakeLock = null;
        if (!lock) return;
        try {
            const promise = lock.release();
            if (promise?.catch) promise.catch(() => {});
        } catch {}
    }

    async function requestWakeLock() {
        if (
            !CONFIG.wakeLock ||
            document.hidden ||
            getMainVideo()?.paused !== false ||
            wakeLock ||
            wakeLockRequest ||
            !navigator.wakeLock?.request
        )
            return;
        try {
            wakeLockRequest = navigator.wakeLock.request("screen");
            const lock = await wakeLockRequest;
            wakeLock = lock;
            lock.addEventListener(
                "release",
                () => {
                    if (wakeLock === lock) wakeLock = null;
                },
                { once: true },
            );
        } catch {
        } finally {
            wakeLockRequest = null;
            if (wakeLockReleaseQueued || document.hidden) releaseWakeLock();
        }
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
        cachedPlayer = null;
        cachedVideo = null;
        cachedAt = 0;

        if (key === "maxQuality" && !CONFIG.maxQuality) stopQualityBurst();
        if (key === "wakeLock" && !CONFIG.wakeLock) releaseWakeLock();
        if (
            (key === "maxQuality" || key === "keepPlaying") &&
            !shouldPiPKeepalive()
        ) {
            stopPiPKeepalive();
        }
        if (key === "cleanUi") {
            injectCleanerCss();
            cleanCarousel();
        }

        scheduleDomWork();
        if (CONFIG.maxQuality && getMainVideo()) burstQuality(4000);
        if (CONFIG.wakeLock) requestWakeLock();
        updatePiPKeepalive();
    }

    function mutationTarget(mutation) {
        const target = mutation.target;
        const elementNode = typeof Node === "undefined" ? 1 : Node.ELEMENT_NODE;
        if (target?.nodeType === elementNode) return target;
        return target?.parentElement || null;
    }

    function hasNonChatMutation(mutations) {
        return mutations.some((mutation) => {
            const target = mutationTarget(mutation);
            return (
                !target ||
                typeof target.closest !== "function" ||
                !target.closest(CHAT_MUTATION_SELECTOR)
            );
        });
    }

    function runDomWork() {
        injectCleanerCss();
        bindVideos();
        cleanCarousel();
        claimPoints();
        if (getPlayerRoot()) {
            clickBackToLive();
            clickContentGate();
        }
    }

    let domScheduled = false;
    let lastDomRun = 0;

    function scheduleDomWork() {
        if (domScheduled) return;
        domScheduled = true;
        const delay = Math.max(
            0,
            CONFIG.domCooldownMs - (Date.now() - lastDomRun),
        );
        window.setTimeout(() => {
            window.requestAnimationFrame(() => {
                domScheduled = false;
                lastDomRun = Date.now();
                runDomWork();
            });
        }, delay);
    }

    function onPageActivity() {
        scheduleDomWork();
        if (getMainVideo()) {
            burstQuality(8000);
            window.setTimeout(resumeVideo, 150);
            requestWakeLock();
        }
    }

    function patchNavigation() {
        let pageHistory = history;
        try {
            pageHistory = pageGlobal.history || history;
        } catch {}
        for (const name of ["pushState", "replaceState"]) {
            const original = pageHistory[name];
            if (original?.__twitchKitPatched) continue;
            const wrapped = function wrappedHistoryState(...args) {
                const result = original.apply(this, args);
                window.setTimeout(onPageActivity, 0);
                return result;
            };
            Object.defineProperty(wrapped, "__twitchKitPatched", {
                value: true,
            });
            pageHistory[name] = wrapped;
        }
        window.addEventListener("popstate", onPageActivity, true);
    }

    injectCleanerCss();
    patchNavigation();
    registerMenuCommands();

    document.addEventListener(
        "pointerdown",
        (event) => {
            if (event.target?.closest?.(PLAYER_ROOT_SELECTOR)) {
                lastPlayerInputAt = Date.now();
            }
        },
        true,
    );

    document.addEventListener(
        "keydown",
        (event) => {
            const target = event.target;
            if (
                target?.isContentEditable ||
                ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)
            )
                return;
            if (
                event.defaultPrevented ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
            )
                return;
            if (event.key === " " || event.key?.toLowerCase() === "k")
                if (getMainVideo()) lastPlayerInputAt = Date.now();
        },
        true,
    );

    document.addEventListener(
        "visibilitychange",
        () => {
            if (document.hidden) {
                const video = getMainVideo();
                const activeVideo = video && !video.paused && !video.ended;
                wasPlaying =
                    Date.now() - lastManualPauseAt < CONFIG.manualPauseWindowMs
                        ? false
                        : wasPlaying || activeVideo;
                updatePiPKeepalive();
                releaseWakeLock();
                return;
            }
            updatePiPKeepalive();
            onPageActivity();
        },
        true,
    );

    window.addEventListener("focus", onPageActivity, true);
    window.addEventListener("pageshow", onPageActivity, true);
    window.addEventListener("pagehide", releaseWakeLock, true);
    window.addEventListener("load", onPageActivity, { once: true });

    onceBody(() => {
        runDomWork();
        burstQuality(12000);
        requestWakeLock();

        const observer = new MutationObserver((mutations) => {
            if (hasNonChatMutation(mutations)) scheduleDomWork();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.setInterval(onPageActivity, 30000);
    });
})();
