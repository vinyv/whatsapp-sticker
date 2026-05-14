/**
 * WppBot Local Worker API
 *
 * Express server that runs on the local PC and exposes
 * yt-dlp downloads, video encoding, Edge playback, and
 * volume control as HTTP endpoints. The cloud bot calls
 * these via Cloudflare Tunnel.
 *
 * Endpoints:
 *   GET  /health          → { status: "ok" }
 *   POST /download        → yt-dlp + FFmpeg video
 *   POST /audio           → yt-dlp MP3 extract
 *   POST /sticker-src     → yt-dlp download for /ds
 *   POST /fullres         → yt-dlp + FFmpeg full-res
 *   POST /search          → yt-dlp ytsearch5
 *   POST /play            → open Edge + wake monitor
 *   POST /volume          → WebSocket broadcast
 */

require("dotenv/config");
const express = require("express");
const { execFile } = require("child_process");
const path = require("path");

// Import modules from parent project
const { downloadVideo, downloadAudio, downloadMediaForSticker, downloadVideoFullRes } = require("../src/video");
const { startWebSocketServer, broadcast, isConnected } = require("../src/websocket");
const { logger, execFileAsync } = require("../src/utils");
const { YTDLP_PATH, COOKIES_PATH, DOWNLOAD_TIMEOUT } = require("../src/config");

const PORT = process.env.WORKER_PORT || 3001;
const SECRET = process.env.WORKER_SECRET || "";

const app = express();

// Body size limit: 100MB (for large video buffers)
app.use(express.json({ limit: "100mb" }));

// === Health Check ===

app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

// === Authentication Middleware ===

function authMiddleware(req, res, next) {
    if (!SECRET) {
        // No secret configured — allow all (dev mode)
        return next();
    }
    const provided = req.headers["x-worker-secret"];
    if (provided !== SECRET) {
        logger.warn(`Unauthorized request from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

app.use(authMiddleware);

// === Video Download ===

app.post("/download", async (req, res) => {
    const { url, keepFile } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
        logger.info(`[Worker] Download request: ${url}`);
        const { buffer, title } = await downloadVideo(url, keepFile || false);

        res.json({
            buffer: buffer.toString("base64"),
            title,
        });
    } catch (error) {
        logger.error("[Worker] Download failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Full-res Video Download ===

app.post("/fullres", async (req, res) => {
    const { url, keepFile } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
        logger.info(`[Worker] Full-res download request: ${url}`);
        const { buffer, title, fileName } = await downloadVideoFullRes(url, keepFile || false);

        res.json({
            buffer: buffer.toString("base64"),
            title,
            fileName,
        });
    } catch (error) {
        logger.error("[Worker] Full-res download failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Audio Download ===

app.post("/audio", async (req, res) => {
    const { url, keepFile } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
        logger.info(`[Worker] Audio download request: ${url}`);
        const buffer = await downloadAudio(url, keepFile || false);

        res.json({
            buffer: buffer.toString("base64"),
        });
    } catch (error) {
        logger.error("[Worker] Audio download failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Sticker Source Download (for /ds command) ===

app.post("/sticker-src", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
        logger.info(`[Worker] Sticker source download: ${url}`);
        const buffer = await downloadMediaForSticker(url);

        res.json({
            buffer: buffer.toString("base64"),
        });
    } catch (error) {
        logger.error("[Worker] Sticker source download failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === YouTube Search ===

app.post("/search", async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });

    try {
        logger.info(`[Worker] YouTube search: "${query}"`);

        const args = [
            `ytsearch5:${query}`,
            "-j",                       // JSON output (always UTF-8)
            "--flat-playlist",
            "--no-warnings",
            "--cookies", COOKIES_PATH,
        ];

        const { stdout } = await execFileAsync(YTDLP_PATH, args, {
            timeout: DOWNLOAD_TIMEOUT,
            encoding: "utf8",
            env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        });
        const lines = stdout.trim().split("\n").filter(Boolean);

        // Each line is a JSON object with url/title fields
        const results = [];
        for (const line of lines) {
            try {
                const info = JSON.parse(line);
                results.push({
                    url: info.url || info.webpage_url || "",
                    title: info.title || "",
                });
            } catch {
                // Skip malformed lines
            }
        }

        res.json({ results: results.slice(0, 5) });
    } catch (error) {
        logger.error("[Worker] YouTube search failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Play in Edge ===

app.post("/play", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    try {
        logger.info(`[Worker] Play request: ${url}`);

        // Wake the monitor
        const psScript = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WakeHelper{[DllImport("user32.dll")]public static extern int SendMessage(int hWnd,int hMsg,int wParam,int lParam);}';[WakeHelper]::SendMessage(-1,0x0112,0xF170,-1)`;
        execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], (err) => {
            if (err) logger.warn("Monitor wake failed:", err.message);
            else logger.info("Sent monitor wake signal");
        });

        // Open in Edge
        execFile("cmd", ["/c", "start", "msedge", url], (err) => {
            if (err) logger.warn("Failed to open Edge:", err.message);
        });

        res.json({ ok: true });
    } catch (error) {
        logger.error("[Worker] Play failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Volume Control ===

app.post("/volume", async (req, res) => {
    const { volume } = req.body;
    if (volume === undefined || volume < 0 || volume > 100) {
        return res.status(400).json({ error: "volume must be 0-100" });
    }

    try {
        if (!isConnected()) {
            return res.status(503).json({ error: "YouTube extension not connected" });
        }

        logger.info(`[Worker] Volume set to ${volume}%`);
        broadcast({
            type: "setVolume",
            value: volume / 100,
        });

        res.json({ ok: true });
    } catch (error) {
        logger.error("[Worker] Volume failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// === Start Server ===

// Start WebSocket server for volume extension
startWebSocketServer();

app.listen(PORT, () => {
    logger.info(`[Worker] Local worker API listening on http://localhost:${PORT}`);
    logger.info(`[Worker] Secret: ${SECRET ? "configured" : "NOT SET (dev mode)"}`);
});
