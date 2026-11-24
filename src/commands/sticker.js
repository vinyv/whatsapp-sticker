/**
 * Sticker command handler
 * @module commands/sticker
 */

const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const { createSticker } = require("../sticker");
const { createReactHelper, sendWithBotReaction, logger } = require("../utils");
const { sendAudioStickerFromVideo } = require("./media");

/** @type {RegExp} /s (regular sticker) or /sa (audio sticker, videos only) */
const STICKER_PATTERN = /^\/(sa?)$/i;

/**
 * Checks if a message is a sticker command
 * @param {string} caption - Image/video caption
 * @param {string} text - Message text
 * @returns {{ isDirectCommand: boolean, isReplyCommand: boolean, withAudio: boolean }}
 */
function matchStickerCommand(caption, text) {
    const direct = caption.trim().match(STICKER_PATTERN);
    const reply = text.trim().match(STICKER_PATTERN);
    const command = (direct || reply)?.[1].toLowerCase();
    return {
        isDirectCommand: Boolean(direct),
        isReplyCommand: Boolean(reply),
        withAudio: command === "sa",
    };
}

/**
 * Handles the sticker creation command
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {object} options - Command options
 * @param {boolean} options.isDirectCommand - True if /s was sent as caption
 * @param {boolean} options.isReplyCommand - True if /s was sent as reply
 * @param {boolean} [options.withAudio=false] - /sa: keep the video's sound (audio sticker)
 * @param {object|null} options.imageMessage - Image message if present
 * @param {object|null} options.videoMessage - Video message if present
 * @returns {Promise<boolean>} True if command was handled (success or fail)
 */
async function handleStickerCommand(sock, msg, chatId, options) {
    const { isDirectCommand, isReplyCommand, imageMessage, videoMessage, withAudio = false } = options;
    const react = createReactHelper(sock, chatId, msg.key);

    if (!isDirectCommand && !isReplyCommand) {
        return false; // Not a sticker command
    }

    try {
        logger.info("Sticker request received. Processing...");
        await react("⏳");

        let buffer;
        let isVideo = false;
        let mediaMsg = msg;

        if (isReplyCommand) {
            // Handle reply-to-media command
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            if (!quotedMsg) {
                logger.info("No quoted message found.");
                await react("❌");
                return true;
            }

            const quotedImage = quotedMsg.imageMessage;
            const quotedVideo = quotedMsg.videoMessage;

            if (!quotedImage && !quotedVideo) {
                logger.info("Quoted message has no media.");
                await react("❌");
                return true;
            }

            const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
            const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;

            mediaMsg = {
                key: {
                    remoteJid: chatId,
                    id: stanzaId,
                    participant: participant,
                },
                message: quotedMsg,
            };

            if (quotedVideo) {
                isVideo = true;
            }
        } else {
            // Handle direct caption command - validate media exists
            if (!imageMessage && !videoMessage) {
                logger.info("Direct command received but no media attached.");
                await react("❌");
                return true;
            }
            if (videoMessage) {
                isVideo = true;
            }
        }

        // Audio stickers take their sound from a video; images have none
        if (withAudio && !isVideo) {
            logger.info("/sa used on an image; audio stickers need a video.");
            await react("❌");
            await sendWithBotReaction(sock, chatId, { text: "❌ /sa precisa de um vídeo com som" });
            return true;
        }

        buffer = await downloadMediaMessage(mediaMsg, "buffer", {});

        if (!buffer) {
            logger.info("Could not download media.");
            await react("❌");
            return true;
        }

        if (withAudio) {
            await sendAudioStickerFromVideo(sock, chatId, buffer);
            await react("✅");
            logger.info("Audio sticker sent successfully!");
            return true;
        }

        const stickerBuffer = await createSticker(buffer, isVideo);
        logger.info("Final sticker size:", stickerBuffer.length, "bytes");

        await sendWithBotReaction(sock, chatId, {
            sticker: stickerBuffer,
        });

        await react("✅");
        logger.info("Sticker sent successfully!");
    } catch (error) {
        logger.error("Error processing sticker:", error.message);
        await react("❌");
    }

    return true;
}

module.exports = {
    matchStickerCommand,
    handleStickerCommand,
};
