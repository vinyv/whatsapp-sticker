/**
 * Audio (sound) stickers: a sticker that plays a short voice clip when tapped.
 *
 * WhatsApp encodes them as `Message.audioStickerMessage` (field 134, a
 * FutureProofMessage) wrapping a regular `stickerMessage` whose new
 * `audioMessage` field (26) carries an Ogg/Opus clip uploaded as normal audio.
 * Baileys 7.0.0-rc14 doesn't know either field and protobufjs would silently
 * drop them on encode, so we teach the generated encoders about them here.
 *
 * Baileys sends this shape with stanza type="text" (it doesn't unwrap the
 * wrapper), which is what phones accept for audio stickers.
 * @module audio-sticker
 */

const { proto, prepareWAMessageMedia, generateMessageIDV2 } = require("@whiskeysockets/baileys");
const { logger } = require("./utils");

const MESSAGE_AUDIO_STICKER_TAG = (134 << 3) | 2; // Message.audioStickerMessage
const STICKER_AUDIO_TAG = (26 << 3) | 2; // StickerMessage.audioMessage

let patched = false;

/**
 * Adds the audio sticker fields to Baileys' generated protobuf encoders.
 * Nested encoders call `$root.proto.Message.encode` dynamically, so wrapping
 * the static functions covers every path (device fan-out, retries, etc).
 */
function installAudioStickerProto() {
    if (patched) return;
    patched = true;

    const { Message } = proto;
    const { StickerMessage, AudioMessage, FutureProofMessage } = Message;

    const encodeSticker = StickerMessage.encode;
    StickerMessage.encode = function encode(m, w) {
        w = encodeSticker.call(this, m, w);
        if (m.audioMessage != null) {
            AudioMessage.encode(m.audioMessage, w.uint32(STICKER_AUDIO_TAG).fork()).ldelim();
        }
        return w;
    };

    const encodeMessage = Message.encode;
    Message.encode = function encode(m, w) {
        w = encodeMessage.call(this, m, w);
        if (m.audioStickerMessage != null) {
            FutureProofMessage.encode(m.audioStickerMessage, w.uint32(MESSAGE_AUDIO_STICKER_TAG).fork()).ldelim();
        }
        return w;
    };
}

/**
 * Uploads the sticker and its audio clip, then sends them as one audio sticker.
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {string} chatId - Chat ID
 * @param {{ sticker: Buffer, audio: Buffer, seconds: number, isAnimated: boolean }} media
 * @returns {Promise<{ key: object }>} Sent message key (for reactions)
 */
async function sendAudioSticker(sock, chatId, { sticker, audio, seconds, isAnimated }) {
    installAudioStickerProto();

    const uploadOpts = { upload: sock.waUploadToServer };
    const [{ stickerMessage }, { audioMessage }] = await Promise.all([
        prepareWAMessageMedia({ sticker }, uploadOpts),
        prepareWAMessageMedia(
            { audio, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds },
            uploadOpts
        ),
    ]);

    stickerMessage.isAnimated = isAnimated;
    stickerMessage.width = 512;
    stickerMessage.height = 512;
    stickerMessage.audioMessage = audioMessage;

    const id = generateMessageIDV2(sock.user?.id);
    await sock.relayMessage(
        chatId,
        { audioStickerMessage: { message: { stickerMessage } } },
        { messageId: id }
    );
    logger.info(`Audio sticker sent (${seconds}s audio)`);

    return { key: { remoteJid: chatId, fromMe: true, id } };
}

/**
 * Sends an audio sticker and marks it with the bot's 🤖 reaction,
 * mirroring sendWithBotReaction for regular messages.
 */
async function sendAudioStickerWithBotReaction(sock, chatId, media) {
    const sent = await sendAudioSticker(sock, chatId, media);
    await sock.sendMessage(chatId, { react: { text: "🤖", key: sent.key } });
    return sent;
}

module.exports = {
    installAudioStickerProto,
    sendAudioSticker,
    sendAudioStickerWithBotReaction,
};
