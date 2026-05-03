/**
 * Video download and encoding functionality
 * @module video
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const {
    DOWNLOADS_DIR,
    YTDLP_PATH,
    COOKIES_PATH,
    MAX_VIDEO_SIZE,
    CQ_START,
    CQ_MAX,
    CQ_STEP,
    DOWNLOAD_TIMEOUT,
    ENCODE_TIMEOUT,
    PROBE_TIMEOUT,
} = require("./config");
const {
    execFileAsync,
    needsCookies,
    safeUnlink,
    scheduleCleanup,
    schedulePatternCleanup,
    hasNvencSupport,
    logger,
} = require("./utils");

// Downloads directory is created on first use (async)
let downloadsReady = false;

/**
 * Ensures the downloads directory exists (async, called on first use)
 */
async function ensureDownloadsDir() {
    if (downloadsReady) return;
    try {
        await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== "EEXIST") throw err;
    }
    downloadsReady = true;
}

/**
 * Downloads a video from a URL and encodes it for WhatsApp compatibility
 *
 * @param {string} url - Video URL to download
 * @param {boolean} [keepFile=false] - Whether to keep the file after sending
 * @returns {Promise<{buffer: Buffer, title: string}>} Video buffer and title
 * @throws {Error} If download or encoding fails
 */
async function downloadVideo(url, keepFile = false) {
    await ensureDownloadsDir();
    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOADS_DIR, `video_${timestamp}.%(ext)s`);

    try {
        // Fetch the video title first
        let title = "";
        try {
            const titleArgs = ["--print", "title", "--no-playlist", "--no-warnings"];
            if (needsCookies(url)) {
                titleArgs.push("--cookies", COOKIES_PATH);
            }
            titleArgs.push(url);
            const { stdout } = await execFileAsync(YTDLP_PATH, titleArgs, { timeout: DOWNLOAD_TIMEOUT });
            title = stdout.trim();
            logger.info("Video title:", title);
        } catch (err) {
            logger.warn("Could not fetch video title:", err.message);
        }

        // Build the command arguments
        const args = [
            "-f",
            "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
            "-o",
            outputTemplate,
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--no-warnings",
        ];

        // Add cookies for sites that require authentication
        if (needsCookies(url)) {
            args.push("--cookies", COOKIES_PATH);
        }

        args.push(url);

        logger.info("Running yt-dlp with args:", args.join(" "));
        await execFileAsync(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT });

        // Find the downloaded file
        const files = await fsPromises.readdir(DOWNLOADS_DIR);
        const downloadedFile = files.find((f) => f.startsWith(`video_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Download failed - file not found");
        }

        let filePath = path.join(DOWNLOADS_DIR, downloadedFile);
        logger.info("Downloaded file:", filePath);

        // Log video codec for debugging
        await logVideoCodec(filePath);

        // Re-encode for WhatsApp compatibility
        filePath = await reencodeForWhatsApp(filePath, timestamp);

        // Read the final file asynchronously to avoid blocking
        const buffer = await fsPromises.readFile(filePath);

        // Schedule cleanup if not keeping file
        if (!keepFile) {
            scheduleCleanup(filePath);
        } else {
            logger.info("Keeping file:", filePath);
        }

        return { buffer, title };
    } catch (error) {
        // Clean up any partial downloads
        schedulePatternCleanup(DOWNLOADS_DIR, `video_${timestamp}`);
        throw error;
    }
}

/**
 * Logs the video codec of a file for debugging
 * @param {string} filePath - Path to video file
 */
async function logVideoCodec(filePath) {
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                filePath,
            ],
            { timeout: PROBE_TIMEOUT }
        );

        const videoCodec = stdout.trim().toLowerCase();
        logger.info("Source video codec:", videoCodec);
    } catch (probeError) {
        logger.warn("Could not probe video codec:", probeError.message);
    }
}

/**
 * Checks if a file has an audio stream
 * @param {string} filePath - Path to media file
 * @returns {Promise<boolean>} True if audio stream exists
 */
async function hasAudioStream(filePath) {
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "csv=p=0",
                filePath,
            ],
            { timeout: PROBE_TIMEOUT }
        );
        return stdout.trim().length > 0;
    } catch (error) {
        logger.warn("Could not probe for audio stream:", error.message);
        return false; // Assume no audio on error to be safe
    }
}

/**
 * Shared encoding loop that handles quality iteration and size checking
 *
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path for output video
 * @param {boolean} useNvenc - Whether to use NVENC hardware encoding
 * @param {boolean} hasAudio - Whether the input file has audio
 * @returns {Promise<{success: boolean, path: string, error?: Error}>} Encoding result
 */
async function encodeWithQualityLoop(inputPath, outputPath, useNvenc, hasAudio) {
    let currentQuality = CQ_START;
    let encodeSuccess = false;

    while (currentQuality <= CQ_MAX) {
        try {
            const qualityLabel = useNvenc ? "CQ" : "CRF";
            logger.info(`Encoding with ${qualityLabel} ${currentQuality}...`);

            const args = buildEncoderArgs(useNvenc, inputPath, outputPath, currentQuality, hasAudio);
            await execFileAsync("ffmpeg", args, { timeout: ENCODE_TIMEOUT });

            // Check file size asynchronously
            const stats = await fsPromises.stat(outputPath);
            const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            logger.info(`Encoded file size: ${fileSizeMB} MB`);

            if (stats.size <= MAX_VIDEO_SIZE) {
                encodeSuccess = true;
                break;
            }

            // File too large, try again with lower quality
            logger.warn(`File exceeds 64 MB limit, re-encoding with lower quality...`);
            currentQuality += CQ_STEP;
        } catch (err) {
            logger.error("Encoding failed:", err.message);
            return { success: false, path: outputPath, error: err };
        }
    }

    return { success: encodeSuccess, path: outputPath };
}

/**
 * Re-encodes a video to H.264/AAC for WhatsApp compatibility
 * Uses NVENC if available, falls back to software encoding
 *
 * @param {string} inputPath - Path to input video
 * @param {number} timestamp - Timestamp for output filename
 * @returns {Promise<string>} Path to re-encoded video
 */
async function reencodeForWhatsApp(inputPath, timestamp) {
    const reencodedPath = path.join(DOWNLOADS_DIR, `video_${timestamp}_compat.mp4`);

    // Check for NVENC support (cached after first call)
    const useNvenc = await hasNvencSupport();
    logger.info(
        useNvenc
            ? "Re-encoding using NVIDIA NVENC (GPU)..."
            : "Re-encoding using libx264 (CPU)..."
    );

    // Check streams
    const hasAudio = await hasAudioStream(inputPath);
    if (!hasAudio) {
        logger.info("No audio stream detected. Encoding video only.");
    }

    // Try encoding with detected encoder
    let result = await encodeWithQualityLoop(inputPath, reencodedPath, useNvenc, hasAudio);

    // If NVENC failed, try software encoding as fallback
    if (!result.success && result.error && useNvenc) {
        logger.info("NVENC failed, falling back to software encoding...");
        result = await encodeWithQualityLoop(inputPath, reencodedPath, false, hasAudio);
    }

    // Handle result
    if (result.success) {
        await safeUnlink(inputPath);
        logger.info("Re-encoding complete:", reencodedPath);
        return reencodedPath;
    }

    // Check if output exists even if quality loop didn't converge
    try {
        await fsPromises.access(reencodedPath);
        await safeUnlink(inputPath);
        logger.warn("Could not get file under 64 MB, using best effort:", reencodedPath);
        return reencodedPath;
    } catch {
        logger.error("Re-encoding failed completely, using original file");
        return inputPath;
    }
}

/**
 * Builds FFmpeg encoder arguments based on encoder type
 *
 * @param {boolean} useNvenc - Whether to use NVENC
 * @param {string} inputPath - Input file path
 * @param {string} outputPath - Output file path
 * @param {number} quality - Quality value (CQ for NVENC, CRF for libx264)
 * @param {boolean} hasAudio - Whether to include audio args
 * @returns {string[]} FFmpeg arguments
 */
function buildEncoderArgs(useNvenc, inputPath, outputPath, quality, hasAudio) {
    const baseArgs = ["-i", inputPath];
    const audioArgs = hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : [];
    const outputArgs = ["-movflags", "+faststart", "-y", outputPath];

    if (useNvenc) {
        return [
            "-hwaccel", "cuda",
            ...baseArgs,
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", quality.toString(),
            "-profile:v", "high",
            "-level", "4.0",
            ...audioArgs,
            ...outputArgs,
        ];
    } else {
        return [
            ...baseArgs,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", quality.toString(),
            "-profile:v", "high",
            "-level", "4.0",
            ...audioArgs,
            ...outputArgs,
        ];
    }
}

/**
 * Downloads audio from a URL and converts it to MP3
 *
 * @param {string} url - Video/audio URL to download
 * @param {boolean} [keepFile=false] - Whether to keep the file after sending
 * @returns {Promise<Buffer>} Audio buffer ready to send
 * @throws {Error} If download or conversion fails
 */
async function downloadAudio(url, keepFile = false) {
    await ensureDownloadsDir();
    const timestamp = Date.now();
    const outputPath = path.join(DOWNLOADS_DIR, `audio_${timestamp}.mp3`);

    try {
        // Build the command arguments for audio extraction
        const args = [
            "-f", "bestaudio/best",
            "-x",                           // Extract audio
            "--audio-format", "mp3",        // Convert to MP3
            "--audio-quality", "0",         // Best quality (VBR ~245kbps)
            "-o", outputPath,
            "--no-playlist",
            "--no-warnings",
        ];

        // Add cookies for sites that require authentication
        if (needsCookies(url)) {
            args.push("--cookies", COOKIES_PATH);
        }

        args.push(url);

        logger.info("Running yt-dlp for audio with args:", args.join(" "));
        await execFileAsync(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT });

        // Verify the file was created
        try {
            await fsPromises.access(outputPath);
        } catch {
            throw new Error("Audio download failed - file not found");
        }

        logger.info("Downloaded audio:", outputPath);

        // Read the file asynchronously
        const buffer = await fsPromises.readFile(outputPath);

        // Schedule cleanup if not keeping file
        if (!keepFile) {
            scheduleCleanup(outputPath);
        } else {
            logger.info("Keeping file:", outputPath);
        }

        return buffer;
    } catch (error) {
        // Clean up any partial downloads
        schedulePatternCleanup(DOWNLOADS_DIR, `audio_${timestamp}`);
        throw error;
    }
}

/**
 * Downloads a video from a URL specifically for sticker creation (optimized for size)
 *
 * @param {string} url - Video URL to download
 * @returns {Promise<Buffer>} Video buffer ready for sticker creation
 * @throws {Error} If download fails
 */
async function downloadMediaForSticker(url) {
    await ensureDownloadsDir();
    const timestamp = Date.now();
    // Use mp4 as container but we don't strictly care, just want a video file
    const outputTemplate = path.join(DOWNLOADS_DIR, `sticker_src_${timestamp}.%(ext)s`);

    try {
        // Args optimized for stickers:
        // - Limit height to 512px (WhatsApp sticker limit)
        // - No audio needed
        const args = [
            "-f",
            "bestvideo[height<=512]+bestaudio/best[height<=512]/best",
            "-o",
            outputTemplate,
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--no-warnings",
        ];

        // Add cookies for sites that require authentication
        if (needsCookies(url)) {
            args.push("--cookies", COOKIES_PATH);
        }

        args.push(url);

        logger.info("Running yt-dlp for sticker source:", args.join(" "));
        await execFileAsync(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT });

        const files = await fsPromises.readdir(DOWNLOADS_DIR);
        const downloadedFile = files.find((f) => f.startsWith(`sticker_src_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Download failed - file not found");
        }

        const filePath = path.join(DOWNLOADS_DIR, downloadedFile);
        logger.info("Downloaded sticker source:", filePath);

        const buffer = await fsPromises.readFile(filePath);

        // Always cleanup sticker source files immediately after reading
        scheduleCleanup(filePath, 1000);

        return buffer;
    } catch (error) {
        schedulePatternCleanup(DOWNLOADS_DIR, `sticker_src_${timestamp}`);
        throw error;
    }
}

/**
 * Downloads a video in full resolution (up to 4K) and re-encodes to H.264 if needed.
 * Mirrors the pipeline from 00__VIDEO.bat — no file size cap since the result
 * is sent as a document rather than an inline video.
 *
 * @param {string} url - Video URL to download
 * @param {boolean} [keepFile=false] - Whether to keep the file after sending
 * @returns {Promise<{buffer: Buffer, title: string, fileName: string}>} Video buffer, title, and filename
 * @throws {Error} If download or encoding fails
 */
async function downloadVideoFullRes(url, keepFile = false) {
    await ensureDownloadsDir();
    const timestamp = Date.now();
    const outputTemplate = path.join(DOWNLOADS_DIR, `fullres_${timestamp}.%(ext)s`);

    try {
        // Fetch the video title first
        let title = "";
        try {
            const titleArgs = ["--print", "title", "--no-playlist", "--no-warnings"];
            if (needsCookies(url)) {
                titleArgs.push("--cookies", COOKIES_PATH);
            }
            titleArgs.push(url);
            const { stdout } = await execFileAsync(YTDLP_PATH, titleArgs, { timeout: DOWNLOAD_TIMEOUT });
            title = stdout.trim();
            logger.info("Video title (full res):", title);
        } catch (err) {
            logger.warn("Could not fetch video title:", err.message);
        }

        // Build yt-dlp args — same format string as 00__VIDEO.bat
        const args = [
            "-f",
            "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
            "-o",
            outputTemplate,
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--no-warnings",
            "--force-overwrites",
        ];

        // YouTube client bypass (same as bat file)
        args.push("--extractor-args", "youtube:player_client=default,web_embedded");

        // Add cookies for sites that require authentication
        if (needsCookies(url)) {
            args.push("--cookies", COOKIES_PATH);
        }

        args.push(url);

        logger.info("Running yt-dlp (full res) with args:", args.join(" "));
        await execFileAsync(YTDLP_PATH, args, { timeout: DOWNLOAD_TIMEOUT });

        // Find the downloaded file
        const files = await fsPromises.readdir(DOWNLOADS_DIR);
        const downloadedFile = files.find((f) => f.startsWith(`fullres_${timestamp}`));

        if (!downloadedFile) {
            throw new Error("Full-res download failed - file not found");
        }

        let filePath = path.join(DOWNLOADS_DIR, downloadedFile);
        logger.info("Downloaded full-res file:", filePath);

        // Check codec — only re-encode if NOT already H.264 (same logic as bat file)
        filePath = await reencodeFullRes(filePath, timestamp);

        // Build a clean filename from the title
        const safeTitle = title
            ? title.replace(/[<>:"\/\\|?*]/g, "").trim()
            : `video_${timestamp}`;
        const fileName = `${safeTitle}.mp4`;

        // Read the final file
        const buffer = await fsPromises.readFile(filePath);

        // Schedule cleanup if not keeping file
        if (!keepFile) {
            scheduleCleanup(filePath);
        } else {
            logger.info("Keeping full-res file:", filePath);
        }

        return { buffer, title, fileName };
    } catch (error) {
        // Clean up any partial downloads
        schedulePatternCleanup(DOWNLOADS_DIR, `fullres_${timestamp}`);
        throw error;
    }
}

/**
 * Re-encodes a full-res video to H.264 only if needed (codec check).
 * Uses the same encoding settings as 00__VIDEO.bat (CQ 23, high profile, 192k AAC).
 * No file-size cap — the result is sent as a document.
 *
 * @param {string} inputPath - Path to input video
 * @param {number} timestamp - Timestamp for output filename
 * @returns {Promise<string>} Path to the (possibly re-encoded) video
 */
async function reencodeFullRes(inputPath, timestamp) {
    // Probe the video codec
    let codec = "unknown";
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "default=noprint_wrappers=1:nokey=1",
                inputPath,
            ],
            { timeout: PROBE_TIMEOUT }
        );
        codec = stdout.trim().toLowerCase();
        logger.info("Full-res video codec:", codec);
    } catch (probeError) {
        logger.warn("Could not probe full-res codec:", probeError.message);
    }

    // If already H.264 — no re-encode needed
    if (codec === "h264") {
        logger.info("Full-res video is already H.264, skipping re-encode.");
        return inputPath;
    }

    // Re-encode to H.264 (mirrors bat file ffmpeg settings)
    const reencodedPath = path.join(DOWNLOADS_DIR, `fullres_${timestamp}_h264.mp4`);
    const useNvenc = await hasNvencSupport();

    logger.info(
        useNvenc
            ? "Full-res re-encoding using NVIDIA NVENC (GPU)..."
            : "Full-res re-encoding using libx264 (CPU)..."
    );

    const hasAudio = await hasAudioStream(inputPath);
    const audioArgs = hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : [];

    let encodeArgs;
    if (useNvenc) {
        encodeArgs = [
            "-hwaccel", "cuda",
            "-i", inputPath,
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", "23",
            "-profile:v", "high",
            ...audioArgs,
            "-movflags", "+faststart",
            "-y", reencodedPath,
        ];
    } else {
        encodeArgs = [
            "-i", inputPath,
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "23",
            "-profile:v", "high",
            ...audioArgs,
            "-movflags", "+faststart",
            "-y", reencodedPath,
        ];
    }

    try {
        await execFileAsync("ffmpeg", encodeArgs, { timeout: ENCODE_TIMEOUT });

        // Verify output exists
        await fsPromises.access(reencodedPath);
        await safeUnlink(inputPath);

        const stats = await fsPromises.stat(reencodedPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        logger.info(`Full-res re-encode complete: ${reencodedPath} (${sizeMB} MB)`);

        return reencodedPath;
    } catch (err) {
        logger.error("Full-res re-encode failed:", err.message);
        // If NVENC failed, try software fallback
        if (useNvenc) {
            logger.info("NVENC failed for full-res, falling back to software encoding...");
            const swArgs = [
                "-i", inputPath,
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "23",
                "-profile:v", "high",
                ...audioArgs,
                "-movflags", "+faststart",
                "-y", reencodedPath,
            ];
            try {
                await execFileAsync("ffmpeg", swArgs, { timeout: ENCODE_TIMEOUT });
                await fsPromises.access(reencodedPath);
                await safeUnlink(inputPath);
                return reencodedPath;
            } catch (swErr) {
                logger.error("Software fallback also failed:", swErr.message);
            }
        }
        // Return original if all encoding attempts fail
        logger.warn("Using original file (re-encode failed)");
        return inputPath;
    }
}

module.exports = {
    downloadVideo,
    downloadAudio,
    downloadMediaForSticker,
    downloadVideoFullRes,
};
