/**
 * Video download command handler
 * Delegates to the local worker API for yt-dlp/FFmpeg operations.
 * @module commands/download
 */

const { handleSearchCommand } = require("./search");
const { downloadSemaphore, describeCommand, fetchAndSend } = require("./media");
const { createReactHelper, sendWithBotReaction, isValidUrl, logger } = require("../utils");
const { RATE_LIMIT_MS, MAX_CONCURRENT_DOWNLOADS } = require("../config");
const { isWorkerOnline } = require("../local-worker-client");

/** @type {RegExp} Matches /d, /dd, /da, /dda, /ds, /df, or /p followed by a URL or query */
const DOWNLOAD_PATTERN = /^\/(d(?:d|a|da|s|f)?|p)\s+(.+)$/i;

/** @type {Map<string, number>} Tracks last download time per chat for rate limiting */
const lastDownloadTime = new Map();

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
    const { kind, label } = describeCommand(command);
    const isSticker = kind === "sticker";

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
    let useLocalFallback = false;

    if (!online) {
        if (isSticker) {
            logger.info("Worker offline. Falling back to local cloud execution for /ds");
            useLocalFallback = true;
        } else {
            downloadSemaphore.release();
            await react("⚠️");
            await sendWithBotReaction(sock, chatId, {
                text: "⚠️ Local server offline. Downloads are unavailable right now.",
            });
            return true;
        }
    }

    // Track this download
    lastDownloadTime.set(chatId, Date.now());

    try {
        logger.info(`${label} download request (${command}):`, url);
        logger.info(`Active downloads: ${downloadSemaphore.active}/${MAX_CONCURRENT_DOWNLOADS}`);
        await react("⏳");

        await fetchAndSend(sock, chatId, command, url, { localFallback: useLocalFallback });

        await react("✅");
        logger.info(`${label} sent successfully!`);
    } catch (error) {
        logger.error(`Error downloading ${label}:`, error.message);
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
