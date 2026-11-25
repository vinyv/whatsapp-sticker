/**
 * Sticker command handler
 * @module commands/sticker
 */

const { downloadMediaMessage, normalizeMessageContent } = require("@whiskeysockets/baileys");
const { createSticker } = require("../sticker");
const { createReactHelper, sendWithBotReaction, logger } = require("../utils");
const { sendAudioStickerFromVideo } = require("./media");

/** @type {RegExp} /s (regular sticker), /sa (audio sticker, videos only) or /sv (video + audio sent next) */
const STICKER_PATTERN = /^\/(sa?|sv)$/i;

/** @type {number} How long /sv waits for the audio, in ms (2 minutes) */
const PENDING_AUDIO_TTL_MS = 120000;

/**
 * Videos from /sv waiting for their audio, keyed by chat + sender
 * @type {Map<string, { video: Buffer, expiresAt: number }>}
 */
const pendingAudio = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of pendingAudio) {
        if (entry.expiresAt < now) pendingAudio.delete(key);
    }
}, 30000).unref();

/** @returns {string} Key for a sender's pending /sv in a chat */
function pendingKey(chatId, msg) {
    return `${chatId}|${msg.key.participant || msg.key.remoteJid}`;
}

/**
 * Checks if a message is a sticker command
 * @param {string} caption - Image/video caption
 * @param {string} text - Message text
 * @returns {{ isDirectCommand: boolean, isReplyCommand: boolean, withAudio: boolean, waitForAudio: boolean }}
 */
function matchStickerCommand(caption, text) {
    const direct = caption.trim().match(STICKER_PATTERN);
    const reply = text.trim().match(STICKER_PATTERN);
    const command = (direct || reply)?.[1].toLowerCase();
    return {
        isDirectCommand: Boolean(direct),
        isReplyCommand: Boolean(reply),
        withAudio: command === "sa",
        waitForAudio: command === "sv",
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
 * @param {boolean} [options.waitForAudio=false] - /sv: keep the video and wait for an audio message
 * @param {object|null} options.imageMessage - Image message if present
 * @param {object|null} options.videoMessage - Video message if present
 * @returns {Promise<boolean>} True if command was handled (success or fail)
 */
async function handleStickerCommand(sock, msg, chatId, options) {
    const { isDirectCommand, isReplyCommand, imageMessage, videoMessage, withAudio = false, waitForAudio = false } = options;
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
            // The quoted media may itself be wrapped (view-once, disappearing chat)
            const quotedMsg = normalizeMessageContent(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage);

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
        if (waitForAudio && !isVideo) {
            logger.info("/sv used on an image; it needs a video.");
            await react("❌");
            await sendWithBotReaction(sock, chatId, { text: "❌ /sv precisa de um vídeo" });
            return true;
        }

        buffer = await downloadMediaMessage(mediaMsg, "buffer", {});

        if (!buffer) {
            logger.info("Could not download media.");
            await react("❌");
            return true;
        }

        if (waitForAudio) {
            pendingAudio.set(pendingKey(chatId, msg), { video: buffer, expiresAt: Date.now() + PENDING_AUDIO_TTL_MS });
            logger.info("/sv: video stored, waiting for the audio");
            await react("🎙️");
            await sendWithBotReaction(sock, chatId, {
                text: "🎙️ Agora mande o áudio (ou outro vídeo, que eu uso o som dele) em até 2 minutos",
            });
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

/**
 * Finishes a pending /sv: when the same person sends an audio, or another
 * video, in the same chat, turns the stored video into a sticker that plays
 * that sound, cut to the first video's length.
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object (already unwrapped)
 * @param {string} chatId - Chat ID
 * @returns {Promise<boolean>} True if the message was a pending /sv audio and was handled
 */
async function handlePendingStickerAudio(sock, msg, chatId) {
    // The sound can come from an audio or from a second video (its track is used).
    // A video captioned with a command (e.g. a new "/sv") is a new request instead.
    const { audioMessage, videoMessage } = msg.message || {};
    if (!audioMessage && !(videoMessage && !videoMessage.caption?.trim().startsWith("/"))) return false;

    const key = pendingKey(chatId, msg);
    const pending = pendingAudio.get(key);
    if (!pending || pending.expiresAt < Date.now()) return false;
    pendingAudio.delete(key);

    const react = createReactHelper(sock, chatId, msg.key);
    try {
        logger.info(`/sv: ${audioMessage ? "audio" : "video"} received, making the sticker`);
        await react("⏳");
        const audio = await downloadMediaMessage(msg, "buffer", {});
        await sendAudioStickerFromVideo(sock, chatId, pending.video, audio);
        await react("✅");
        logger.info("/sv sticker sent successfully!");
    } catch (error) {
        logger.error("Error processing /sv audio:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, { text: `❌ ${error.message}` });
    }
    return true;
}

module.exports = {
    matchStickerCommand,
    handleStickerCommand,
    handlePendingStickerAudio,
};
