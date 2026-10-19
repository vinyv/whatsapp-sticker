/**
 * /ping — quick health report: bot uptime, local worker status, yt-dlp version.
 * @module commands/ping
 */

const { sendWithBotReaction, logger } = require("../utils");
const { getWorkerInfo } = require("../local-worker-client");
const { downloadSemaphore } = require("./media");
const { MAX_CONCURRENT_DOWNLOADS } = require("../config");

/** @type {RegExp} Matches /ping */
const PING_PATTERN = /^\/ping\s*$/i;

/**
 * @param {string} text - Message text
 * @returns {boolean}
 */
function matchPingCommand(text) {
    return PING_PATTERN.test(text);
}

/**
 * Formats a duration in seconds as e.g. "2d 3h 4m"
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}

/**
 * Sends the status report
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 */
async function handlePingCommand(sock, msg, chatId) {
    const started = Date.now();
    const worker = await getWorkerInfo().catch(() => null);
    const latency = Date.now() - started;
    const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

    const workerLine = worker
        ? `🟢 PC worker online (${latency}ms)\n🎞️ yt-dlp ${worker.ytdlp || "?"} · ${worker.activeJobs ?? 0} job(s) running`
        : "🔴 PC worker offline — downloads unavailable (/ds still works)";

    logger.info("Ping requested");
    await sendWithBotReaction(sock, chatId, {
        text:
            `🏓 *Pong!*\n\n` +
            `☁️ Bot up ${formatUptime(process.uptime())} · ${memMB} MB RAM\n` +
            `📥 Downloads: ${downloadSemaphore.active}/${MAX_CONCURRENT_DOWNLOADS}\n` +
            workerLine,
    });
}

module.exports = {
    matchPingCommand,
    handlePingCommand,
};
