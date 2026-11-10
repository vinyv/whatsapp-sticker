/**
 * HTTP client for the local worker API.
 * Used by the cloud bot to delegate yt-dlp downloads, video encoding,
 * Edge playback, and volume control to the local PC.
 * @module local-worker-client
 */

const { LOCAL_WORKER_URL, LOCAL_WORKER_SECRET } = require("./config");
const { logger } = require("./utils");

/** @type {number} Max time to wait for a download job (15 minutes) */
const JOB_TIMEOUT = 15 * 60 * 1000;

/** @type {number} Timeout for each individual HTTP request to the worker */
const REQUEST_TIMEOUT = 90000;

/** @type {number} Timeout for quick operations like play/volume/health (10 seconds) */
const SHORT_TIMEOUT = 10000;

/** @type {number} Timeout for YouTube search (yt-dlp startup alone can take a few seconds) */
const SEARCH_TIMEOUT = 45000;

/** @type {number} How often to poll a running job */
const JOB_POLL_MS = 2000;

/** @type {number} How long to cache a healthy check result (30 seconds) */
const HEALTH_CACHE_MS = 30000;

/** @type {number} How long to cache an offline result (shorter, so the PC coming back is noticed fast) */
const HEALTH_CACHE_OFFLINE_MS = 10000;

/** @type {{ online: boolean, checkedAt: number, info: object|null }} Cached health status */
let healthCache = { online: false, checkedAt: 0, info: null };

/**
 * Makes an HTTP request to the local worker API.
 *
 * @param {string} method - HTTP method
 * @param {string} endpoint - API path (e.g. "/search")
 * @param {object} [body] - Request body (JSON)
 * @param {number} [timeout] - Timeout in ms
 * @returns {Promise<Response>} The raw response (status 2xx)
 * @throws {Error} If worker is unreachable or returns an error
 */
async function workerFetch(method, endpoint, body = null, timeout = REQUEST_TIMEOUT) {
    if (!LOCAL_WORKER_URL) {
        throw new Error("LOCAL_WORKER_URL not configured");
    }

    const opts = {
        method,
        headers: {},
        signal: AbortSignal.timeout(timeout),
    };

    if (LOCAL_WORKER_SECRET) {
        opts.headers["X-Worker-Secret"] = LOCAL_WORKER_SECRET;
    }

    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }

    let res;
    try {
        res = await fetch(`${LOCAL_WORKER_URL}${endpoint}`, opts);
    } catch (error) {
        if (error.name === "TimeoutError" || error.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
            throw new Error("⚠️ Local server timed out");
        }
        if (error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ENOTFOUND") {
            markOffline();
            throw new Error("⚠️ Local server offline");
        }
        throw error;
    }

    if (!res.ok) {
        // Cloudflare error pages (502/530 tunnel down, 524 timeout) are HTML, not JSON
        const text = await res.text().catch(() => "");
        let message;
        try {
            message = JSON.parse(text).error;
        } catch {
            if ([502, 521, 523, 530].includes(res.status)) {
                markOffline();
                message = "⚠️ Local server offline";
            } else if (res.status === 524) {
                message = "⚠️ Local server took too long to respond";
            }
        }
        const err = new Error(message || `Worker returned ${res.status}`);
        err.status = res.status;
        throw err;
    }

    return res;
}

/**
 * JSON convenience wrapper around workerFetch
 * @returns {Promise<object>} Parsed JSON response
 */
async function workerRequest(method, endpoint, body = null, timeout = REQUEST_TIMEOUT) {
    const res = await workerFetch(method, endpoint, body, timeout);
    return res.json();
}

/** Forces the next health check to hit the network */
function markOffline() {
    healthCache = { online: false, checkedAt: Date.now(), info: null };
}

/**
 * Runs a download job on the worker and waits for the file.
 * Falls back to the legacy blocking endpoint if the worker predates jobs.
 *
 * @param {string} type - Job type: download | fullres | audio | sticker-src
 * @param {string} url - Media URL
 * @param {boolean} [keepFile=false] - Keep file on the worker after sending
 * @returns {Promise<{ buffer: Buffer, title: string, fileName: string }>}
 */
async function runJob(type, url, keepFile = false) {
    let id;
    try {
        ({ id } = await workerRequest("POST", "/jobs", { type, url, keepFile }, SHORT_TIMEOUT));
    } catch (error) {
        if (error.status !== 404) throw error;
        logger.warn("Worker has no /jobs endpoint, using legacy request (update the worker!)");
        const data = await workerRequest("POST", `/${type}`, { url, keepFile }, JOB_TIMEOUT);
        return {
            buffer: Buffer.from(data.buffer, "base64"),
            title: data.title || "",
            fileName: data.fileName || "",
        };
    }

    const deadline = Date.now() + JOB_TIMEOUT;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));

        let res;
        try {
            res = await workerFetch("GET", `/jobs/${id}`, null, REQUEST_TIMEOUT);
        } catch (error) {
            // Transient tunnel hiccups shouldn't kill a long job
            if (error.status === 404) throw new Error("Download job was lost (worker restarted?)");
            if (error.status || error.message.includes("offline")) throw error;
            logger.warn(`Polling job ${id} failed, retrying:`, error.message);
            continue;
        }

        if (res.status === 202) {
            await res.body?.cancel();
            continue;
        }

        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            title: decodeURIComponent(res.headers.get("x-title") || ""),
            fileName: decodeURIComponent(res.headers.get("x-file-name") || ""),
        };
    }

    throw new Error("⚠️ Download took too long");
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
    const ttl = healthCache.online ? HEALTH_CACHE_MS : HEALTH_CACHE_OFFLINE_MS;
    if (now - healthCache.checkedAt < ttl) {
        return healthCache.online;
    }

    try {
        const info = await workerRequest("GET", "/health", null, SHORT_TIMEOUT);
        healthCache = { online: true, checkedAt: now, info };
        return true;
    } catch {
        healthCache = { online: false, checkedAt: now, info: null };
        return false;
    }
}

/**
 * Returns the worker's latest health payload (yt-dlp version, active jobs), or null if offline.
 * @returns {Promise<object|null>}
 */
async function getWorkerInfo() {
    healthCache.checkedAt = 0; // always fresh
    return (await isWorkerOnline()) ? healthCache.info : null;
}

/**
 * Downloads a video via yt-dlp on the local worker.
 *
 * @param {string} url - Video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<{ buffer: Buffer, title: string }>}
 */
async function workerDownload(url, keepFile = false) {
    const { buffer, title } = await runJob("download", url, keepFile);
    return { buffer, title };
}

/**
 * Downloads a full-resolution video via yt-dlp on the local worker.
 *
 * @param {string} url - Video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<{ buffer: Buffer, title: string, fileName: string }>}
 */
async function workerFullRes(url, keepFile = false) {
    return runJob("fullres", url, keepFile);
}

/**
 * Downloads audio (MP3) via yt-dlp on the local worker.
 *
 * @param {string} url - Audio/video URL
 * @param {boolean} [keepFile=false] - Keep file after sending
 * @returns {Promise<{ buffer: Buffer, title: string, fileName: string }>}
 */
async function workerAudio(url, keepFile = false) {
    return runJob("audio", url, keepFile);
}

/**
 * Downloads a video via yt-dlp for sticker creation (/ds command).
 * Only downloads — sticker creation happens on cloud.
 *
 * @param {string} url - Video URL
 * @returns {Promise<Buffer>} Video buffer
 */
async function workerDownloadStickerSource(url) {
    const { buffer } = await runJob("sticker-src", url);
    return buffer;
}

/**
 * Searches YouTube via yt-dlp on the local worker.
 *
 * @param {string} query - Search query
 * @returns {Promise<Array<{ url: string, title: string }>>}
 */
async function workerSearch(query) {
    const data = await workerRequest("POST", "/search", { query }, SEARCH_TIMEOUT);
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
    getWorkerInfo,
    workerDownload,
    workerFullRes,
    workerAudio,
    workerDownloadStickerSource,
    workerSearch,
    workerPlay,
    workerVolume,
};
