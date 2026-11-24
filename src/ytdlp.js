/**
 * yt-dlp helpers: argument building, JSON-safe execution, and self-updating.
 * Shared by the local worker and the cloud fallback.
 * @module ytdlp
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
    YTDLP_PATH,
    COOKIES_PATH,
    X_COOKIES_PATH,
    X_COOKIES_FROM_BROWSER,
    DOWNLOAD_TIMEOUT,
    YTDLP_UPDATE_CHANNEL,
    YTDLP_UPDATE_INTERVAL_MS,
} = require("./config");
const { execFileAsync, logger } = require("./utils");

/** Forces UTF-8 output from yt-dlp (Windows codepages mangle non-ASCII titles) */
const UTF8_ENV = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

/**
 * Since 2025.11 yt-dlp needs a JS runtime to solve YouTube's challenges
 * (only Deno is enabled by default). We're already running under Node, so
 * enable it explicitly — Deno is still preferred if it's installed.
 * yt-dlp requires Node >= 22.
 */
const JS_RUNTIME_ARGS =
    Number(process.versions.node.split(".")[0]) >= 22
        ? ["--js-runtimes", `node:${process.execPath}`]
        : [];

/** @type {string|null} Cached yt-dlp version string */
let cachedVersion = null;

/** Hosts that use the X-specific cookie source */
const X_HOSTS = /(^|\.)(x\.com|twitter\.com)$/i;

/**
 * @param {string} [url]
 * @returns {boolean} True if the URL points at x.com / twitter.com
 */
function isXUrl(url) {
    try {
        return X_HOSTS.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * yt-dlp writes its cookie jar back into the --cookies file when it exits,
 * which replaced the exported login cookies with guest ones. Give each run
 * its own throwaway copy so the original export is never modified (and
 * concurrent jobs don't race on the same file).
 * @param {string} src - Cookie file to copy
 * @returns {string} Path of the temporary copy
 */
function tempCookieCopy(src) {
    const tmp = path.join(os.tmpdir(), `wppbot-cookies-${crypto.randomUUID()}.txt`);
    fs.copyFileSync(src, tmp);
    return tmp;
}

/**
 * Common args for every yt-dlp invocation. x.com / twitter.com links use
 * X_COOKIES_FROM_BROWSER or X_COOKIES_PATH when configured; everything else
 * (and X as a fallback) uses COOKIES_PATH. Cookies are domain-scoped, so
 * sites that don't need them ignore them.
 * @param {string} [url] - Target URL, used to pick the cookie source
 * @returns {{ args: string[], cleanup: () => void }}
 */
function baseArgs(url) {
    const args = ["--no-playlist", "--no-warnings", ...JS_RUNTIME_ARGS];
    let tmp = null;

    if (isXUrl(url) && X_COOKIES_FROM_BROWSER) {
        args.push("--cookies-from-browser", X_COOKIES_FROM_BROWSER);
    } else {
        const file = isXUrl(url) && fs.existsSync(X_COOKIES_PATH) ? X_COOKIES_PATH : COOKIES_PATH;
        if (fs.existsSync(file)) {
            tmp = tempCookieCopy(file);
            args.push("--cookies", tmp);
        }
    }

    const cleanup = () => {
        if (tmp) fs.rm(tmp, { force: true }, () => {});
    };
    return { args, cleanup };
}

/**
 * Runs yt-dlp with the given args plus `-j --no-simulate`, so a single
 * invocation both downloads the media and returns its info JSON
 * (avoids a second extraction round-trip just to fetch the title).
 *
 * @param {string} url - Media URL
 * @param {string[]} args - Format/output args
 * @returns {Promise<object>} Parsed info JSON (empty object if unparseable)
 */
async function downloadWithInfo(url, args) {
    const base = baseArgs(url);
    const fullArgs = [...args, ...base.args, "-j", "--no-simulate", url];
    logger.info("Running yt-dlp:", fullArgs.join(" "));

    let stdout;
    try {
        ({ stdout } = await execFileAsync(YTDLP_PATH, fullArgs, {
            timeout: DOWNLOAD_TIMEOUT,
            encoding: "utf8",
            env: UTF8_ENV,
            maxBuffer: 64 * 1024 * 1024, // info JSON can be several MB (formats list)
        }));
    } finally {
        base.cleanup();
    }

    // -j prints one JSON object per line; take the last valid one
    const lines = stdout.trim().split("\n").reverse();
    for (const line of lines) {
        try {
            return JSON.parse(line);
        } catch {
            // keep looking
        }
    }
    return {};
}

/**
 * Searches YouTube and returns up to `limit` results.
 * @param {string} query - Search terms
 * @param {number} [limit=5]
 * @returns {Promise<Array<{url: string, title: string, duration: number|null, channel: string}>>}
 */
async function search(query, limit = 5) {
    const base = baseArgs();
    const args = [`ytsearch${limit}:${query}`, "-j", "--flat-playlist", ...base.args];
    let stdout;
    try {
        ({ stdout } = await execFileAsync(YTDLP_PATH, args, {
            timeout: DOWNLOAD_TIMEOUT,
            encoding: "utf8",
            env: UTF8_ENV,
        }));
    } finally {
        base.cleanup();
    }

    const results = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
        try {
            const info = JSON.parse(line);
            results.push({
                url: info.url || info.webpage_url || "",
                title: info.title || "",
                duration: info.duration ?? null,
                channel: info.channel || info.uploader || "",
            });
        } catch {
            // Skip malformed lines
        }
    }
    return results.slice(0, limit);
}

/**
 * Gets the installed yt-dlp version (cached).
 * @returns {Promise<string|null>}
 */
async function getVersion() {
    if (cachedVersion) return cachedVersion;
    try {
        const { stdout } = await execFileAsync(YTDLP_PATH, ["--version"], { timeout: 30000 });
        cachedVersion = stdout.trim();
    } catch {
        cachedVersion = null;
    }
    return cachedVersion;
}

/**
 * Updates yt-dlp in place via its built-in updater. Only works for the
 * standalone binaries (yt-dlp.exe / yt-dlp_linux*); pip/apt installs
 * just log a warning and should be updated by their package manager.
 */
async function update() {
    try {
        const { stdout } = await execFileAsync(
            YTDLP_PATH,
            ["--update-to", YTDLP_UPDATE_CHANNEL],
            { timeout: 120000, encoding: "utf8", env: UTF8_ENV }
        );
        const lastLine = stdout.trim().split("\n").pop();
        logger.info(`yt-dlp update (${YTDLP_UPDATE_CHANNEL}):`, lastLine);
    } catch (err) {
        logger.warn("yt-dlp update failed:", (err.stderr || err.message).toString().trim());
    }
    cachedVersion = null;
    const version = await getVersion();
    if (version) logger.info("yt-dlp version:", version);
}

/**
 * Runs an update now and then on an interval (0 disables updates).
 */
function scheduleAutoUpdate() {
    if (!YTDLP_UPDATE_INTERVAL_MS) {
        getVersion().then((v) => v && logger.info("yt-dlp version:", v));
        return;
    }
    update();
    setInterval(update, YTDLP_UPDATE_INTERVAL_MS).unref();
}

module.exports = {
    downloadWithInfo,
    search,
    getVersion,
    update,
    scheduleAutoUpdate,
};
