/**
 * Spotify → Apple Music link converter
 * Auto-detects Spotify URLs in messages and replies with the Apple Music equivalent.
 *
 * Strategy (no API keys needed):
 *   1. Read the title/artist from the Spotify page's Open Graph tags
 *      (the same metadata WhatsApp uses for link previews)
 *   2. Look it up with the iTunes Search API
 *
 * Odesli (song.link) used to do this, but its keyless public API was
 * retired on 2026-07-31 and now answers 401 PUBLIC_API_ACCESS_DEPRECATED.
 *
 * @module commands/music
 */

const { createReactHelper, sendWithBotReaction, logger } = require("../utils");

/** @type {RegExp} Matches Spotify URLs (tracks, albums, playlists, artists, and short links) */
const SPOTIFY_PATTERN =
    /https?:\/\/(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:track|album|playlist|artist)\/[a-zA-Z0-9]+(?:\?[^\s]*)?|spotify\.link\/[a-zA-Z0-9]+)/i;

/** @type {number} API request timeout in ms */
const API_TIMEOUT = 15000;

/** @type {string} iTunes storefront to search (BR catalog) */
const ITUNES_COUNTRY = "BR";

/** Browser-like UA: Spotify serves the full server-rendered page (with meta tags) to browsers */
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * iTunes entity to search for each Spotify type, and the result field holding the link
 * @type {Record<string, { entity: string, urlField: string, nameField: string }>}
 */
const ITUNES_ENTITIES = {
    track: { entity: "song", urlField: "trackViewUrl", nameField: "trackName" },
    album: { entity: "album", urlField: "collectionViewUrl", nameField: "collectionName" },
    artist: { entity: "musicArtist", urlField: "artistLinkUrl", nameField: "artistName" },
};

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
 * Fetches a URL with a timeout, throwing on non-2xx responses
 * @param {string} url - Full URL to fetch
 * @returns {Promise<Response>}
 */
async function fetchOk(url) {
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
        signal: AbortSignal.timeout(API_TIMEOUT),
        redirect: "follow",
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    }
    return res;
}

/**
 * Decodes the HTML entities that show up in meta tag values
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
    return str
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

/**
 * Reads a <meta property|name="key" content="..."> value from HTML
 * @param {string} html
 * @param {string} key
 * @returns {string|null}
 */
function getMeta(html, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Find each <meta> tag, then read its attributes (handles either attribute order and quote style)
    const keyRe = new RegExp(`(?:property|name)\\s*=\\s*(["'])${escaped}\\1`, "i");
    const tag = (html.match(/<meta\b[^>]*>/gi) || []).find((t) => keyRe.test(t));
    const m = tag && tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const value = m && (m[1] ?? m[2]);
    return value ? decodeEntities(value).trim() : null;
}

/**
 * Extracts type, title and artist from a Spotify page.
 *
 * Spotify pages look like:
 *   og:title        "Never Gonna Give You Up"
 *   og:description  "Rick Astley · Song · 1987"   (album: "Artist · Album · 1987 · 12 songs")
 *   <title>         "Never Gonna Give You Up - song and lyrics by Rick Astley | Spotify"
 *
 * @param {string} html - Page HTML
 * @param {string} finalUrl - URL after redirects (resolves spotify.link short links)
 * @returns {{ type: string|null, title: string|null, artist: string|null }}
 */
function parseSpotifyPage(html, finalUrl) {
    const typeMatch = finalUrl.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist)\//i);
    const urlType = typeMatch ? typeMatch[1].toLowerCase() : null;
    const ogType = getMeta(html, "og:type") || "";
    const type =
        urlType ||
        (ogType.includes("song") ? "track" : ogType.includes("album") ? "album" : ogType.includes("musician") ? "artist" : null);

    const title = getMeta(html, "og:title");
    let artist = getMeta(html, "music:musician_description");

    if (!artist && type !== "artist") {
        // "<title>X - song and lyrics by Artist | Spotify" / "X - Album by Artist | Spotify"
        const pageTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const byMatch = pageTitle && decodeEntities(pageTitle[1]).match(/\bby (.+?) \| Spotify/i);
        if (byMatch) artist = byMatch[1].trim();
    }

    if (!artist && type !== "artist") {
        // og:description starts with the artist: "Artist · Song · 1987"
        const description = getMeta(html, "og:description");
        if (description && description.includes(" · ")) artist = description.split(" · ")[0].trim();
    }

    return { type, title, artist: type === "artist" ? title : artist };
}

/**
 * Fetches and parses a Spotify page
 * @param {string} spotifyUrl - Spotify URL (short links are followed)
 * @returns {Promise<{ type: string|null, title: string|null, artist: string|null }>}
 */
async function getSpotifyMetadata(spotifyUrl) {
    const res = await fetchOk(spotifyUrl);
    return parseSpotifyPage(await res.text(), res.url || spotifyUrl);
}

/**
 * Searches the iTunes API and returns the Apple Music URL
 * @param {string} type - track | album | artist
 * @param {string} title - Track/album/artist name
 * @param {string|null} artist - Artist name (null for artist lookups)
 * @returns {Promise<{ url: string, title: string, artist: string }|null>}
 */
async function searchItunes(type, title, artist) {
    const { entity, urlField, nameField } = ITUNES_ENTITIES[type];
    const term = type === "artist" ? title : `${artist} ${title}`;
    const url =
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
        `&media=music&entity=${entity}&limit=1&country=${ITUNES_COUNTRY}`;

    logger.info(`iTunes search (${entity}):`, term);
    const data = await (await fetchOk(url)).json();
    const result = data.results?.[0];
    if (!result?.[urlField]) return null;

    return {
        url: result[urlField],
        title: result[nameField],
        artist: result.artistName,
    };
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

        const { type, title, artist } = await getSpotifyMetadata(spotifyUrl);
        logger.info(`Spotify metadata: type=${type}, title=${title}, artist=${artist}`);

        if (type === "playlist") {
            // Playlists are user-made and have no Apple Music equivalent
            await react("🤷");
            return true;
        }

        if (!type || !title || (type !== "artist" && !artist)) {
            throw new Error("couldn't read the song info from Spotify");
        }

        const found = await searchItunes(type, title, artist);

        if (!found) {
            await react("⚠️");
            await sendWithBotReaction(sock, chatId, {
                text: "⚠️ This wasn't found on Apple Music.",
            });
            return true;
        }

        const reply =
            type === "artist"
                ? `🎤 *${found.artist}*\n\n🍎 ${found.url}`
                : `🎵 *${found.title}* — _${found.artist}_\n\n🍎 ${found.url}`;

        await sendWithBotReaction(sock, chatId, { text: reply });
        await react("🍎");

        logger.info("Apple Music link sent:", found.url);
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
    // exported for testing
    parseSpotifyPage,
};
