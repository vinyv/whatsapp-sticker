const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const SysTray = require("systray").default;
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const YTDLP_PATH = path.join(__dirname, "yt-dlp.exe");

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const STICKER_PACK = "feito por viny.";
const STICKER_AUTHOR = "viny";

const iconPath = path.join(__dirname, 'icon.ico');
let TRAY_ICON = "";
if (fs.existsSync(iconPath)) {
  TRAY_ICON = fs.readFileSync(iconPath).toString('base64');
}

let systray = null;

function createTray() {
  if (!TRAY_ICON) {
    console.log("Warning: Icon file not found, skipping tray icon");
    return;
  }

  systray = new SysTray({
    menu: {
      icon: TRAY_ICON,
      title: "",
      tooltip: "WhatsApp Sticker Bot - Running",
      items: [
        {
          title: "WhatsApp Sticker Bot",
          tooltip: "Bot is running",
          enabled: false,
        },
        {
          title: "Exit",
          tooltip: "Stop the bot",
          enabled: true,
        },
      ],
    },
    debug: false,
    copyDir: true,
  });

  systray.onClick((action) => {
    if (action.seq_id === 1) {
      // Exit clicked
      console.log("Exiting...");
      systray.kill(false);
      process.exit(0);
    }
  });

  console.log("System tray icon created.");
}

async function createSticker(buffer, isVideo = false) {
  let quality = 50;
  let stickerBuffer;
  const maxSize = isVideo ? 500000 : 100000;

  while (quality >= 10) {
    const sticker = new Sticker(buffer, {
      pack: STICKER_PACK,
      author: STICKER_AUTHOR,
      type: StickerTypes.FULL,
      quality: quality,
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

async function downloadVideo(url, keepFile = false) {
  const timestamp = Date.now();
  const outputTemplate = path.join(DOWNLOADS_DIR, `video_${timestamp}.%(ext)s`);
  const finalOutputPath = path.join(DOWNLOADS_DIR, `video_${timestamp}.mp4`);

  try {
    // Check if it's a TikTok URL (requires cookies)
    const isTikTok = url.includes("tiktok.com");

    // Build the command arguments
    // Download BEST quality available (any codec) - we'll re-encode to H.264 with FFmpeg
    // This ensures maximum quality since AV1/VP9 sources are often higher quality than H.264
    const args = [
      "-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
      "-o", outputTemplate,
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-warnings",
    ];

    // Add cookies only for TikTok
    if (isTikTok) {
      args.push("--cookies", path.join(__dirname, "cookies.txt"));
    }

    args.push(url);

    console.log("Running yt-dlp with args:", args.join(" "));
    await execFileAsync(YTDLP_PATH, args, { timeout: 300000 }); // 5 minute timeout for download

    // Find the downloaded file
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const downloadedFile = files.find(f => f.startsWith(`video_${timestamp}`));

    if (!downloadedFile) {
      throw new Error("Download failed - file not found");
    }

    let filePath = path.join(DOWNLOADS_DIR, downloadedFile);
    console.log("Downloaded file:", filePath);

    // Check video codec for logging purposes
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath
      ], { timeout: 30000 });

      const videoCodec = stdout.trim().toLowerCase();
      console.log("Source video codec:", videoCodec);
    } catch (probeError) {
      console.log("Could not probe video codec:", probeError.message);
    }

    // Always re-encode to H.264/AAC for WhatsApp compatibility and consistent quality
    // This ensures we get maximum quality from AV1/VP9 sources converted to H.264
    {
      const reencodedPath = path.join(DOWNLOADS_DIR, `video_${timestamp}_compat.mp4`);
      console.log("Re-encoding video to H.264/AAC for WhatsApp compatibility...");

      const MAX_FILE_SIZE = 64 * 1024 * 1024; // 64 MB WhatsApp limit
      let currentCrf = 18;  // Start with high quality
      const maxCrf = 28;    // Minimum acceptable quality
      let encodeSuccess = false;

      while (currentCrf <= maxCrf) {
        try {
          console.log(`Encoding with CRF ${currentCrf}...`);

          await execFileAsync("ffmpeg", [
            "-i", filePath,
            "-c:v", "libx264",
            "-preset", "slow",
            "-crf", currentCrf.toString(),
            "-profile:v", "high",
            "-level", "4.0",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-y",
            reencodedPath
          ], { timeout: 600000 }); // 10 minute timeout for re-encoding

          // Check file size
          const stats = fs.statSync(reencodedPath);
          const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
          console.log(`Encoded file size: ${fileSizeMB} MB`);

          if (stats.size <= MAX_FILE_SIZE) {
            encodeSuccess = true;
            break;
          }

          // File too large, try again with lower quality
          console.log(`File exceeds 64 MB limit, re-encoding with lower quality...`);
          currentCrf += 3;

        } catch (encodeError) {
          console.error("Re-encoding failed:", encodeError.message);
          break;
        }
      }

      if (encodeSuccess) {
        // Delete the original file and use the re-encoded one
        try {
          fs.unlinkSync(filePath);
        } catch (e) { }

        filePath = reencodedPath;
        console.log("Re-encoding complete:", filePath);
      } else if (fs.existsSync(reencodedPath)) {
        // Even if over limit, use the last encoded file (best effort)
        try {
          fs.unlinkSync(filePath);
        } catch (e) { }

        filePath = reencodedPath;
        console.log("Warning: Could not get file under 64 MB, using best effort:", filePath);
      } else {
        console.error("Re-encoding failed completely, using original file");
      }
    }

    const buffer = fs.readFileSync(filePath);

    // Clean up the downloaded file after a delay (unless keepFile is true)
    if (!keepFile) {
      setTimeout(() => {
        try {
          fs.unlinkSync(filePath);
          console.log("Cleaned up:", path.basename(filePath));
        } catch (e) {
          console.log("Could not delete file (will be cleaned up later):", path.basename(filePath));
        }
      }, 5000);
    } else {
      console.log("Keeping file:", filePath);
    }

    return buffer;
  } catch (error) {
    // Clean up any partial downloads after a delay (only on error)
    setTimeout(() => {
      try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        for (const file of files) {
          if (file.startsWith(`video_${timestamp}`)) {
            try {
              fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
            } catch (e) { }
          }
        }
      } catch (e) { }
    }, 5000);
    throw error;
  }
}

async function startBot() {
  const authDir = path.join(__dirname, ".wwebjs_auth");
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR code to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        "Connection closed due to",
        lastDisconnect?.error,
        ", reconnecting:",
        shouldReconnect,
      );
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === "open") {
      console.log("Client is ready!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const chatId = msg.key.remoteJid;

      const textMessage =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      const imageMessage = msg.message?.imageMessage;
      const videoMessage = msg.message?.videoMessage;
      const caption = imageMessage?.caption || videoMessage?.caption || "";

      // Check for /d or /dd command (video download)
      // /d = download and purge, /dd = download and keep
      const downloadMatch = textMessage.match(/^\/(dd?)\s+(.+)$/i);

      if (downloadMatch) {
        const command = downloadMatch[1].toLowerCase();
        const videoUrl = downloadMatch[2].trim();
        const keepFile = command === "dd";

        try {
          console.log(`Video download request received (${command}):`, videoUrl);

          await sock.sendMessage(chatId, {
            react: { text: "⏳", key: msg.key }
          });

          const videoBuffer = await downloadVideo(videoUrl, keepFile);

          console.log("Video downloaded, size:", videoBuffer.length, "bytes");

          await sock.sendMessage(chatId, {
            video: videoBuffer,
            mimetype: "video/mp4"
          });

          await sock.sendMessage(chatId, {
            react: { text: "✅", key: msg.key }
          });

          console.log("Video sent successfully!");
        } catch (error) {
          console.error("Error downloading video:", error.message);
          await sock.sendMessage(chatId, {
            react: { text: "❌", key: msg.key }
          });
          await sock.sendMessage(chatId, {
            text: `❌ Error: ${error.message}`
          });
        }
        continue;
      }

      // Check for /s command (sticker)
      const isDirectCommand = caption.toLowerCase().trim() === "/s";
      const isReplyCommand = textMessage.toLowerCase().trim() === "/s";

      if (!isDirectCommand && !isReplyCommand) {
        continue;
      }

      try {
        console.log("Sticker request received. Processing...");

        await sock.sendMessage(chatId, {
          react: { text: "⏳", key: msg.key }
        });

        let buffer;
        let isVideo = false;
        let mediaMsg = msg;

        if (isReplyCommand) {
          const quotedMsg =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

          if (!quotedMsg) {
            console.log("No quoted message found.");
            await sock.sendMessage(chatId, {
              react: { text: "❌", key: msg.key }
            });
            continue;
          }

          const quotedImage = quotedMsg.imageMessage;
          const quotedVideo = quotedMsg.videoMessage;

          if (!quotedImage && !quotedVideo) {
            console.log("Quoted message has no media.");
            await sock.sendMessage(chatId, {
              react: { text: "❌", key: msg.key }
            });
            continue;
          }

          const stanzaId =
            msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
          const participant =
            msg.message?.extendedTextMessage?.contextInfo?.participant;

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
          if (videoMessage) {
            isVideo = true;
          }
        }

        buffer = await downloadMediaMessage(mediaMsg, "buffer", {});

        if (!buffer) {
          console.log("Could not download media.");
          await sock.sendMessage(chatId, {
            react: { text: "❌", key: msg.key }
          });
          continue;
        }

        const stickerBuffer = await createSticker(buffer, isVideo);

        console.log("Final sticker size:", stickerBuffer.length, "bytes");

        await sock.sendMessage(chatId, {
          sticker: stickerBuffer,
          isAvatar: true,
        });

        await sock.sendMessage(chatId, {
          react: { text: "✅", key: msg.key }
        });

        console.log("Sticker sent successfully!");
      } catch (error) {
        console.error("Error processing sticker:", error.message);
        await sock.sendMessage(chatId, {
          react: { text: "❌", key: msg.key }
        });
      }
    }
  });
}

console.log("Initializing WhatsApp bot...");

// Only show tray icon if --tray flag is passed
const showTray = process.argv.includes('--tray');
if (showTray) {
  createTray();
}

startBot();
