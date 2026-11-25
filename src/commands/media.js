/**
 * Shared "fetch media and send it" logic used by download commands
 * and search-result picks.
 * @module commands/media
 */

const { createSticker, createAudioSticker } = require("../sticker");
const { sendAudioStickerWithBotReaction } = require("../audio-sticker");
const { sendWithBotReaction, logger, Semaphore } = require("../utils");
const { MAX_CONCURRENT_DOWNLOADS, MAX_VIDEO_SIZE } = require("../config");
const {
    workerDownload,
    workerFullRes,
    workerAudio,
    workerDownloadStickerSource,
} = require("../local-worker-client");

/** @type {Semaphore} Concurrent download limiter (shared by all download paths) */
const downloadSemaphore = new Semaphore(MAX_CONCURRENT_DOWNLOADS);

/**
 * Maps a command to what it produces
 * @param {string} command - d, dd, da, dda, ds, dsa, df
 * @returns {{ kind: "video"|"audio"|"sticker"|"document", keepFile: boolean, label: string, withAudio?: boolean }}
 */
function describeCommand(command) {
    const keepFile = command === "dd" || command === "dda";
    if (command === "da" || command === "dda") return { kind: "audio", keepFile, label: "audio" };
    if (command === "ds") return { kind: "sticker", keepFile: false, label: "sticker" };
    if (command === "dsa") return { kind: "sticker", keepFile: false, label: "audio sticker", withAudio: true };
    if (command === "df") return { kind: "document", keepFile: false, label: "full-res video" };
    return { kind: "video", keepFile, label: "video" };
}

/**
 * Downloads media for a command and sends it to the chat.
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID
 * @param {string} command - d, dd, da, dda, ds, dsa, df
 * @param {string} url - Media URL
 * @param {object} [options]
 * @param {boolean} [options.localFallback=false] - Download on this machine instead of the worker (/ds, /dsa only)
 */
async function fetchAndSend(sock, chatId, command, url, { localFallback = false } = {}) {
    const { kind, keepFile, withAudio = false } = describeCommand(command);

    if (kind === "audio") {
        const { buffer, title } = await workerAudio(url, keepFile);
        logger.info(`Audio downloaded (${title || "untitled"}), size:`, buffer.length, "bytes");
        await sendWithBotReaction(sock, chatId, { audio: buffer, mimetype: "audio/mpeg", ptt: false });
        return;
    }

    if (kind === "sticker") {
        const downloadHere = () => require("../video").downloadMediaForSticker(url, { withAudio });
        let videoBuffer;
        if (localFallback) {
            videoBuffer = await downloadHere();
        } else {
            try {
                videoBuffer = await workerDownloadStickerSource(url, { withAudio });
            } catch (error) {
                // Workers started before /dsa existed reject the new job type
                if (!(withAudio && error.status === 400 && /unknown job type/.test(error.message))) throw error;
                logger.warn("Worker doesn't support audio sticker sources yet (restart it); downloading here");
                localFallback = true;
                videoBuffer = await downloadHere();
            }
        }
        logger.info(`Sticker source downloaded${localFallback ? " (cloud fallback)" : ""}, size:`, videoBuffer.length, "bytes");

        if (withAudio) {
            await sendAudioStickerFromVideo(sock, chatId, videoBuffer);
            return;
        }

        const stickerBuffer = await createSticker(videoBuffer, true);
        logger.info("Sticker created, size:", stickerBuffer.length, "bytes");
        await sendWithBotReaction(sock, chatId, { sticker: stickerBuffer });
        return;
    }

    const { buffer, title, fileName } =
        kind === "document" ? await workerFullRes(url, keepFile) : await workerDownload(url, keepFile);
    logger.info(`${kind === "document" ? "Full-res video" : "Video"} downloaded, size:`, buffer.length, "bytes");

    // WhatsApp rejects inline videos over the limit; send those as a document instead
    if (kind === "document" || buffer.length > MAX_VIDEO_SIZE) {
        await sendWithBotReaction(sock, chatId, {
            document: buffer,
            mimetype: "video/mp4",
            fileName: fileName || `${(title || "video").replace(/[<>:"/\\|?*]/g, "")}.mp4`,
            caption: title || undefined,
        });
        return;
    }

    await sendWithBotReaction(sock, chatId, {
        video: buffer,
        mimetype: "video/mp4",
        caption: title || undefined,
    });
}

/**
 * Turns a video into an audio sticker and sends it. Videos without sound
 * fall back to a regular animated sticker.
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID
 * @param {Buffer} videoBuffer - Source video
 * @param {Buffer} [audioSource] - Separate audio to use instead of the video's sound (/sv)
 */
async function sendAudioStickerFromVideo(sock, chatId, videoBuffer, audioSource) {
    const { sticker, audio } = await createAudioSticker(videoBuffer, audioSource);
    logger.info("Sticker created, size:", sticker.length, "bytes");

    if (!audio) {
        await sendWithBotReaction(sock, chatId, { sticker });
        return;
    }

    await sendAudioStickerWithBotReaction(sock, chatId, {
        sticker,
        audio: audio.buffer,
        seconds: audio.seconds,
        isAnimated: true,
    });
}

module.exports = {
    downloadSemaphore,
    sendAudioStickerFromVideo,
    describeCommand,
    fetchAndSend,
};
