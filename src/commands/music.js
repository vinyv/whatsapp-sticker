/**
 * Spotify → Apple Music link converter
 * Auto-detects Spotify URLs in messages and replies with the Apple Music equivalent.
 *
 * Strategy:
 *   1. Try Odesli (song.link) API first — returns cross-platform links
 *   2. If Odesli doesn't have Apple Music (common for BR region),
 *      fall back to iTunes Search API using the song metadata from Odesli
 *
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
 * Generic HTTPS GET that returns parsed JSON
 * @param {string} url - Full URL to fetch
 * @returns {Promise<object>} Parsed JSON response
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: API_TIMEOUT }, (res) => {
            let data = "";

            res.on("data", (chunk) => {
                data += chunk;
            });

            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} from ${new URL(url).hostname}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error("Failed to parse JSON response"));
                }
            });
        });

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timed out"));
        });
    });
}

/**
 * Extracts song metadata (title, artist) from Odesli response
 * Prefers the Spotify entity for the most accurate metadata
 * @param {object} data - Odesli API response
 * @returns {{ title: string, artist: string }}
 */
function extractMetadata(data) {
    const entities = data.entitiesByUniqueId || {};

    // Prefer the Spotify entity — it has the original metadata
    const spotifyEntity = Object.values(entities).find(
        (e) => e.apiProvider === "spotify" && e.title
    );
    if (spotifyEntity) {
        return {
            title: spotifyEntity.title,
            artist: spotifyEntity.artistName || "Unknown Artist",
        };
    }

    // Fallback to any entity with a title
    for (const entity of Object.values(entities)) {
        if (entity.title) {
            return {
                title: entity.title,
                artist: entity.artistName || "Unknown Artist",
            };
        }
    }

    return { title: null, artist: null };
}

/**
 * Searches the iTunes API for a song and returns the Apple Music URL
 * @param {string} title - Song title
 * @param {string} artist - Artist name
 * @returns {Promise<{ url: string, title: string, artist: string }|null>}
 */
async function searchItunes(title, artist) {
    const query = encodeURIComponent(`${artist} ${title}`);
    const url = `https://itunes.apple.com/search?term=${query}&media=music&entity=song&limit=1&country=BR`;

    logger.info("iTunes fallback search:", `${artist} - ${title}`);
    const data = await fetchJson(url);

    if (data.results && data.results.length > 0) {
        const result = data.results[0];
        return {
            url: result.trackViewUrl,
            title: result.trackName,
            artist: result.artistName,
        };
    }

    return null;
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

        // 1. Try Odesli's Apple Music link first
        let appleMusicUrl = data.linksByPlatform?.appleMusic?.url;
        let { title, artist } = extractMetadata(data);

        // 2. Fallback: search iTunes directly using Odesli metadata
        if (!appleMusicUrl && title && artist) {
            logger.info("Odesli has no Apple Music link, trying iTunes fallback...");
            const itunesResult = await searchItunes(title, artist);
            if (itunesResult) {
                appleMusicUrl = itunesResult.url;
                // Use iTunes metadata if we got a match (may be slightly different)
                title = itunesResult.title;
                artist = itunesResult.artist;
            }
        }

        if (!appleMusicUrl) {
            await react("⚠️");
            await sendWithBotReaction(sock, chatId, {
                text: "⚠️ This track wasn't found on Apple Music.",
            });
            return true;
        }

        const reply =
            `🎵 *${title}* — _${artist}_\n` +
            `\n` +
            `🍎 ${appleMusicUrl}`;

        await sendWithBotReaction(sock, chatId, { text: reply });
        await react("🍎");

        logger.info("Apple Music link sent:", appleMusicUrl);
    } catch (error) {
        logger.error("Spotify → Apple Music error:", error.message);
        await react("❌");
        await sendWithBotReaction(sock, chatId, {
            text: `❌ Couldn't convert the Spotify link: ${error.message}`,
        });
    }

    return true;
}

/**
 * Fetches data from the Odesli API
 * @param {string} spotifyUrl - Spotify URL to look up
 * @returns {Promise<object>} Parsed JSON response
 */
function fetchOdesli(spotifyUrl) {
    const url = `${ODESLI_API}?url=${encodeURIComponent(spotifyUrl)}`;
    return fetchJson(url);
}

module.exports = {
    matchSpotifyLink,
    handleSpotifyToAppleMusic,
};
