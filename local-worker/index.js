/**
 * WppBot Local Worker API
 *
 * Express server that runs on the local PC and exposes
 * yt-dlp downloads, video encoding, Edge playback, and
 * volume control as HTTP endpoints. The cloud bot calls
 * these via Cloudflare Tunnel.
 *
 * Endpoints:
 *   GET  /health          → { status, ytdlp, activeJobs }
 *   POST /jobs            → start a download job { type, url, keepFile } → 202 { id }
 *   GET  /jobs/:id        → 202 while running, 200 + raw file when done, 500 on failure
 *   POST /search          → yt-dlp ytsearch5
 *   POST /play            → open Edge + wake monitor
 *   POST /volume          → WebSocket broadcast
 *   POST /notify          → queue a WhatsApp message from a PC script { text }
 *   GET  /notifications   → hand queued messages to the cloud bot (and clear them)
 *
 * Downloads run as jobs because Cloudflare cuts proxied requests
 * after 100 seconds, which long downloads/encodes easily exceed.
 * The legacy blocking endpoints (/download, /fullres, /audio,
 * /sticker-src) are kept for older cloud deployments.
 */

require("dotenv/config");
const express = require("express");
const { execFile } = require("child_process");
const { randomUUID, timingSafeEqual } = require("crypto");

// Import modules from parent project
const { downloadVideo, downloadAudio, downloadMediaForSticker, downloadVideoFullRes } = require("../src/video");
const { startWebSocketServer, broadcast, isConnected } = require("../src/websocket");
const { logger, isValidUrl } = require("../src/utils");
const ytdlp = require("../src/ytdlp");

const PORT = process.env.WORKER_PORT || 3001;
const SECRET = process.env.WORKER_SECRET || "";

/** @type {number} Finished jobs are dropped if not collected within this time */
const JOB_RESULT_TTL_MS = 10 * 60 * 1000;

const app = express();

app.use(express.json({ limit: "1mb" }));

// === Health Check ===

app.get("/health", async (req, res) => {
    res.json({
        status: "ok",
        timestamp: Date.now(),
        ytdlp: await ytdlp.getVersion(),
        activeJobs: [...jobs.values()].filter((j) => j.status === "running").length,
    });
});

// === Authentication Middleware ===

function secretMatches(provided) {
    const a = Buffer.from(String(provided || ""));
    const b = Buffer.from(SECRET);
    return a.length === b.length && timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
    if (!SECRET) {
        // No secret configured — allow all (dev mode)
        return next();
    }
    if (!secretMatches(req.headers["x-worker-secret"])) {
        logger.warn(`Unauthorized request from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

app.use(authMiddleware);

// === Download runners (shared by jobs and legacy endpoints) ===

/**
 * Each runner returns { buffer, title?, fileName? }
 * @type {Record<string, (url: string, keepFile: boolean) => Promise<{buffer: Buffer, title?: string, fileName?: string}>>}
 */
const runners = {
    download: (url, keepFile) => downloadVideo(url, keepFile),
    fullres: (url, keepFile) => downloadVideoFullRes(url, keepFile),
    audio: (url, keepFile) => downloadAudio(url, keepFile),
    "sticker-src": async (url) => ({ buffer: await downloadMediaForSticker(url) }),
};

// === Jobs ===

/**
 * @type {Map<string, { status: "running"|"done"|"error", type: string, result?: object, error?: string, finishedAt?: number }>}
 */
const jobs = new Map();

// Drop results nobody came back for (e.g. the cloud bot restarted)
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt && now - job.finishedAt > JOB_RESULT_TTL_MS) {
            jobs.delete(id);
        }
    }
}, 60000).unref();

app.post("/jobs", (req, res) => {
    const { type, url, keepFile } = req.body || {};
    const runner = runners[type];
    if (!runner) return res.status(400).json({ error: `unknown job type: ${type}` });
    if (!isValidUrl(url)) return res.status(400).json({ error: "a valid http(s) url is required" });

    const id = randomUUID();
    const job = { status: "running", type };
    jobs.set(id, job);
    logger.info(`[Worker] Job ${id} (${type}): ${url}`);

    runner(url, Boolean(keepFile))
        .then((result) => {
            job.status = "done";
            job.result = result;
            logger.info(`[Worker] Job ${id} done (${(result.buffer.length / 1024 / 1024).toFixed(2)} MB)`);
        })
        .catch((error) => {
            job.status = "error";
            job.error = error.message;
            logger.error(`[Worker] Job ${id} failed:`, error.message);
        })
        .finally(() => {
            job.finishedAt = Date.now();
        });

    res.status(202).json({ id });
});

app.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "job not found" });

    if (job.status === "running") {
        return res.status(202).json({ status: "running" });
    }

    jobs.delete(req.params.id);

    if (job.status === "error") {
        return res.status(500).json({ error: job.error });
    }

    const { buffer, title, fileName } = job.result;
    res.set({
        "Content-Type": "application/octet-stream",
        "X-Title": encodeURIComponent(title || ""),
        "X-File-Name": encodeURIComponent(fileName || ""),
    });
    res.send(buffer);
});

// === Legacy blocking endpoints (base64 JSON) ===

for (const type of Object.keys(runners)) {
    app.post(`/${type}`, async (req, res) => {
        const { url, keepFile } = req.body || {};
        if (!url) return res.status(400).json({ error: "url is required" });

        try {
            logger.info(`[Worker] ${type} request (legacy): ${url}`);
            const { buffer, title, fileName } = await runners[type](url, Boolean(keepFile));
            res.json({ buffer: buffer.toString("base64"), title, fileName });
        } catch (error) {
            logger.error(`[Worker] ${type} failed:`, error.message);
            res.status(500).json({ error: error.message });
        }
    });
}

// === YouTube Search ===

app.post("/search", async (req, res) => {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: "query is required" });

    try {
        logger.info(`[Worker] YouTube search: "${query}"`);
        res.json({ results: await ytdlp.search(query, 5) });
    } catch (error) {
        logger.error("[Worker] YouTube search failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Play in Edge ===

app.post("/play", async (req, res) => {
    const { url } = req.body || {};
    // Only real http(s) URLs: the value ends up on a command line
    if (!isValidUrl(url)) return res.status(400).json({ error: "a valid http(s) url is required" });

    logger.info(`[Worker] Play request: ${url}`);

    // Wake the monitor
    const psScript = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WakeHelper{[DllImport("user32.dll")]public static extern int SendMessage(int hWnd,int hMsg,int wParam,int lParam);}';[WakeHelper]::SendMessage(-1,0x0112,0xF170,-1)`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], (err) => {
        if (err) logger.warn("Monitor wake failed:", err.message);
        else logger.info("Sent monitor wake signal");
    });

    // Open in Edge. The URL is passed through an env var so cmd.exe metacharacters
    // in it (& | ^ etc. — common in query strings) can't break or inject commands.
    execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "Start-Process msedge -ArgumentList $env:WPPBOT_PLAY_URL"],
        { env: { ...process.env, WPPBOT_PLAY_URL: url } },
        (err) => {
            if (err) logger.warn("Failed to open Edge:", err.message);
        }
    );

    res.json({ ok: true });
});

// === Volume Control ===

app.post("/volume", async (req, res) => {
    const volume = Number(req.body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
        return res.status(400).json({ error: "volume must be 0-100" });
    }

    if (!isConnected()) {
        return res.status(503).json({ error: "YouTube extension not connected" });
    }

    logger.info(`[Worker] Volume set to ${volume}%`);
    broadcast({
        type: "setVolume",
        value: volume / 100,
    });

    res.json({ ok: true });
});

// === Notifications (PC scripts → WhatsApp) ===

/** @type {number} Oldest messages are dropped past this, in case the cloud is down for long */
const MAX_QUEUED_NOTIFICATIONS = 50;

/** @type {Array<{ text: string, createdAt: number }>} Messages waiting for the cloud bot to collect */
const notifications = [];

app.post("/notify", (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });

    notifications.push({ text: text.slice(0, 4000), createdAt: Date.now() });
    if (notifications.length > MAX_QUEUED_NOTIFICATIONS) notifications.shift();
    logger.info(`[Worker] Notification queued (${notifications.length} pending)`);

    res.status(202).json({ queued: notifications.length });
});

app.get("/notifications", (req, res) => {
    res.json({ notifications: notifications.splice(0) });
});

// === Start Server ===

// Start WebSocket server for volume extension
startWebSocketServer();

// Keep yt-dlp current — site extractors break often
ytdlp.scheduleAutoUpdate();

app.listen(PORT, () => {
    logger.info(`[Worker] Local worker API listening on http://localhost:${PORT}`);
    if (SECRET) {
        logger.info("[Worker] Secret: configured");
    } else {
        logger.warn("[Worker] WORKER_SECRET NOT SET — anyone who can reach this port (or your tunnel) can use it!");
    }
});
