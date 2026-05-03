/**
 * Utility functions for the WhatsApp Sticker Bot
 * @module utils
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { CLEANUP_DELAY } = require("./config");

const execFileAsync = promisify(execFile);

/**
 * Semaphore for managing concurrent async operations atomically
 * Prevents race conditions with counter-based concurrency limits
 */
class Semaphore {
    /**
     * @param {number} max - Maximum concurrent operations allowed
     */
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }

    /**
     * Acquires a permit, waiting if necessary until one is available
     * @returns {Promise<boolean>} Resolves to true when permit is acquired
     */
    async acquire() {
        if (this.current < this.max) {
            this.current++;
            return true;
        }
        return new Promise((resolve) => this.queue.push(resolve));
    }

    /**
     * Tries to acquire a permit without waiting
     * @returns {boolean} True if permit was acquired, false if at capacity
     */
    tryAcquire() {
        if (this.current < this.max) {
            this.current++;
            return true;
        }
        return false;
    }

    /**
     * Releases a permit, allowing a waiting operation to proceed
     */
    release() {
        this.current--;
        if (this.queue.length > 0) {
            this.current++;
            this.queue.shift()(true);
        }
    }

    /** @returns {number} Number of available permits */
    get available() {
        return this.max - this.current;
    }

    /** @returns {number} Number of active operations */
    get active() {
        return this.current;
    }
}

// ============================================================
// BRAZIL TIMEZONE HELPER
// ============================================================

/**
 * Gets the current date/time in UTC-3 (Brazil time)
 * @returns {Date} Date object adjusted to Brazil timezone
 */
function getBrazilDate() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utc + 3600000 * -3);
}

// ============================================================
// MESSAGE HELPERS
// ============================================================

/**
 * Creates a reaction helper function for a specific message
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID to send reaction to
 * @param {object} msgKey - Message key to react to
 * @returns {function(string): Promise<void>} Reaction function
 */
function createReactHelper(sock, chatId, msgKey) {
    return (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msgKey } });
}

/**
 * Sends a message and adds a robot emoji reaction to mark it as bot-sent
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID to send message to
 * @param {object} content - Message content (same format as sock.sendMessage)
 * @returns {Promise<object>} The sent message info
 */
async function sendWithBotReaction(sock, chatId, content) {
    const sentMsg = await sock.sendMessage(chatId, content);
    // React to the sent message with a robot emoji to mark it as bot-sent
    await sock.sendMessage(chatId, { react: { text: "🤖", key: sentMsg.key } });
    return sentMsg;
}

// ============================================================
// URL & COOKIE HELPERS
// ============================================================

/**
 * Validates if a string is a valid HTTP/HTTPS URL
 * @param {string} string - String to validate
 * @returns {boolean} True if valid URL
 */
function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Checks if a URL requires cookies for yt-dlp
 * @param {string} url - URL to check
 * @returns {boolean} True if cookies are needed
 */
function needsCookies(url) {
    return /tiktok\.com|x\.com|youtube\.com|youtu\.be|^ytsearch/i.test(url);
}

// ============================================================
// FILE CLEANUP
// ============================================================

/**
 * Safely deletes a file asynchronously, ignoring errors
 * @param {string} filePath - Path to file to delete
 */
async function safeUnlink(filePath) {
    try {
        await fsPromises.unlink(filePath);
    } catch {
        // Ignore — file may not exist
    }
}

/**
 * Schedules a file for cleanup after a delay
 * @param {string} filePath - Path to file to delete
 * @param {number} [delay=CLEANUP_DELAY] - Delay in milliseconds
 */
function scheduleCleanup(filePath, delay = CLEANUP_DELAY) {
    setTimeout(() => {
        fsPromises.unlink(filePath)
            .then(() => console.log("Cleaned up:", filePath))
            .catch((err) => {
                if (err.code !== "ENOENT") {
                    console.warn("Cleanup warning:", err.message);
                }
            });
    }, delay);
}

/**
 * Cleans up files matching a pattern in a directory
 * @param {string} directory - Directory to search
 * @param {string} prefix - Filename prefix to match
 * @param {number} [delay=CLEANUP_DELAY] - Delay in milliseconds
 */
function schedulePatternCleanup(directory, prefix, delay = CLEANUP_DELAY) {
    setTimeout(async () => {
        try {
            const files = await fsPromises.readdir(directory);
            for (const file of files) {
                if (file.startsWith(prefix)) {
                    await fsPromises.unlink(path.join(directory, file))
                        .then(() => console.log("Cleaned up:", file))
                        .catch((err) => {
                            if (err.code !== "ENOENT") {
                                console.warn("Cleanup warning:", err.message);
                            }
                        });
                }
            }
        } catch (err) {
            console.warn("Pattern cleanup warning:", err.message);
        }
    }, delay);
}

// ============================================================
// HARDWARE DETECTION (CACHED)
// ============================================================

/** @type {boolean|null} Cached NVENC support result */
let _nvencCached = null;

/**
 * Checks if NVIDIA NVENC hardware encoding is available (cached)
 * @returns {Promise<boolean>} True if NVENC is available
 */
async function hasNvencSupport() {
    if (_nvencCached !== null) return _nvencCached;
    try {
        const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], {
            timeout: 10000,
        });
        _nvencCached = stdout.includes("h264_nvenc");
    } catch {
        _nvencCached = false;
    }
    return _nvencCached;
}

// ============================================================
// LOGGING
// ============================================================

/**
 * Gets current timestamp formatted as DD/MM/YY-HH:mm:ss in UTC-3
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
    const brDate = getBrazilDate();

    const dd = String(brDate.getDate()).padStart(2, '0');
    const mm = String(brDate.getMonth() + 1).padStart(2, '0');
    const yy = String(brDate.getFullYear()).slice(-2);
    const hh = String(brDate.getHours()).padStart(2, '0');
    const min = String(brDate.getMinutes()).padStart(2, '0');
    const sec = String(brDate.getSeconds()).padStart(2, '0');

    return `${dd}/${mm}/${yy}-${hh}:${min}:${sec}`;
}

/**
 * Logger with consistent formatting and timestamps
 */
const logger = {
    info: (...args) => console.log(`[${getTimestamp()}] [INFO]`, ...args),
    warn: (...args) => console.warn(`[${getTimestamp()}] [WARN]`, ...args),
    error: (...args) => console.error(`[${getTimestamp()}] [ERROR]`, ...args),
    debug: (...args) => {
        if (process.env.DEBUG) {
            console.log(`[${getTimestamp()}] [DEBUG]`, ...args);
        }
    },
};

module.exports = {
    execFileAsync,
    createReactHelper,
    sendWithBotReaction,
    isValidUrl,
    needsCookies,
    safeUnlink,
    scheduleCleanup,
    schedulePatternCleanup,
    hasNvencSupport,
    getBrazilDate,
    logger,
    Semaphore,
};
