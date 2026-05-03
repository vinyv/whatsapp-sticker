/**
 * YouTube volume control command handler.
 * Controls YouTube player volume via the connected Edge extension.
 * @module commands/volume
 */

const { createReactHelper, sendWithBotReaction, logger } = require("../utils");
const { broadcast, isConnected } = require("../websocket");

/** @type {RegExp} Matches /v followed by a number (0-100) */
const VOLUME_PATTERN = /^\/v\s+(\d+)$/i;

/**
 * Checks if a message matches the volume command
 * @param {string} text - Message text
 * @returns {RegExpMatchArray|null} Match result or null
 */
function matchVolumeCommand(text) {
    return text.match(VOLUME_PATTERN);
}

/**
 * Handles the volume control command
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {RegExpMatchArray} match - Regex match result
 */
async function handleVolumeCommand(sock, msg, chatId, match) {
    const react = createReactHelper(sock, chatId, msg.key);
    const level = parseInt(match[1], 10);

    if (level < 0 || level > 100) {
        await react("❌");
        await sendWithBotReaction(sock, chatId, {
            text: "❌ Volume must be between 0 and 100",
        });
        return;
    }

    if (!isConnected()) {
        await react("❌");
        await sendWithBotReaction(sock, chatId, {
            text: "❌ YouTube extension not connected. Make sure Edge is open with the extension loaded.",
        });
        return;
    }

    try {
        logger.info(`Setting YouTube volume to ${level}%`);

        broadcast({
            type: "setVolume",
            value: level / 100, // YouTube player uses 0.0–1.0
        });

        const emoji = level === 0 ? "🔇" : level <= 30 ? "🔈" : level <= 70 ? "🔉" : "🔊";
        await react(emoji);
        await sendWithBotReaction(sock, chatId, {
            text: `${emoji} YouTube volume set to ${level}%`,
        });
    } catch (error) {
        logger.error("Volume command error:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Error: ${error.message}`,
        });
    }
}

module.exports = {
    matchVolumeCommand,
    handleVolumeCommand,
};
