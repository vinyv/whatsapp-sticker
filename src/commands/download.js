/**
 * Video download command handler
 * Delegates to the local worker API for yt-dlp/FFmpeg operations.
 * @module commands/download
 */

const { createSticker } = require("../sticker");
const { handleSearchCommand } = require("./search");
const { createReactHelper, sendWithBotReaction, isValidUrl, logger, Semaphore } = require("../utils");
const { RATE_LIMIT_MS, MAX_CONCURRENT_DOWNLOADS } = require("../config");
const {
    isWorkerOnline,
    workerDownload,
    workerFullRes,
    workerAudio,
    workerDownloadStickerSource,
} = require("../local-worker-client");

/** @type {RegExp} Matches /d, /dd, /da, /dda, /ds, /df, or /p followed by a URL or query */
const DOWNLOAD_PATTERN = /^\/(d(?:d|a|da|s|f)?|p)\s+(.+)$/i;

/** @type {Map<string, number>} Tracks last download time per chat for rate limiting */
const lastDownloadTime = new Map();

/** @type {Semaphore} Concurrent download limiter */
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

// Cleanup old rate limit entries every 60 seconds to prevent memory leak
const RATE_LIMIT_CLEANUP_INTERVAL = 60000;
setInterval(() => {
    const now = Date.now();
    for (const [chatId, timestamp] of lastDownloadTime.entries()) {
        if (now - timestamp > RATE_LIMIT_MS) {
            lastDownloadTime.delete(chatId);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

/**
 * Checks if a message matches the download command
 * @param {string} text - Message text
 * @returns {RegExpMatchArray|null} Match result or null
 */
function matchDownloadCommand(text) {
    return text.match(DOWNLOAD_PATTERN);
}

/**
 * Checks if a chat is rate limited
 * @param {string} chatId - Chat ID to check
 * @returns {number|null} Seconds remaining if rate limited, null if not
 */
function getRateLimitRemaining(chatId) {
    const lastTime = lastDownloadTime.get(chatId);
    if (!lastTime) return null;

    const elapsed = Date.now() - lastTime;
    if (elapsed < RATE_LIMIT_MS) {
        return Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    }
    return null;
}

/**
 * Handles the video download command
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {RegExpMatchArray} match - Regex match result
 * @returns {Promise<boolean>} True if command was handled
 */
async function handleDownloadCommand(sock, msg, chatId, match) {
    const react = createReactHelper(sock, chatId, msg.key);
    const command = match[1].toLowerCase();
    const url = match[2].trim();
    const isPlay = command === "p";
    const isAudio = command === "da" || command === "dda";
    const isSticker = command === "ds";
    const isDocFile = command === "df";
    const keepFile = command === "dd" || command === "dda"; // /ds doesn't support keeping file for now

    // /p always searches YouTube (no downloads involved)
    if (isPlay) {
        await handleSearchCommand(sock, msg, chatId, url, command);
        return true;
    }

    // Check rate limit for this chat
    const rateLimitSeconds = getRateLimitRemaining(chatId);
    if (rateLimitSeconds !== null) {
        logger.warn(`Rate limited: ${chatId} (${rateLimitSeconds}s remaining)`);
        await react("⏱️");
        await sendWithBotReaction(sock, chatId, {
            text: `⏱️ Please wait ${rateLimitSeconds}s before downloading again`,
        });
        return true;
    }

    // Check concurrent download limit using semaphore (atomic)
    if (!downloadSemaphore.tryAcquire()) {
        logger.warn(`Concurrent limit reached: ${downloadSemaphore.active}/${MAX_CONCURRENT_DOWNLOADS}`);
        await react("🔄");
        await sendWithBotReaction(sock, chatId, {
            text: `🔄 Server busy (${downloadSemaphore.active} downloads in progress). Try again shortly.`,
        });
        return true;
    }

    // If not a valid URL, treat as a YouTube search query
    if (!isValidUrl(url)) {
        downloadSemaphore.release();
        await handleSearchCommand(sock, msg, chatId, url, command);
        return true;
    }

    // Check if local worker is online before starting
    const online = await isWorkerOnline();
    if (!online) {
        downloadSemaphore.release();
        await react("⚠️");
        await sendWithBotReaction(sock, chatId, {
            text: "⚠️ Local server offline. Downloads are unavailable right now.",
        });
        return true;
    }

    // Track this download
    lastDownloadTime.set(chatId, Date.now());

    try {
        let typeLabel = "Video";
        if (isAudio) typeLabel = "Audio";
        if (isSticker) typeLabel = "Sticker";
        if (isDocFile) typeLabel = "Document";

        logger.info(`${typeLabel} download request (${command}):`, url);
        logger.info(`Active downloads: ${downloadSemaphore.active}/${MAX_CONCURRENT_DOWNLOADS}`);
        await react("⏳");

        if (isAudio) {
            const audioBuffer = await workerAudio(url, keepFile);
            logger.info("Audio downloaded, size:", audioBuffer.length, "bytes");

            await sendWithBotReaction(sock, chatId, {
                audio: audioBuffer,
                mimetype: "audio/mpeg",
                ptt: false,  // Send as audio file, not voice note
            });
        } else if (isSticker) {
            // Download video source from local worker, then create sticker on cloud
            const videoBuffer = await workerDownloadStickerSource(url);
            logger.info("Sticker source downloaded, size:", videoBuffer.length, "bytes");

            const stickerBuffer = await createSticker(videoBuffer, true);
            logger.info("Sticker created, size:", stickerBuffer.length, "bytes");

            await sendWithBotReaction(sock, chatId, {
                sticker: stickerBuffer,
            });
        } else if (isDocFile) {
            const { buffer: videoBuffer, title, fileName } = await workerFullRes(url);
            logger.info("Full-res video downloaded, size:", videoBuffer.length, "bytes");

            await sendWithBotReaction(sock, chatId, {
                document: videoBuffer,
                mimetype: "video/mp4",
                fileName: fileName,
                caption: title || undefined,
            });
        } else {
            const { buffer: videoBuffer, title } = await workerDownload(url, keepFile);
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
        logger.info(`${typeLabel} sent successfully!`);
    } catch (error) {
        const typeLabel = isDocFile ? "full-res video" : (isAudio ? "audio" : (isSticker ? "sticker" : "video"));
        logger.error(`Error downloading ${typeLabel}:`, error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: `❌ ${error.message}` });
    } finally {
        // Always release semaphore
        downloadSemaphore.release();
        logger.info(`Download complete. Active downloads: ${downloadSemaphore.active}/${MAX_CONCURRENT_DOWNLOADS}`);
    }

    return true;
}

module.exports = {
    matchDownloadCommand,
    handleDownloadCommand,
};
