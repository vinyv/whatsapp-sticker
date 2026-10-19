/**
 * Shared "fetch media and send it" logic used by download commands
 * and search-result picks.
 * @module commands/media
 */

const { createSticker } = require("../sticker");
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
 * @param {string} command - d, dd, da, dda, ds, df
 * @returns {{ kind: "video"|"audio"|"sticker"|"document", keepFile: boolean, label: string }}
 */
function describeCommand(command) {
    const keepFile = command === "dd" || command === "dda";
    if (command === "da" || command === "dda") return { kind: "audio", keepFile, label: "audio" };
    if (command === "ds") return { kind: "sticker", keepFile: false, label: "sticker" };
    if (command === "df") return { kind: "document", keepFile: false, label: "full-res video" };
    return { kind: "video", keepFile, label: "video" };
}

/**
 * Downloads media for a command and sends it to the chat.
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID
 * @param {string} command - d, dd, da, dda, ds, df
 * @param {string} url - Media URL
 * @param {object} [options]
 * @param {boolean} [options.localFallback=false] - Download on this machine instead of the worker (/ds only)
 */
async function fetchAndSend(sock, chatId, command, url, { localFallback = false } = {}) {
    const { kind, keepFile } = describeCommand(command);

    if (kind === "audio") {
        const { buffer, title } = await workerAudio(url, keepFile);
        logger.info(`Audio downloaded (${title || "untitled"}), size:`, buffer.length, "bytes");
        await sendWithBotReaction(sock, chatId, { audio: buffer, mimetype: "audio/mpeg", ptt: false });
        return;
    }

    if (kind === "sticker") {
        let videoBuffer;
        if (localFallback) {
            const { downloadMediaForSticker } = require("../video");
            videoBuffer = await downloadMediaForSticker(url);
        } else {
            videoBuffer = await workerDownloadStickerSource(url);
        }
        logger.info(`Sticker source downloaded${localFallback ? " (cloud fallback)" : ""}, size:`, videoBuffer.length, "bytes");

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

module.exports = {
    downloadSemaphore,
    describeCommand,
    fetchAndSend,
};
