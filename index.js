/**
 * WhatsApp Sticker Bot - Main Entry Point (Cloud Version)
 *
 * Runs on Oracle Cloud. Video/download operations are delegated
 * to the local worker API via Cloudflare Tunnel.
 *
 * Commands:
 *   /s - Convert image/video to sticker (runs on cloud)
 *   /d <url> - Download video and send (via local worker)
 *   /dd <url> - Download video and keep file (via local worker)
 *   /da <url> - Download audio (MP3) and send (via local worker)
 *   /dda <url> - Download audio (MP3) and keep file (via local worker)
 *   /ds <url> - Download video and create sticker (download: local, sticker: cloud)
 *   /df <url> - Download full-res video as document (via local worker)
 *   /p <query> - Search YouTube and play in Edge (via local worker)
 *   /v <0-100> - Set YouTube player volume (via local worker)
 *   /ping - Bot / local worker / yt-dlp status
 *   /clube - Book club main menu (runs on cloud)
 *   /cancelar - Cancel active flow
 *
 * Also delivers messages that scripts on the PC queue on the worker (POST /notify).
 *
 * @author viny
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

// Local modules
const { AUTH_DIR, NOTIFY_JID, NOTIFY_POLL_MS } = require("./src/config");
const { logger } = require("./src/utils");
const { getSession } = require("./src/session");
const ytdlp = require("./src/ytdlp");
const { isWorkerOnline, workerTakeNotifications } = require("./src/local-worker-client");
const {
  matchDownloadCommand,
  handleDownloadCommand,
  matchStickerCommand,
  handleStickerCommand,
  matchSearchReply,
  handleSearchReply,
  matchBookClubCommand,
  handleBookClubCommand,
  handleSessionStep,
  matchVolumeCommand,
  handleVolumeCommand,
  matchSpotifyLink,
  handleSpotifyToAppleMusic,
  matchPingCommand,
  handlePingCommand,
} = require("./src/commands");

// === Graceful Shutdown ===
let isShuttingDown = false;

/**
 * Handles graceful shutdown of the bot
 * @param {string} signal - Signal that triggered shutdown
 */
function handleShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Give a moment for cleanup
  setTimeout(() => {
    logger.info("Shutdown complete.");
    process.exit(0);
  }, 1000);
}

// Register shutdown handlers
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  handleShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
});

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

/** Hardcoded fallback version in case live fetch fails */
const FALLBACK_VERSION = [2, 3000, 1033893291];

/**
 * Fetches the latest WhatsApp Web version, falling back to hardcoded if unavailable
 * @returns {Promise<number[]>} Version array [major, minor, patch]
 */
async function getWaVersion() {
  try {
    const { version, isLatest } = await fetchLatestWaWebVersion();
    logger.info(`WA Web version: ${version.join(".")} (latest: ${isLatest})`);
    return version;
  } catch (err) {
    logger.warn("Could not fetch latest WA Web version, using fallback:", err.message);
    return FALLBACK_VERSION;
  }
}

/** @type {number} Consecutive failed connection attempts (drives reconnect backoff) */
let reconnectAttempts = 0;

/** @type {object|null} Socket of the current open connection (null while reconnecting) */
let activeSock = null;

/** @type {string|null} NOTIFY_JID resolved to the JID WhatsApp actually uses (cached) */
let notifyJid = null;

/**
 * Resolves NOTIFY_JID. A plain phone number is looked up with onWhatsApp, since
 * Brazilian numbers are often registered without the extra 9 the phone shows.
 * @param {object} sock - WhatsApp socket connection
 * @returns {Promise<string|null>} The JID, or null if the number isn't on WhatsApp
 */
async function resolveNotifyJid(sock) {
  if (notifyJid) return notifyJid;
  if (NOTIFY_JID.includes("@")) return (notifyJid = NOTIFY_JID);

  const [result] = await sock.onWhatsApp(NOTIFY_JID.replace(/\D/g, ""));
  if (!result?.exists) {
    logger.error(`NOTIFY_JID ${NOTIFY_JID} is not on WhatsApp — PC notifications not sent`);
    return null;
  }
  logger.info(`PC notifications go to ${result.jid}`);
  return (notifyJid = result.jid);
}

/**
 * Sends the messages that scripts on the local PC queued on the worker.
 * Runs on a timer; skips quietly while WhatsApp or the PC is offline.
 * Only ever sends to NOTIFY_JID: with it unset nothing is sent and the queue is left alone.
 */
async function deliverPcNotifications() {
  const sock = activeSock;
  if (!NOTIFY_JID || !sock || !(await isWorkerOnline())) return;

  const to = await resolveNotifyJid(sock);
  if (!to) return;

  const notifications = await workerTakeNotifications();

  for (const { text } of notifications) {
    try {
      await sock.sendMessage(to, { text });
      logger.info(`Delivered PC notification to ${to}`);
    } catch (err) {
      logger.error("Failed to deliver PC notification:", err);
    }
  }
}

/**
 * Starts the WhatsApp bot and sets up event handlers
 * @returns {Promise<void>}
 */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await getWaVersion();

  const sock = makeWASocket({
    // Message history isn't used; skipping it speeds up reconnects and saves memory
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    auth: state,
    printQRInTerminal: false,
    version,
    browser: ["Chrome", "Desktop", "145.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code to login:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      logger.info(
        "Connection closed due to",
        lastDisconnect?.error,
        ", reconnecting:",
        shouldReconnect
      );

      sock.ev.removeAllListeners();
      activeSock = null;

      if (shouldReconnect) {
        // Exponential backoff (1s → 60s) so a WhatsApp outage doesn't cause a reconnect storm
        const delay = Math.min(1000 * 2 ** reconnectAttempts, 60000);
        reconnectAttempts++;
        logger.info(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
        setTimeout(() => startBot().catch((err) => logger.error("Reconnect failed:", err)), delay);
      } else {
        // Session is gone. Move the dead credentials aside (kept as a backup) and
        // exit, so systemd restarts us into a fresh QR prompt instead of looping
        const backup = `${AUTH_DIR}.loggedout-${Date.now()}`;
        try {
          fs.renameSync(AUTH_DIR, backup);
          logger.error(`Logged out. Old session moved to ${backup}; restart to scan a new QR code.`);
        } catch (err) {
          logger.error(`Logged out. Could not move ${AUTH_DIR} (${err.message}); delete it and restart.`);
        }
        process.exit(1);
      }
    } else if (connection === "open") {
      reconnectAttempts = 0;
      activeSock = sock;
      logger.info("Client is ready!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error("Error handling message:", err);
      }
    }
  });
}

/**
 * Handles an incoming message and routes it to appropriate command handlers.
 *
 * Routing priority:
 * 1. Active session (multi-step flow in progress)
 * 2. Book club commands (including /cancelar)
 * 3. Search reply (picking a result)
 * 4. Download commands
 * 5. Sticker commands
 *
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 */
async function handleMessage(sock, msg) {
  const chatId = msg.key.remoteJid;
  const userId = msg.key.participant || msg.key.remoteJid;

  const textMessage =
    msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
  const imageMessage = msg.message?.imageMessage;
  const videoMessage = msg.message?.videoMessage;
  const caption = imageMessage?.caption || videoMessage?.caption || "";

  // Get effective text (text message or caption)
  const text = textMessage || caption;

  // 1. Check for active session — route text to session handler
  if (text && getSession(userId)) {
    // If user types a new command while in session, let it fall through
    // (the command handler will clear the session and start a new one)
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const handled = await handleSessionStep(sock, msg, chatId, userId, text);
      if (handled) return;
    }
  }

  // 1b. Status check (/ping)
  if (matchPingCommand(textMessage)) {
    await handlePingCommand(sock, msg, chatId);
    return;
  }

  // 2. Book club commands (includes /cancelar, /clube, direct commands)
  const bookClubMatch = matchBookClubCommand(textMessage);
  if (bookClubMatch) {
    await handleBookClubCommand(sock, msg, chatId, bookClubMatch);
    return;
  }

  // 3. Search reply (user picking a result 1-5)
  const searchMatch = matchSearchReply(textMessage, chatId);
  if (searchMatch) {
    await handleSearchReply(sock, msg, chatId, searchMatch.number, searchMatch.search);
    return;
  }

  // 4. Spotify → Apple Music auto-convert (no command prefix needed)
  const spotifyUrl = matchSpotifyLink(text);
  if (spotifyUrl) {
    await handleSpotifyToAppleMusic(sock, msg, chatId, spotifyUrl);
    return;
  }

  // 5. Volume command (/v)
  const volumeMatch = matchVolumeCommand(textMessage);
  if (volumeMatch) {
    await handleVolumeCommand(sock, msg, chatId, volumeMatch);
    return;
  }

  // 6. Download commands (/d, /dd, /da, /dda, /p)
  const downloadMatch = matchDownloadCommand(textMessage);
  if (downloadMatch) {
    await handleDownloadCommand(sock, msg, chatId, downloadMatch);
    return;
  }

  // 7. Sticker commands (/s)
  const { isDirectCommand, isReplyCommand } = matchStickerCommand(caption, textMessage);
  if (isDirectCommand || isReplyCommand) {
    await handleStickerCommand(sock, msg, chatId, {
      isDirectCommand,
      isReplyCommand,
      imageMessage,
      videoMessage,
    });
  }
}

// === Main Execution ===

logger.info("Initializing WhatsApp bot (cloud mode)...");

// yt-dlp is only used here for the /ds fallback, but keep it current too
ytdlp.scheduleAutoUpdate();

// Messages from PC scripts (e.g. daily status checks) arrive through the worker
if (!NOTIFY_JID) logger.info("NOTIFY_JID not set — PC notifications are disabled");
setInterval(() => {
  deliverPcNotifications().catch((err) => logger.warn("PC notification check failed:", err.message));
}, NOTIFY_POLL_MS);

// Start the bot with proper error handling
(async () => {
  await startBot();
})().catch((err) => {
  logger.error("Fatal error starting bot:", err);
  process.exit(1);
});
