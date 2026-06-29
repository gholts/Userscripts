import {
    $argument,
    Console,
    done,
    fetch,
} from "https://cdn.jsdelivr.net/gh/NSNanoCat/util@3e0b0387eb13450a4e795858659f7d37d8efdc77/index.js";

const args = $argument || {};
const DEFAULT_TITLE = "Codex Usage";

main().catch((error) => {
    finish({
        title: panelTitle(),
        content: `Error: ${messageOf(error)}\nNo model endpoint called.`,
        style: "error",
        icon: "exclamationmark.triangle.fill",
        color: "#ff453a",
    });
});

async function main() {
    Console.logLevel = arg(["LogLevel", "log_level"], "INFO");

    const token = bearerToken();
    if (!token) throw new Error("missing access_token");

    const url = usageUrl();
    const timeout = numberArg(["timeout"], 8);
    const policy = arg(["policy", "node"], "");
    const headers = {
        Accept: "application/json",
        Authorization: token,
        "Cache-Control": "no-cache",
        "User-Agent": "codex-cli",
    };

    const accountId = arg(
        ["account_id", "chatgpt_account_id", "workspace_id"],
        "",
    );
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const response = await fetch(url, {
        method: "GET",
        timeout,
        policy: policy || undefined,
        redirection: true,
        headers,
    });

    if (!response.ok) {
        const status = response.status || response.statusCode;
        if (status === 401 || status === 403)
            throw new Error(`unauthorized (${status})`);
        throw new Error(`HTTP ${status}`);
    }

    const payload = parseJson(response.body);
    const rate = payload.rate_limit || {};
    const primary = normalizeWindow(rate.primary_window);
    const secondary = normalizeWindow(rate.secondary_window);
    const plan = label(payload.plan_type || "unknown");
    const resetCredits = payload.rate_limit_reset_credits;
    const credits = payload.credits;
    const reached = Boolean(
        rate.limit_reached || payload.rate_limit_reached_type,
    );
    const state = stateForLimits(reached, primary, secondary);

    const lines = [`Plan: ${plan}`];
    if (primary) lines.push(`Primary: ${formatWindow(primary)}`);
    if (secondary) lines.push(`Secondary: ${formatWindow(secondary)}`);
    if (!primary && !secondary) lines.push("Limits: unavailable");

    for (const line of additionalLimitLines(payload.additional_rate_limits)) {
        lines.push(line);
    }

    if (credits) lines.push(`Credits: ${formatCredits(credits)}`);
    if (resetCredits && Number.isFinite(Number(resetCredits.available_count))) {
        lines.push(`Resets: ${resetCredits.available_count} available`);
    }
    if (payload.rate_limit_reached_type?.type) {
        lines.push(`Reached: ${label(payload.rate_limit_reached_type.type)}`);
    }

    lines.push("Cost: read-only usage API");
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

function usageUrl() {
    const explicit = arg(["usage_url", "url"], "");
    if (explicit) return explicit;

    let baseUrl = arg(["base_url"], "https://chatgpt.com").replace(/\/+$/, "");
    if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)$/i.test(baseUrl)) {
        baseUrl = `${baseUrl}/backend-api`;
    }

    return baseUrl.includes("/backend-api")
        ? `${baseUrl}/wham/usage`
        : `${baseUrl}/api/codex/usage`;
}

function bearerToken() {
    const raw = arg(
        [
            "access_token",
            "token",
            "bearer",
            "codex_access_token",
            "personal_access_token",
        ],
        "",
    ).trim();
    if (!raw) return "";
    return /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function panelTitle() {
    return arg(["title"], DEFAULT_TITLE);
}

function normalizeWindow(raw) {
    if (!raw) return null;

    const used = Number(raw.used_percent ?? raw.usedPercent);
    if (!Number.isFinite(used)) return null;

    const seconds = Number(
        raw.limit_window_seconds ??
            raw.limitWindowSeconds ??
            raw.window_seconds ??
            raw.windowSeconds ??
            Number(raw.window_minutes ?? raw.windowDurationMins) * 60,
    );
    const resetAt = Number(raw.reset_at ?? raw.resets_at ?? raw.resetsAt);
    const resetAfter = Number(raw.reset_after_seconds ?? raw.resetAfterSeconds);

    return {
        used: clamp(used, 0, 999),
        left: clamp(100 - used, 0, 100),
        seconds: Number.isFinite(seconds) ? seconds : 0,
        resetAt: Number.isFinite(resetAt) ? resetAt : 0,
        resetAfter: Number.isFinite(resetAfter) ? resetAfter : 0,
    };
}

function formatWindow(window) {
    const parts = [
        `${window.left.toFixed(0)}% left`,
        `${window.used.toFixed(0)}% used`,
    ];
    const duration = formatDuration(window.seconds);
    if (duration) parts.unshift(duration);
    const reset = formatReset(window);
    if (reset) parts.push(`reset ${reset}`);
    return parts.join(", ");
}

function additionalLimitLines(limits) {
    if (!Array.isArray(limits)) return [];
    return limits
        .slice(0, 2)
        .map((item) => {
            const window = normalizeWindow(item.rate_limit?.primary_window);
            if (!window) return "";
            const name = item.limit_name || item.metered_feature || "extra";
            return `${name}: ${formatWindow(window)}`;
        })
        .filter(Boolean);
}

function formatCredits(credits) {
    if (credits.unlimited) return "unlimited";
    if (!credits.has_credits) return "none";
    return credits.balance ? `balance ${credits.balance}` : "available";
}

function stateForLimits(reached, primary, secondary) {
    const left = Math.min(
        primary ? primary.left : 100,
        secondary ? secondary.left : 100,
    );
    if (reached || left <= 5) {
        return {
            style: "error",
            icon: "exclamationmark.triangle.fill",
            color: "#ff453a",
        };
    }
    if (left <= 20) {
        return {
            style: "alert",
            icon: "hourglass.circle.fill",
            color: "#ff9f0a",
        };
    }
    return {
        style: "good",
        icon: "checkmark.circle.fill",
        color: "#32d74b",
    };
}

function formatReset(window) {
    if (window.resetAt > 0) return timeFromEpoch(window.resetAt);
    if (window.resetAfter > 0) return `in ${formatDuration(window.resetAfter)}`;
    return "";
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    if (seconds % 60 === 0) return `${seconds / 60}m`;
    return `${seconds}s`;
}

function timeFromEpoch(seconds) {
    const date = new Date(seconds * 1000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function label(value) {
    return String(value)
        .replace(/_/g, " ")
        .replace(/\b\w/g, (match) => match.toUpperCase());
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
