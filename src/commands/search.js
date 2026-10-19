/**
 * YouTube search command handler
 * Searches YouTube via the local worker, shows 5 results, and lets the user pick one.
 * @module commands/search
 */

const { createReactHelper, sendWithBotReaction, logger } = require("../utils");
const { isWorkerOnline, workerSearch, workerPlay } = require("../local-worker-client");
const { downloadSemaphore, describeCommand, fetchAndSend } = require("./media");

/**
 * Formats seconds as m:ss or h:mm:ss
 * @param {number|null} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "";
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

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
 * @param {string} command - Original command (d, dd, da, dda, p)
 */
async function handleSearchCommand(sock, msg, chatId, query, command) {
    const react = createReactHelper(sock, chatId, msg.key);

    try {
        logger.info(`YouTube search request: "${query}" (command: ${command})`);
        await react("🔍");

        // Check worker health
        const online = await isWorkerOnline();
        if (!online) {
            await react("⚠️");
            await sendWithBotReaction(sock, chatId, {
                text: "⚠️ Local server offline. Search is unavailable right now.",
            });
            return;
        }

        const results = await workerSearch(query);

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
        const list = results
            .map((r, i) => {
                const details = [formatDuration(r.duration), r.channel].filter(Boolean).join(" · ");
                return `*${i + 1}.* ${r.title}${details ? `\n     _${details}_` : ""}`;
            })
            .join("\n");
        const action = command === "p" ? "play" : "download";
        const message = `🔎 *YouTube Search Results:*\n\n${list}\n\n_Reply with a number (1-${results.length}) to ${action}_`;

        await sendWithBotReaction(sock, chatId, { text: message });
        await react("✅");
    } catch (error) {
        logger.error("YouTube search error:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: `❌ ${error.message}` });
    }
}

/**
 * Handles a search reply — downloads or plays the selected result
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
    const { label } = describeCommand(command);

    // Clear the pending search
    pendingSearches.delete(chatId);

    // Downloads from search picks count against the same concurrency limit
    if (!isPlay && !downloadSemaphore.tryAcquire()) {
        await react("🔄");
        await sendWithBotReaction(sock, chatId, {
            text: `🔄 Server busy (${downloadSemaphore.active} downloads in progress). Try again shortly.`,
        });
        return;
    }

    try {
        logger.info(`Search selection: #${number} "${selected.title}" (${selected.url})`);
        await react("⏳");

        if (isPlay) {
            // Delegate to local worker: open in Edge + wake monitor
            await workerPlay(selected.url);
            logger.info("Opened in Edge:", selected.url);

            await sendWithBotReaction(sock, chatId, {
                text: `▶️ *Now playing:* ${selected.title}`,
            });
        } else {
            await fetchAndSend(sock, chatId, command, selected.url);
        }

        await react("✅");
        logger.info("Search selection handled successfully!");
    } catch (error) {
        logger.error(`Error handling ${isPlay ? "play" : label} from search:`, error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: `❌ ${error.message}` });
    } finally {
        if (!isPlay) downloadSemaphore.release();
    }
}

module.exports = {
    matchSearchReply,
    handleSearchCommand,
    handleSearchReply,
};
