/**
 * HTTP client for the local worker API.
 * Used by the cloud bot to delegate yt-dlp downloads, video encoding,
 * Edge playback, and volume control to the local PC.
 * @module local-worker-client
 */

const { LOCAL_WORKER_URL, LOCAL_WORKER_SECRET } = require("./config");
const { logger } = require("./utils");

/** @type {number} Timeout for download/encode operations (5 minutes) */
const LONG_TIMEOUT = 300000;

/** @type {number} Timeout for quick operations like play/volume/health (10 seconds) */
const SHORT_TIMEOUT = 10000;

/** @type {number} How long to cache health check results (30 seconds) */
const HEALTH_CACHE_MS = 30000;

/** @type {{ online: boolean, checkedAt: number }} Cached health status */
let healthCache = { online: false, checkedAt: 0 };

/**
 * Makes an HTTP request to the local worker API.
 *
 * @param {string} method - HTTP method
 * @param {string} endpoint - API path (e.g. "/download")
 * @param {object} [body] - Request body (JSON)
 * @param {number} [timeout] - Timeout in ms
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} If worker is unreachable or returns an error
 */
async function workerRequest(method, endpoint, body = null, timeout = LONG_TIMEOUT) {
    if (!LOCAL_WORKER_URL) {
        throw new Error("LOCAL_WORKER_URL not configured");
    }

    const url = `${LOCAL_WORKER_URL}${endpoint}`;
    const opts = {
        method,
        headers: {
            "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(timeout),
    };

    if (LOCAL_WORKER_SECRET) {
        opts.headers["X-Worker-Secret"] = LOCAL_WORKER_SECRET;
    }

    if (body) {
        opts.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(url, opts);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || `Worker returned ${res.status}`);
        }

        return data;
    } catch (error) {
        if (error.name === "TimeoutError" || error.code === "UND_ERR_CONNECT_TIMEOUT") {
            throw new Error("⚠️ Local server timed out");
        }
        if (error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ENOTFOUND") {
            throw new Error("⚠️ Local server offline");
        }
        throw error;
    }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Checks if the local worker is reachable (cached for 30s).
 * @returns {Promise<boolean>}
 */
async function isWorkerOnline() {
    const now = Date.now();
    if (now - healthCache.checkedAt < HEALTH_CACHE_MS) {
        return healthCache.online;
    }

    try {
        await workerRequest("GET", "/health", null, SHORT_TIMEOUT);
        healthCache = { online: true, checkedAt: now };
        return true;
    } catch {
        healthCache = { online: false, checkedAt: now };
        return false;
    }
}

/**
 * Downloads a video via yt-dlp on the local worker.
 *
 * @param {string} url - Video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<{ buffer: Buffer, title: string }>}
 */
async function workerDownload(url, keepFile = false) {
    const data = await workerRequest("POST", "/download", { url, keepFile });
    return {
        buffer: Buffer.from(data.buffer, "base64"),
        title: data.title || "",
    };
}

/**
 * Downloads a full-resolution video via yt-dlp on the local worker.
 *
 * @param {string} url - Video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<{ buffer: Buffer, title: string, fileName: string }>}
 */
async function workerFullRes(url, keepFile = false) {
    const data = await workerRequest("POST", "/fullres", { url, keepFile });
    return {
        buffer: Buffer.from(data.buffer, "base64"),
        title: data.title || "",
        fileName: data.fileName || "",
    };
}

/**
 * Downloads audio (MP3) via yt-dlp on the local worker.
 *
 * @param {string} url - Audio/video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<Buffer>} Audio buffer
 */
async function workerAudio(url, keepFile = false) {
    const data = await workerRequest("POST", "/audio", { url, keepFile });
    return Buffer.from(data.buffer, "base64");
}

/**
 * Downloads a video via yt-dlp for sticker creation (/ds command).
 * Only downloads — sticker creation happens on cloud.
 *
 * @param {string} url - Video URL
 * @returns {Promise<Buffer>} Video buffer
 */
async function workerDownloadStickerSource(url) {
    const data = await workerRequest("POST", "/sticker-src", { url });
    return Buffer.from(data.buffer, "base64");
}

/**
 * Searches YouTube via yt-dlp on the local worker.
 *
 * @param {string} query - Search query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
async function workerSearch(query) {
    const data = await workerRequest("POST", "/search", { query }, SHORT_TIMEOUT);
    return data.results || [];
}

/**
 * Opens a URL in Edge and wakes the monitor on the local PC.
 *
 * @param {string} url - URL to open
 * @returns {Promise<void>}
 */
async function workerPlay(url) {
    await workerRequest("POST", "/play", { url }, SHORT_TIMEOUT);
}

/**
 * Sets YouTube volume via the WebSocket extension on the local PC.
 *
 * @param {number} volume - Volume level (0-100)
 * @returns {Promise<void>}
 */
async function workerVolume(volume) {
    await workerRequest("POST", "/volume", { volume }, SHORT_TIMEOUT);
}

module.exports = {
    isWorkerOnline,
    workerDownload,
    workerFullRes,
    workerAudio,
    workerDownloadStickerSource,
    workerSearch,
    workerPlay,
    workerVolume,
};
