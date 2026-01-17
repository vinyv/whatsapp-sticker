const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const STICKER_PACK = 'feito por viny.';
const STICKER_AUTHOR = 'viny';

async function createSticker(buffer, isVideo = false) {
    // Start with quality 50 and decrease if needed
    let quality = 50;
    let stickerBuffer;
    const maxSize = isVideo ? 500000 : 100000; // 500KB for video, 100KB for static

    while (quality >= 10) {
        const sticker = new Sticker(buffer, {
            pack: STICKER_PACK,
            author: STICKER_AUTHOR,
            type: StickerTypes.FULL,
            quality: quality
        });

        await sticker.build();
        stickerBuffer = await sticker.get();

        console.log(`Quality ${quality}: ${stickerBuffer.length} bytes`);

        if (stickerBuffer.length <= maxSize) {
            break;
        }

        quality -= 10;
    }

    return stickerBuffer;
}

async function startBot() {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Scan this QR code to login:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Client is ready!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            const chatId = msg.key.remoteJid;

            const textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const imageMessage = msg.message?.imageMessage;
            const videoMessage = msg.message?.videoMessage;
            const caption = imageMessage?.caption || videoMessage?.caption || '';

            const isDirectCommand = caption.toLowerCase().trim() === '/s';
            const isReplyCommand = textMessage.toLowerCase().trim() === '/s';

            if (!isDirectCommand && !isReplyCommand) {
                continue;
            }

            try {
                console.log('Sticker request received. Processing...');

                let buffer;
                let isVideo = false;
                let mediaMsg = msg;

                if (isReplyCommand) {
                    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

                    if (!quotedMsg) {
                        console.log('No quoted message found.');
                        continue;
                    }

                    const quotedImage = quotedMsg.imageMessage;
                    const quotedVideo = quotedMsg.videoMessage;

                    if (!quotedImage && !quotedVideo) {
                        console.log('Quoted message has no media.');
                        continue;
                    }

                    const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                    const participant = msg.message?.extendedTextMessage?.contextInfo?.participant;

                    mediaMsg = {
                        key: {
                            remoteJid: chatId,
                            id: stanzaId,
                            participant: participant
                        },
                        message: quotedMsg
                    };

                    if (quotedVideo) {
                        isVideo = true;
                    }
                } else {
                    if (videoMessage) {
                        isVideo = true;
                    }
                }

                buffer = await downloadMediaMessage(mediaMsg, 'buffer', {});

                if (!buffer) {
                    console.log('Could not download media.');
                    continue;
                }

                const stickerBuffer = await createSticker(buffer, isVideo);

                console.log('Final sticker size:', stickerBuffer.length, 'bytes');

                await sock.sendMessage(chatId, {
                    sticker: stickerBuffer
                });

                console.log('Sticker sent successfully!');
            } catch (error) {
                console.error('Error processing sticker:', error.message);
            }
        }
    });
}

console.log('Initializing WhatsApp bot...');
startBot();
