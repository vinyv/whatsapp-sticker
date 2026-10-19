/**
 * yt-dlp helpers: argument building, JSON-safe execution, and self-updating.
 * Shared by the local worker and the cloud fallback.
 * @module ytdlp
 */

const fs = require("fs");
const {
    YTDLP_PATH,
    COOKIES_PATH,
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

/**
 * Common args for every yt-dlp invocation. Cookies are passed whenever the
 * file exists — they're domain-scoped, so sites that don't need them ignore them.
 * @returns {string[]}
 */
function baseArgs() {
    const args = ["--no-playlist", "--no-warnings", ...JS_RUNTIME_ARGS];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push("--cookies", COOKIES_PATH);
    }
    return args;
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
    const fullArgs = [...args, ...baseArgs(), "-j", "--no-simulate", url];
    logger.info("Running yt-dlp:", fullArgs.join(" "));

    const { stdout } = await execFileAsync(YTDLP_PATH, fullArgs, {
        timeout: DOWNLOAD_TIMEOUT,
        encoding: "utf8",
        env: UTF8_ENV,
        maxBuffer: 64 * 1024 * 1024, // info JSON can be several MB (formats list)
    });

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
    const args = [`ytsearch${limit}:${query}`, "-j", "--flat-playlist", ...baseArgs()];
    const { stdout } = await execFileAsync(YTDLP_PATH, args, {
        timeout: DOWNLOAD_TIMEOUT,
        encoding: "utf8",
        env: UTF8_ENV,
    });

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
