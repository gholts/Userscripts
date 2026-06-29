/**
 * Based on Doraemon-Labs/QuantumultX-JMS-Bandwidth-Checker
 * Licensed under the Apache License 2.0.
 *
 * Copyright 2024 Doraemon-Labs
 * Modified by Hugo Lee, 2026.
 */

import {
    $argument,
    Console,
    done,
    fetch,
} from "https://cdn.jsdelivr.net/gh/NSNanoCat/util@3e0b0387eb13450a4e795858659f7d37d8efdc77/index.js";

const args = $argument || {};
const DEFAULT_TITLE = "JMS Bandwidth";

main().catch((error) => {
    finish({
        title: panelTitle(),
        content: `Error: ${messageOf(error)}`,
        style: "error",
        icon: "exclamationmark.triangle.fill",
        color: "#ff453a",
    });
});

async function main() {
    Console.logLevel = arg(["LogLevel", "log_level"], "INFO");

    const apiUrl = apiUrlFromArgs();
    if (!apiUrl || apiUrl === "XXXXXX") {
        throw new Error("missing api_url or api_url_b64");
    }

    const timeout = numberArg(["timeout"], 8);
    const policy = arg(["policy", "node"], "");
    const unit = arg(["unit"], "GB").toUpperCase() === "GIB" ? "GiB" : "GB";
    const divisor = unit === "GiB" ? 1024 ** 3 : 1000 ** 3;

    const response = await fetch(apiUrl, {
        method: "GET",
        timeout,
        policy: policy || undefined,
        redirection: true,
        headers: { Accept: "application/json" },
    });

    if (!response.ok)
        throw new Error(`HTTP ${response.status || response.statusCode}`);

    const data = parseJson(response.body);
    const limitBytes = numberFrom(data, [
        "monthly_bw_limit_b",
        "monthly_bw_limit",
        "limit_b",
        "limit",
    ]);
    const usedBytes = numberFrom(data, [
        "bw_counter_b",
        "bw_used_b",
        "used_b",
        "used",
    ]);

    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
        throw new Error("bad monthly_bw_limit_b");
    }
    if (!Number.isFinite(usedBytes) || usedBytes < 0) {
        throw new Error("bad bw_counter_b");
    }

    const usedPercent = clamp((usedBytes / limitBytes) * 100, 0, 999);
    const leftBytes = Math.max(limitBytes - usedBytes, 0);
    const leftPercent = clamp(100 - usedPercent, 0, 100);
    const state = stateForLeft(leftPercent);
    const resetDay =
        data.bw_reset_day_of_month || data.reset_day || data.resetDay;

    const lines = [
        `Used: ${formatBytes(usedBytes, divisor)} / ${formatBytes(limitBytes, divisor)} ${unit} (${usedPercent.toFixed(2)}%)`,
        `Left: ${formatBytes(leftBytes, divisor)} ${unit} (${leftPercent.toFixed(2)}%)`,
        `Bar: ${bar(usedPercent)}`,
    ];

    if (resetDay) lines.push(`Reset day: ${resetDay}`);
    if (policy) lines.push(`Policy: ${policy}`);
    lines.push(`Updated: ${timestamp()}`);

    finish({
        title: panelTitle(),
        content: lines.join("\n"),
        style: state.style,
        icon: state.icon,
        color: state.color,
    });
}

function finish({ title, content, style, icon, color }) {
    done({
        title,
        content,
        style,
        icon,
        "icon-color": color,
    });
}

function apiUrlFromArgs() {
    const raw = arg(["api_url", "jms_api_url", "url", "api"], "");
    if (raw) return raw;

    const encoded = arg(["api_url_b64", "jms_api_url_b64", "url_b64"], "");
    if (!encoded) return "";
    try {
        return decodeBase64(encoded);
    } catch {
        throw new Error("bad api_url_b64");
    }
}

function panelTitle() {
    return arg(["title"], DEFAULT_TITLE);
}

function decodeBase64(value) {
    let normalized = String(value)
        .trim()
        .replace(/\s/g, "+")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    return atob(normalized);
}

function arg(names, fallback = "") {
    for (const name of names) {
        const value = getPath(args, name);
        if (value !== undefined && value !== null && String(value).length > 0) {
            return String(value);
        }
    }
    return fallback;
}

function numberArg(names, fallback) {
    const value = Number(arg(names, fallback));
    return Number.isFinite(value) ? value : fallback;
}

function numberFrom(object, names) {
    for (const name of names) {
        const value = Number(getPath(object, name));
        if (Number.isFinite(value)) return value;
    }
    return NaN;
}

function getPath(object, path) {
    return String(path)
        .split(".")
        .reduce(
            (value, key) => (value == null ? undefined : value[key]),
            object,
        );
}

function parseJson(body) {
    if (typeof body !== "string") throw new Error("empty response body");
    return JSON.parse(body);
}

function formatBytes(bytes, divisor) {
    return (bytes / divisor).toFixed(3);
}

function stateForLeft(leftPercent) {
    if (leftPercent <= 5) {
        return {
            style: "error",
            icon: "exclamationmark.triangle.fill",
            color: "#ff453a",
        };
    }
    if (leftPercent <= 20) {
        return {
            style: "alert",
            icon: "gauge.with.dots.needle.bottom.100percent",
            color: "#ff9f0a",
        };
    }
    return {
        style: "good",
        icon: "gauge.with.dots.needle.bottom.50percent",
        color: "#32d74b",
    };
}

function bar(percent) {
    const width = 18;
    const filled = Math.round((clamp(percent, 0, 100) / 100) * width);
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function timestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function messageOf(error) {
    return error && error.message ? error.message : String(error);
}
