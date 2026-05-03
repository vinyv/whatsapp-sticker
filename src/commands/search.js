/**
 * YouTube search command handler
 * Searches YouTube for a query, shows 5 results, and lets the user pick one.
 * @module commands/search
 */

const { downloadVideo, downloadAudio, downloadVideoFullRes } = require("../video");
const { createReactHelper, sendWithBotReaction, logger, execFileAsync } = require("../utils");
const { YTDLP_PATH, COOKIES_PATH, DOWNLOAD_TIMEOUT } = require("../config");
const { execFile } = require("child_process");

/** @type {number} How long pending searches stay valid (60 seconds) */
const SEARCH_EXPIRY_MS = 60000;

/**
 * Pending search results per chat
 * @type {Map<string, { results: Array<{url: string, title: string}>, timestamp: number, command: string }>}
 */
const pendingSearches = new Map();

// Cleanup expired searches every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [chatId, search] of pendingSearches.entries()) {
        if (now - search.timestamp > SEARCH_EXPIRY_MS) {
            pendingSearches.delete(chatId);
        }
    }
}, 30000);

/**
 * Searches YouTube for a query and returns up to 5 results
 * @param {string} query - Search query
 * @returns {Promise<Array<{url: string, title: string}>>} Search results
 */
async function searchYouTube(query) {
    // ytsearch5: tells yt-dlp to return 5 YouTube results
    // --print url --print title prints each result's URL and title on separate lines
    const args = [
        `ytsearch5:${query}`,
        "--print", "url",
        "--print", "title",
        "--no-playlist",
        "--no-warnings",
        "--flat-playlist",
        "--cookies", COOKIES_PATH,
    ];

    const { stdout } = await execFileAsync(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT });
    const lines = stdout.trim().split("\n").map(l => l.trim()).filter(Boolean);

    // Lines alternate: url, title, url, title, ...
    const results = [];
    for (let i = 0; i < lines.length - 1; i += 2) {
        results.push({
            url: lines[i],
            title: lines[i + 1],
        });
    }

    return results.slice(0, 5);
}

/**
 * Checks if a message is a search reply (number 1-5 with a pending search)
 * @param {string} text - Message text
 * @param {string} chatId - Chat ID
 * @returns {{ number: number, search: object } | null} Match info or null
 */
function matchSearchReply(text, chatId) {
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);

    if (isNaN(num) || num < 1 || num > 5) return null;
    // Make sure the entire message is just the number
    if (trimmed !== num.toString()) return null;

    const search = pendingSearches.get(chatId);
    if (!search) return null;

    // Check if expired
    if (Date.now() - search.timestamp > SEARCH_EXPIRY_MS) {
        pendingSearches.delete(chatId);
        return null;
    }

    if (num > search.results.length) return null;

    return { number: num, search };
}

/**
 * Handles a YouTube search command — searches and shows results
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {string} query - Search query
 * @param {string} command - Original command (d, dd, da, dda)
 */
async function handleSearchCommand(sock, msg, chatId, query, command) {
    const react = createReactHelper(sock, chatId, msg.key);

    try {
        logger.info(`YouTube search request: "${query}" (command: ${command})`);
        await react("🔍");

        const results = await searchYouTube(query);

        if (results.length === 0) {
            await react("❌");
            await sendWithBotReaction(sock, chatId, { text: "❌ No results found" });
            return;
        }

        // Store pending search
        pendingSearches.set(chatId, {
            results,
            timestamp: Date.now(),
            command,
        });

        // Build numbered list
        const list = results.map((r, i) => `*${i + 1}.* ${r.title}`).join("\n");
        const action = command === "p" ? "play" : "download";
        const message = `🔎 *YouTube Search Results:*\n\n${list}\n\n_Reply with a number (1-${results.length}) to ${action}_`;

        await sendWithBotReaction(sock, chatId, { text: message });
        await react("✅");
    } catch (error) {
        logger.error("YouTube search error:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: "❌ Search failed. Try again." });
    }
}

/**
 * Wakes the monitor using Win32 SendMessage API via a PowerShell script.
 * Uses execFile (no shell) to avoid command injection.
 */
function wakeMonitor() {
    const psScript = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WakeHelper{[DllImport("user32.dll")]public static extern int SendMessage(int hWnd,int hMsg,int wParam,int lParam);}';[WakeHelper]::SendMessage(-1,0x0112,0xF170,-1)`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], (err) => {
        if (err) {
            logger.warn("Monitor wake failed:", err.message);
        } else {
            logger.info("Sent monitor wake signal");
        }
    });
}

/**
 * Opens a URL in Microsoft Edge safely (no shell injection)
 * @param {string} url - URL to open
 */
function openInEdge(url) {
    execFile("cmd", ["/c", "start", "msedge", url], (err) => {
        if (err) {
            logger.warn("Failed to open Edge:", err.message);
        }
    });
}

/**
 * Handles a search reply — downloads the selected result
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {number} number - Selected result number (1-based)
 * @param {object} search - Pending search data
 */
async function handleSearchReply(sock, msg, chatId, number, search) {
    const react = createReactHelper(sock, chatId, msg.key);
    const selected = search.results[number - 1];
    const command = search.command;
    const isPlay = command === "p";
    const isAudio = command === "da" || command === "dda";
    const isDocFile = command === "df";
    const keepFile = command === "dd" || command === "dda";

    // Clear the pending search
    pendingSearches.delete(chatId);

    try {
        logger.info(`Search selection: #${number} "${selected.title}" (${selected.url})`);
        await react("⏳");

        if (isPlay) {
            // Wake the monitor (audio output goes through it)
            wakeMonitor();

            // Open in MS Edge (safe, no shell interpolation)
            openInEdge(selected.url);
            logger.info("Opened in Edge:", selected.url);

            await sendWithBotReaction(sock, chatId, {
                text: `▶️ *Now playing:* ${selected.title}`,
            });
        } else if (isAudio) {
            const audioBuffer = await downloadAudio(selected.url, keepFile);
            logger.info("Audio downloaded, size:", audioBuffer.length, "bytes");

            await sendWithBotReaction(sock, chatId, {
                audio: audioBuffer,
                mimetype: "audio/mpeg",
                ptt: false,
            });
        } else if (isDocFile) {
            const { buffer: videoBuffer, title, fileName } = await downloadVideoFullRes(selected.url);
            logger.info("Full-res video downloaded, size:", videoBuffer.length, "bytes");

            await sendWithBotReaction(sock, chatId, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: fileName,
                caption: title || undefined,
            });
        } else {
            const { buffer: videoBuffer, title } = await downloadVideo(selected.url, keepFile);
            logger.info("Video downloaded, size:", videoBuffer.length, "bytes");

            const sendPayload = {
                video: videoBuffer,
                mimetype: "video/mp4",
            };
            if (title) {
                sendPayload.caption = title;
            }

            await sendWithBotReaction(sock, chatId, sendPayload);
        }

        await react("✅");
        logger.info("Search selection handled successfully!");
    } catch (error) {
        const typeLabel = isPlay ? "play" : (isDocFile ? "full-res video" : (isAudio ? "audio" : "video"));
        logger.error(`Error handling ${typeLabel} from search:`, error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: "❌ Failed to process. Try again." });
    }
}

module.exports = {
    matchSearchReply,
    handleSearchCommand,
    handleSearchReply,
};
