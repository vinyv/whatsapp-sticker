/**
 * Spotify → Apple Music link converter
 * Auto-detects Spotify URLs in messages and replies with the Apple Music equivalent
 * using the free Odesli (song.link) API.
 * @module commands/music
 */

const https = require("https");
const { createReactHelper, sendWithBotReaction, logger } = require("../utils");

/** @type {RegExp} Matches Spotify URLs (tracks, albums, playlists, and short links) */
const SPOTIFY_PATTERN =
    /https?:\/\/(?:open\.spotify\.com\/(?:track|album|playlist|artist)\/[a-zA-Z0-9]+(?:\?[^\s]*)?|spotify\.link\/[a-zA-Z0-9]+)/i;

/** @type {string} Odesli API endpoint */
const ODESLI_API = "https://api.odesli.co/v1-alpha.1/links";

/** @type {number} API request timeout in ms */
const API_TIMEOUT = 15000;

/**
 * Checks if a message contains a Spotify link
 * @param {string} text - Message text
 * @returns {string|null} The Spotify URL if found, null otherwise
 */
function matchSpotifyLink(text) {
    if (!text) return null;
    const match = text.match(SPOTIFY_PATTERN);
    return match ? match[0] : null;
}

/**
 * Fetches data from the Odesli API via native https
 * @param {string} spotifyUrl - Spotify URL to look up
 * @returns {Promise<object>} Parsed JSON response
 */
function fetchOdesli(spotifyUrl) {
    const url = `${ODESLI_API}?url=${encodeURIComponent(spotifyUrl)}`;

    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: API_TIMEOUT }, (res) => {
            let data = "";

            res.on("data", (chunk) => {
                data += chunk;
            });

            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Odesli API returned status ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error("Failed to parse Odesli API response"));
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Odesli API request timed out"));
        });
    });
}

/**
 * Extracts song metadata (title, artist, thumbnail) from Odesli response
 * @param {object} data - Odesli API response
 * @returns {{ title: string, artist: string, thumbnail: string|null }}
 */
function extractMetadata(data) {
    const entities = data.entitiesByUniqueId || {};
    // Grab the first entity that has useful metadata
    for (const entity of Object.values(entities)) {
        if (entity.title) {
            return {
                title: entity.title,
                artist: entity.artistName || "Unknown Artist",
                thumbnail: entity.thumbnailUrl || null,
            };
        }
    }
    return { title: "Unknown", artist: "Unknown Artist", thumbnail: null };
}

/**
 * Handles a detected Spotify link by converting it to Apple Music
 * @param {object} sock - WhatsApp socket connection
 * @param {object} msg - Message object
 * @param {string} chatId - Chat ID
 * @param {string} spotifyUrl - Detected Spotify URL
 * @returns {Promise<boolean>} True if handled
 */
async function handleSpotifyToAppleMusic(sock, msg, chatId, spotifyUrl) {
    const react = createReactHelper(sock, chatId, msg.key);

    try {
        await react("🔍");
        logger.info("Spotify → Apple Music lookup:", spotifyUrl);

        const data = await fetchOdesli(spotifyUrl);

        // Extract Apple Music link
        const appleMusicLink = data.linksByPlatform?.appleMusic?.url;

        if (!appleMusicLink) {
            await react("⚠️");
            await sendWithBotReaction(sock, chatId, {
                text: "⚠️ This track wasn't found on Apple Music.",
            });
            return true;
        }

        // Extract metadata for a richer reply
        const { title, artist } = extractMetadata(data);

        const reply =
            `🎵 *${title}* — _${artist}_\n` +
            `\n` +
            `🍎 ${appleMusicLink}`;

        await sendWithBotReaction(sock, chatId, { text: reply });
        await react("🍎");

        logger.info("Apple Music link sent:", appleMusicLink);
    } catch (error) {
        logger.error("Spotify → Apple Music error:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Couldn't convert the Spotify link: ${error.message}`,
        });
    }

    return true;
}

module.exports = {
    matchSpotifyLink,
    handleSpotifyToAppleMusic,
};
