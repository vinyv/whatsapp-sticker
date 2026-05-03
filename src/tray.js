/**
 * System tray functionality
 * @module tray
 */

const fsPromises = require("fs").promises;
const SysTray = require("systray").default;
const { ICON_PATH } = require("./config");
const { logger } = require("./utils");

/** @type {SysTray|null} System tray instance */
let systray = null;

/**
 * Creates the system tray icon
 * @returns {Promise<SysTray|null>} The systray instance, or null if icon not found
 */
async function createTray() {
    // Load icon asynchronously
    let trayIcon = "";
    try {
        const iconBuffer = await fsPromises.readFile(ICON_PATH);
        trayIcon = iconBuffer.toString("base64");
    } catch (err) {
        logger.warn("Icon file not found, skipping tray icon:", err.message);
        return null;
    }

    systray = new SysTray({
        menu: {
            icon: trayIcon,
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
            // Exit clicked — trigger graceful shutdown via SIGINT handler
            logger.info("Exiting via tray...");
            systray.kill(false);
            process.kill(process.pid, "SIGINT");
        }
    });

    logger.info("System tray icon created.");
    return systray;
}

/**
 * Kills the system tray if it exists
 */
function killTray() {
    if (systray) {
        systray.kill(false);
        systray = null;
    }
}

module.exports = {
    createTray,
    killTray,
};
