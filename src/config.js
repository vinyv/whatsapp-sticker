/**
 * Configuration constants for the WhatsApp Sticker Bot
 * Environment variables can override defaults where noted.
 * @module config
 */

require("dotenv/config");
const path = require("path");

/**
 * Helper to get env var with default value
 * @param {string} key - Environment variable name
 * @param {*} defaultValue - Default if not set
 * @returns {*} Value from env or default
 */
function env(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined) return defaultValue;

  // Parse numbers
  if (typeof defaultValue === "number") {
    const parsed = Number(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  return value;
}

// === Sticker Metadata (env: STICKER_PACK, STICKER_AUTHOR) ===

/** @type {string} Sticker pack name shown in WhatsApp */
const STICKER_PACK = env("STICKER_PACK", "automatizado por");

/** @type {string} Sticker author name shown in WhatsApp */
const STICKER_AUTHOR = env("STICKER_AUTHOR", "vinycius.me");

// === File Size Limits ===

/** @type {number} Maximum sticker size for images in bytes (100KB) */
const MAX_STICKER_SIZE_IMAGE = 100000;

/** @type {number} Maximum sticker size for videos in bytes (500KB - WhatsApp limit) */
const MAX_STICKER_SIZE_VIDEO = 500000;

/** @type {number} Maximum dimension (width/height) for sticker videos in pixels */
const STICKER_MAX_DIMENSION = 512;

/** @type {number} Target framerate for sticker videos (lower = smaller file, smoother playback) */
const STICKER_TARGET_FPS = 15;

/** @type {number} Maximum duration for sticker videos in seconds */
const STICKER_MAX_DURATION = env("STICKER_MAX_DURATION", 8);

/** @type {number} Maximum video file size for WhatsApp in bytes (64MB) */
const MAX_VIDEO_SIZE = 64 * 1024 * 1024;

// === Quality Settings ===

/** @type {number} Starting quality for sticker compression (1-100) */
const QUALITY_START = env("QUALITY_START", 30);

/** @type {number} Minimum quality for sticker compression (1-100) */
const QUALITY_MIN = env("QUALITY_MIN", 10);

/** @type {number} Quality reduction step per iteration */
const QUALITY_STEP = 15;

/** @type {number} Starting CQ value for video encoding (lower = better quality) */
const CQ_START = 23;

/** @type {number} Maximum CQ value for video encoding (lower quality limit) */
const CQ_MAX = 35;

/** @type {number} CQ increase step when file is too large */
const CQ_STEP = 5;

// === Timeouts (in milliseconds) ===

/** @type {number} Timeout for video downloads (5 minutes) */
const DOWNLOAD_TIMEOUT = env("DOWNLOAD_TIMEOUT", 300000);

/** @type {number} Timeout for video encoding (5 minutes) */
const ENCODE_TIMEOUT = env("ENCODE_TIMEOUT", 300000);

/** @type {number} Timeout for ffprobe operations (30 seconds) */
const PROBE_TIMEOUT = 30000;

/** @type {number} Delay before cleaning up temporary files (5 seconds) */
const CLEANUP_DELAY = 5000;

// === Rate Limiting ===

/** @type {number} Minimum time between downloads per chat in ms (10 seconds) */
const RATE_LIMIT_MS = env("RATE_LIMIT_MS", 10000);

/** @type {number} Maximum concurrent downloads globally */
const MAX_CONCURRENT_DOWNLOADS = env("MAX_CONCURRENT_DOWNLOADS", 3);

// === Paths ===

/** @type {string} Root directory of the project */
const ROOT_DIR = path.join(__dirname, "..");

/** @type {string} Directory for downloaded files */
const DOWNLOADS_DIR = env("DOWNLOADS_DIR", path.join(ROOT_DIR, "downloads"));

/** @type {string} Path to yt-dlp executable */
const YTDLP_PATH = env("YTDLP_PATH", path.join(ROOT_DIR, "yt-dlp.exe"));

/** @type {string} Path to cookies file for yt-dlp */
const COOKIES_PATH = env("COOKIES_PATH", path.join(ROOT_DIR, "cookies.txt"));

/** @type {string} Path to authentication state directory */
const AUTH_DIR = env("AUTH_DIR", path.join(ROOT_DIR, ".wwebjs_auth"));

/** @type {string} Path to system tray icon */
const ICON_PATH = env("ICON_PATH", path.join(ROOT_DIR, "icon.ico"));

// === Book Club ===

/** @type {string} WhatsApp group ID for the book club (commands only work here) */
const BOOKCLUB_GROUP_ID = env("BOOKCLUB_GROUP_ID", "120363425613997820@g.us");

/** @type {string} Path to book club data JSON file */
const BOOKCLUB_DATA_PATH = env("BOOKCLUB_DATA_PATH", path.join(ROOT_DIR, "data", "bookclub.json"));

/** @type {string} Google Books API key (from .env) */
const GOOGLE_BOOKS_API_KEY = env("GOOGLE_BOOKS_API_KEY", "");

// === Notion ===

/** @type {string} Notion integration API key (from .env) */
const NOTION_API_KEY = env("NOTION_API_KEY", "");

/** @type {string} Notion database ID for book club (from .env) */
const NOTION_DB_ID = env("NOTION_DB_ID", "");

// === Local Worker (cloud → local PC bridge) ===

/** @type {string} URL of the local worker API (Cloudflare Tunnel or direct) */
const LOCAL_WORKER_URL = env("LOCAL_WORKER_URL", "");

/** @type {string} Shared secret for authenticating worker API requests */
const LOCAL_WORKER_SECRET = env("LOCAL_WORKER_SECRET", "");

module.exports = {
  // Sticker metadata
  STICKER_PACK,
  STICKER_AUTHOR,

  // File size limits
  MAX_STICKER_SIZE_IMAGE,
  MAX_STICKER_SIZE_VIDEO,
  MAX_VIDEO_SIZE,

  // Sticker video preprocessing
  STICKER_MAX_DIMENSION,
  STICKER_TARGET_FPS,
  STICKER_MAX_DURATION,

  // Quality settings
  QUALITY_START,
  QUALITY_MIN,
  QUALITY_STEP,
  CQ_START,
  CQ_MAX,
  CQ_STEP,

  // Timeouts
  DOWNLOAD_TIMEOUT,
  ENCODE_TIMEOUT,
  PROBE_TIMEOUT,
  CLEANUP_DELAY,

  // Rate limiting
  RATE_LIMIT_MS,
  MAX_CONCURRENT_DOWNLOADS,

  // Paths
  ROOT_DIR,
  DOWNLOADS_DIR,
  YTDLP_PATH,
  COOKIES_PATH,
  AUTH_DIR,
  ICON_PATH,

  // Book Club
  BOOKCLUB_GROUP_ID,
  BOOKCLUB_DATA_PATH,
  GOOGLE_BOOKS_API_KEY,

  // Notion
  NOTION_API_KEY,
  NOTION_DB_ID,

  // Local Worker
  LOCAL_WORKER_URL,
  LOCAL_WORKER_SECRET,
};
