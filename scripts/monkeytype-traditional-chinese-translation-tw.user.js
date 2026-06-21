// ==UserScript==
// @name         Monkeytype Translation Kit (TW)
// @namespace    local.monkeytype.translation-kit
// @version      2026.06.21
// @description  Show Traditional Chinese translation under the active Monkeytype word.
// @author       Gholts
// @match        https://monkeytype.com/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(() => {
    "use strict";

    const CONFIG = Object.freeze({
        targetLang: "zh-TW",
        batchSize: 40,
        scanIntervalMs: 1500,
        retryDelayMs: 5000,
        requestTimeoutMs: 8000,
        maxRetries: 2,
        cacheLimit: 2000,
        fontSize: "14px",
        offsetY: 10,
        colorActive: "var(--main-color)",
        colorError: "#ca4754",
    });

    const WORDS_ID = "words";
    const OVERLAY_ID = "mt-translation-overlay";
    const LABEL_ID = "mt-translation-label";
    const SPLIT_TOKEN = "\n[[MT_TRANSLATION_SPLIT]]\n";

    let wordsRoot = null;
    let observer = null;
    let processedWords = new WeakMap();
    let overlay = null;
    let label = null;
    let scanTimer = 0;
    let retryTimer = 0;
    let renderRaf = 0;
    let trackUntil = 0;
    let inFlight = false;

    const cache = new Map();
    const pendingTexts = new Set();
    const singleTexts = new Set();
    const retryCount = new Map();
    const blockedUntil = new Map();

    function cleanText(word) {
        return (word?.textContent || "").replace(/\s+/g, "").trim();
    }

    function setCache(text, translation) {
        const value = String(translation || "").trim();
        if (!text || !value) return;
        if (cache.has(text)) cache.delete(text);
        cache.set(text, value);
        if (cache.size > CONFIG.cacheLimit)
            cache.delete(cache.keys().next().value);
    }

    function ensureOverlay() {
        if (!document.body) return false;
        if (overlay?.isConnected && label?.isConnected) return true;

        overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            Object.assign(overlay.style, {
                position: "fixed",
                inset: "0",
                pointerEvents: "none",
                zIndex: "9999",
                overflow: "hidden",
            });
            document.body.appendChild(overlay);
        }

        label = document.getElementById(LABEL_ID);
        if (!label) {
            label = document.createElement("div");
            label.id = LABEL_ID;
            label.setAttribute("aria-hidden", "true");
            Object.assign(label.style, {
                position: "absolute",
                top: "0",
                left: "0",
                whiteSpace: "nowrap",
                fontSize: CONFIG.fontSize,
                fontFamily: 'Inter, "Noto Sans TC", sans-serif',
                fontWeight: "700",
                pointerEvents: "none",
                opacity: "0",
                transform: "translate3d(-9999px, -9999px, 0)",
                transition: "opacity 160ms ease, color 160ms ease",
                willChange: "transform, opacity",
            });
            overlay.appendChild(label);
        }

        return true;
    }

    function hideLabel() {
        if (!label) return;
        label.style.opacity = "0";
        label.style.transform = "translate3d(-9999px, -9999px, 0)";
    }

    function ensureWordsRoot() {
        const root = document.getElementById(WORDS_ID);
        if (!root) {
            observer?.disconnect();
            wordsRoot = null;
            hideLabel();
            return null;
        }

        if (root !== wordsRoot) {
            observer?.disconnect();
            processedWords = new WeakMap();
            wordsRoot = root;
            observeWords();
        }

        return wordsRoot;
    }

    function observeWords() {
        if (!wordsRoot) return;

        observer = new MutationObserver((mutations) => {
            let shouldScan = false;
            let shouldRender = false;

            for (const mutation of mutations) {
                if (mutation.type === "childList") shouldScan = true;
                if (mutation.type === "attributes") shouldRender = true;
            }

            if (shouldScan) collectWords();
            if (shouldScan || shouldRender) scheduleRender(true);
        });

        observer.observe(wordsRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    function collectWords() {
        const root = ensureWordsRoot();
        if (!root) return;

        root.querySelectorAll(".word").forEach((word) => {
            const text = cleanText(word);
            if (!text || processedWords.get(word) === text) return;
            processedWords.set(word, text);
            queueText(text);
        });

        flushQueue();
    }

    function queueText(text) {
        if (
            !text ||
            cache.has(text) ||
            pendingTexts.has(text) ||
            singleTexts.has(text)
        ) {
            return;
        }

        pendingTexts.add(text);
    }

    function scheduleRetry() {
        if (retryTimer || (!pendingTexts.size && !singleTexts.size)) return;

        const now = Date.now();
        let delay = 0;
        let foundReady = false;
        let nextBlocked = Infinity;

        for (const source of [singleTexts, pendingTexts]) {
            for (const text of source) {
                if (cache.has(text)) continue;
                const blocked = blockedUntil.get(text) || 0;
                if (blocked <= now) {
                    foundReady = true;
                    break;
                }
                nextBlocked = Math.min(nextBlocked, blocked);
            }
            if (foundReady) break;
        }

        if (!foundReady) {
            delay = Number.isFinite(nextBlocked)
                ? Math.max(250, Math.min(60000, nextBlocked - now))
                : 1000;
        }

        retryTimer = window.setTimeout(() => {
            retryTimer = 0;
            flushQueue();
        }, delay);
    }

    function takeReadyTexts(source, limit) {
        const now = Date.now();
        const batch = [];

        for (const text of source) {
            if (batch.length >= limit) break;
            if (cache.has(text)) {
                source.delete(text);
                continue;
            }
            if ((blockedUntil.get(text) || 0) > now) continue;

            source.delete(text);
            batch.push(text);
        }

        return batch;
    }

    function flushQueue() {
        if (inFlight || document.hidden) return;

        const source = singleTexts.size ? singleTexts : pendingTexts;
        const limit = source === singleTexts ? 1 : CONFIG.batchSize;
        const batch = takeReadyTexts(source, limit);

        if (!batch.length) {
            scheduleRetry();
            return;
        }

        requestTranslations(batch, source === singleTexts);
    }

    function requestTranslations(batch, singleMode) {
        inFlight = true;

        sendRequest({
            method: "POST",
            url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(CONFIG.targetLang)}&dt=t`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            data: `q=${encodeURIComponent(batch.join(SPLIT_TOKEN))}`,
            timeout: CONFIG.requestTimeoutMs,
            onload: (response) => {
                if (
                    response.status &&
                    (response.status < 200 || response.status >= 300)
                ) {
                    failBatch(batch, singleMode);
                    return;
                }

                let translations = [];
                try {
                    translations = parseTranslations(
                        response.responseText,
                        batch.length,
                    );
                } catch {
                    failBatch(batch, singleMode);
                    return;
                }

                if (translations.length !== batch.length) {
                    if (!singleMode && batch.length > 1) {
                        batch.forEach((text) => singleTexts.add(text));
                        finishRequest();
                        return;
                    }

                    failBatch(batch, singleMode);
                    return;
                }

                translations.forEach((translation, index) => {
                    setCache(batch[index], translation);
                    retryCount.delete(batch[index]);
                    blockedUntil.delete(batch[index]);
                });
                finishRequest();
                scheduleRender(false);
            },
            onerror: () => failBatch(batch, singleMode),
            ontimeout: () => failBatch(batch, singleMode),
        });
    }

    function sendRequest(options) {
        if (typeof GM_xmlhttpRequest === "function") {
            GM_xmlhttpRequest(options);
            return;
        }

        if (
            typeof GM === "object" &&
            GM &&
            typeof GM.xmlHttpRequest === "function"
        ) {
            GM.xmlHttpRequest(options);
            return;
        }

        options.onerror();
    }

    function parseTranslations(raw, expected) {
        const data = JSON.parse(raw);
        const segments = Array.isArray(data?.[0]) ? data[0] : [];
        const translated = segments
            .map((segment) => (Array.isArray(segment) ? segment[0] || "" : ""))
            .join("")
            .trim();

        if (!translated) return [];
        if (expected === 1) return [translated];

        const byToken = translated
            .split(/\s*\[\[MT_TRANSLATION_SPLIT\]\]\s*/)
            .map((text) => text.trim())
            .filter(Boolean);
        if (byToken.length === expected) return byToken;

        const byLine = translated
            .split(/\n+/)
            .map((text) => text.trim())
            .filter(Boolean);
        if (byLine.length === expected) return byLine;

        const bySegment = segments
            .map((segment) =>
                Array.isArray(segment) ? String(segment[0] || "").trim() : "",
            )
            .filter(Boolean);
        if (bySegment.length === expected) return bySegment;

        return byToken.length > 1 ? byToken : byLine;
    }

    function failBatch(batch, singleMode) {
        const now = Date.now();
        const target = singleMode ? singleTexts : pendingTexts;

        batch.forEach((text) => {
            const attempts = (retryCount.get(text) || 0) + 1;
            if (attempts <= CONFIG.maxRetries) {
                retryCount.set(text, attempts);
                blockedUntil.set(text, now + CONFIG.retryDelayMs * attempts);
            } else {
                retryCount.delete(text);
                blockedUntil.set(text, now + CONFIG.retryDelayMs * 12);
            }
            target.add(text);
        });

        finishRequest();
    }

    function finishRequest() {
        inFlight = false;
        scheduleRetry();
        flushQueue();
    }

    function scheduleRender(trackMotion) {
        if (trackMotion) trackUntil = performance.now() + 300;
        if (renderRaf || document.hidden) return;
        renderRaf = requestAnimationFrame(render);
    }

    function render() {
        renderRaf = 0;

        try {
            renderNow();
        } catch {
            hideLabel();
        }

        if (
            !document.hidden &&
            label?.style.opacity === "1" &&
            performance.now() < trackUntil
        ) {
            renderRaf = requestAnimationFrame(render);
        }
    }

    function renderNow() {
        if (!ensureOverlay()) return;

        const root = ensureWordsRoot();
        const word = root?.querySelector(".word.active");
        const text = cleanText(word);
        const translation = cache.get(text);
        if (!word || !text || !translation) {
            if (text) {
                queueText(text);
                flushQueue();
            }
            hideLabel();
            return;
        }

        const rect = word.getBoundingClientRect();
        if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.bottom < 0 ||
            rect.top > window.innerHeight ||
            rect.right < 0 ||
            rect.left > window.innerWidth
        ) {
            hideLabel();
            return;
        }

        label.textContent = translation;
        label.style.color = word.classList.contains("error")
            ? CONFIG.colorError
            : CONFIG.colorActive;
        label.style.opacity = "1";
        label.style.transform = `translate3d(${rect.left + rect.width / 2}px, ${rect.bottom + CONFIG.offsetY}px, 0) translateX(-50%)`;
    }

    function start() {
        if (!ensureOverlay()) {
            window.setTimeout(start, 250);
            return;
        }

        collectWords();
        scheduleRender(true);
        scanTimer = window.setInterval(collectWords, CONFIG.scanIntervalMs);

        window.addEventListener("resize", () => scheduleRender(true), {
            passive: true,
        });
        window.addEventListener("scroll", () => scheduleRender(true), {
            capture: true,
            passive: true,
        });
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                hideLabel();
                return;
            }
            collectWords();
            scheduleRender(true);
            flushQueue();
        });
        window.addEventListener("pagehide", hideLabel);
        window.addEventListener("pageshow", () => {
            collectWords();
            scheduleRender(true);
            flushQueue();
        });
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    }
})();
