/**
 * Video download and encoding functionality
 * @module video
 */

const fsPromises = require("fs").promises;
const path = require("path");
const { randomUUID } = require("crypto");
const {
    DOWNLOADS_DIR,
    MAX_VIDEO_SIZE,
    CQ_START,
    CQ_MAX,
    CQ_STEP,
    ENCODE_TIMEOUT,
    PROBE_TIMEOUT,
    STICKER_MAX_DURATION,
} = require("./config");
const {
    execFileAsync,
    safeUnlink,
    scheduleCleanup,
    schedulePatternCleanup,
    hasNvencSupport,
    logger,
} = require("./utils");
const ytdlp = require("./ytdlp");

// Downloads directory is created on first use (async)
let downloadsReady = false;

/**
 * Ensures the downloads directory exists (async, called on first use)
 */
async function ensureDownloadsDir() {
    if (downloadsReady) return;
    await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true });
    downloadsReady = true;
}

/**
 * Creates a unique file prefix (timestamps alone collide on concurrent jobs)
 * @param {string} kind - Prefix such as "video" or "audio"
 * @returns {string}
 */
function newJobId(kind) {
    return `${kind}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/**
 * Finds the file yt-dlp produced for a job prefix
 * @param {string} prefix - Job prefix used in the output template
 * @returns {Promise<string>} Absolute path to the downloaded file
 */
async function findDownloaded(prefix) {
    const files = await fsPromises.readdir(DOWNLOADS_DIR);
    // Ignore leftovers from interrupted downloads/merges
    const file = files.find(
        (f) => f.startsWith(prefix) && !f.endsWith(".part") && !f.includes(".temp.") && !/\.f\d+\./.test(f)
    );
    if (!file) {
        throw new Error("Download failed - file not found");
    }
    return path.join(DOWNLOADS_DIR, file);
}

/**
 * Immediately deletes all files for a job prefix (e.g. before a retry)
 * @param {string} prefix - Job prefix
 */
async function removeByPrefix(prefix) {
    const files = await fsPromises.readdir(DOWNLOADS_DIR).catch(() => []);
    await Promise.all(files.filter((f) => f.startsWith(prefix)).map((f) => safeUnlink(path.join(DOWNLOADS_DIR, f))));
}

/**
 * Turns a title into a safe filename
 * @param {string} title - Media title
 * @param {string} fallback - Name to use when the title is empty
 * @param {string} ext - File extension without the dot
 * @returns {string}
 */
function toFileName(title, fallback, ext) {
    const safe = (title || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().slice(0, 150);
    return `${safe || fallback}.${ext}`;
}

/**
 * Probes the first video and audio stream of a file
 * @param {string} filePath - Path to media file
 * @returns {Promise<{vcodec: string|null, pixFmt: string|null, acodec: string|null}>}
 */
async function probeStreams(filePath) {
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v", "error",
                "-show_entries", "stream=codec_type,codec_name,pix_fmt",
                "-of", "json",
                filePath,
            ],
            { timeout: PROBE_TIMEOUT }
        );
        const streams = JSON.parse(stdout).streams || [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        return {
            vcodec: video?.codec_name?.toLowerCase() || null,
            pixFmt: video?.pix_fmt || null,
            acodec: audio?.codec_name?.toLowerCase() || null,
        };
    } catch (error) {
        logger.warn("Could not probe streams:", error.message);
        return { vcodec: null, pixFmt: null, acodec: null };
    }
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
    const id = newJobId("video");

    try {
        // Highest resolution up to 720p first; H.264/AAC only breaks ties at the same
        // resolution (so re-encoding can be skipped without giving up sharpness —
        // YouTube often only offers H.264 at 360p)
        const info = await ytdlp.downloadWithInfo(url, [
            "-f", "bv*[height<=720]+ba/b[height<=720]/b",
            "-S", "res:720,vcodec:h264,acodec:m4a",
            "--merge-output-format", "mp4",
            "-o", path.join(DOWNLOADS_DIR, `${id}.%(ext)s`),
        ]);
        const title = info.title || "";
        logger.info("Video title:", title);

        let filePath = await findDownloaded(id);
        logger.info("Downloaded file:", filePath);

        filePath = await reencodeForWhatsApp(filePath, id);

        const buffer = await fsPromises.readFile(filePath);

        if (!keepFile) {
            scheduleCleanup(filePath);
        } else {
            logger.info("Keeping file:", filePath);
        }

        return { buffer, title };
    } catch (error) {
        schedulePatternCleanup(DOWNLOADS_DIR, id);
        throw error;
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

            const args = buildEncoderArgs(useNvenc, inputPath, outputPath, currentQuality, hasAudio, "4.0");
            await execFileAsync("ffmpeg", args, { timeout: ENCODE_TIMEOUT });

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
 * Re-encodes a video to H.264/AAC for WhatsApp compatibility.
 * Skipped when the file is already H.264 8-bit + AAC and under the size limit.
 * Uses NVENC if available, falls back to software encoding.
 *
 * @param {string} inputPath - Path to input video
 * @param {string} id - Job prefix for the output filename
 * @returns {Promise<string>} Path to the final video
 */
async function reencodeForWhatsApp(inputPath, id) {
    const streams = await probeStreams(inputPath);
    const { size } = await fsPromises.stat(inputPath);
    const hasAudio = streams.acodec !== null;
    logger.info(`Source: video=${streams.vcodec} (${streams.pixFmt}), audio=${streams.acodec || "none"}`);

    const compatible =
        streams.vcodec === "h264" &&
        streams.pixFmt === "yuv420p" &&
        (!hasAudio || streams.acodec === "aac") &&
        size <= MAX_VIDEO_SIZE;

    if (compatible) {
        logger.info("Already WhatsApp-compatible, skipping re-encode.");
        return inputPath;
    }

    const reencodedPath = path.join(DOWNLOADS_DIR, `${id}_compat.mp4`);

    // Check for NVENC support (cached after first call)
    const useNvenc = await hasNvencSupport();
    logger.info(
        useNvenc
            ? "Re-encoding using NVIDIA NVENC (GPU)..."
            : "Re-encoding using libx264 (CPU)..."
    );

    let result = await encodeWithQualityLoop(inputPath, reencodedPath, useNvenc, hasAudio);

    // If NVENC failed, try software encoding as fallback
    if (!result.success && result.error && useNvenc) {
        logger.info("NVENC failed, falling back to software encoding...");
        result = await encodeWithQualityLoop(inputPath, reencodedPath, false, hasAudio);
    }

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
 * @param {string|null} [level=null] - H.264 level, or null to let the encoder pick
 * @returns {string[]} FFmpeg arguments
 */
function buildEncoderArgs(useNvenc, inputPath, outputPath, quality, hasAudio, level = null) {
    const audioArgs = hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"];
    const levelArgs = level ? ["-level", level] : [];
    // Force 8-bit 4:2:0: 10-bit/HDR sources would otherwise fail with the
    // "high" profile or produce files WhatsApp can't play
    const commonArgs = ["-pix_fmt", "yuv420p", "-profile:v", "high", ...levelArgs];
    const outputArgs = ["-movflags", "+faststart", "-y", outputPath];

    if (useNvenc) {
        return [
            "-hwaccel", "cuda",
            "-i", inputPath,
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-rc", "vbr",
            "-cq", quality.toString(),
            ...commonArgs,
            ...audioArgs,
            ...outputArgs,
        ];
    }
    return [
        "-i", inputPath,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", quality.toString(),
        ...commonArgs,
        ...audioArgs,
        ...outputArgs,
    ];
}

/**
 * Downloads audio from a URL and converts it to MP3
 *
 * @param {string} url - Video/audio URL to download
 * @param {boolean} [keepFile=false] - Whether to keep the file after sending
 * @returns {Promise<{buffer: Buffer, title: string, fileName: string}>} Audio buffer and metadata
 * @throws {Error} If download or conversion fails
 */
async function downloadAudio(url, keepFile = false) {
    await ensureDownloadsDir();
    const id = newJobId("audio");

    try {
        const info = await ytdlp.downloadWithInfo(url, [
            "-f", "bestaudio/best",
            "-x",                           // Extract audio
            "--audio-format", "mp3",        // Convert to MP3
            "--audio-quality", "0",         // Best quality (VBR ~245kbps)
            "--embed-metadata",             // Title/artist tags show up in players
            "-o", path.join(DOWNLOADS_DIR, `${id}.%(ext)s`),
        ]);
        const title = info.title || "";

        const outputPath = await findDownloaded(id);
        logger.info("Downloaded audio:", outputPath);

        const buffer = await fsPromises.readFile(outputPath);

        if (!keepFile) {
            scheduleCleanup(outputPath);
        } else {
            logger.info("Keeping file:", outputPath);
        }

        return { buffer, title, fileName: toFileName(title, id, "mp3") };
    } catch (error) {
        schedulePatternCleanup(DOWNLOADS_DIR, id);
        throw error;
    }
}

/**
 * Downloads a video from a URL specifically for sticker creation (optimized for size).
 * Only the first STICKER_MAX_DURATION seconds are fetched, without audio.
 *
 * @param {string} url - Video URL to download
 * @returns {Promise<Buffer>} Video buffer ready for sticker creation
 * @throws {Error} If download fails
 */
async function downloadMediaForSticker(url) {
    await ensureDownloadsDir();
    const id = newJobId("sticker_src");
    const args = [
        // Smallest stream that still covers 512px (stickers are 512x512)
        "-f", "bv*/b",
        "-S", "res:720,+size",
        "--merge-output-format", "mp4",
        "-o", path.join(DOWNLOADS_DIR, `${id}.%(ext)s`),
    ];

    try {
        try {
            await ytdlp.downloadWithInfo(url, [...args, "--download-sections", `*0-${STICKER_MAX_DURATION}`]);
        } catch (err) {
            // Some sites/formats can't be cut; fall back to the whole file
            logger.warn("Partial download failed, retrying full download:", err.message);
            await removeByPrefix(id);
            await ytdlp.downloadWithInfo(url, args);
        }

        const filePath = await findDownloaded(id);
        logger.info("Downloaded sticker source:", filePath);

        const buffer = await fsPromises.readFile(filePath);

        // Always cleanup sticker source files immediately after reading
        scheduleCleanup(filePath, 1000);

        return buffer;
    } catch (error) {
        schedulePatternCleanup(DOWNLOADS_DIR, id);
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
    const id = newJobId("fullres");

    try {
        const info = await ytdlp.downloadWithInfo(url, [
            "-f", "bv*[height<=2160]+ba/b[height<=2160]/b",
            "--merge-output-format", "mp4",
            "--force-overwrites",
            "--extractor-args", "youtube:player_client=default,web_embedded",
            "-o", path.join(DOWNLOADS_DIR, `${id}.%(ext)s`),
        ]);
        const title = info.title || "";
        logger.info("Video title (full res):", title);

        let filePath = await findDownloaded(id);
        logger.info("Downloaded full-res file:", filePath);

        filePath = await reencodeFullRes(filePath, id);

        const buffer = await fsPromises.readFile(filePath);

        if (!keepFile) {
            scheduleCleanup(filePath);
        } else {
            logger.info("Keeping full-res file:", filePath);
        }

        return { buffer, title, fileName: toFileName(title, id, "mp4") };
    } catch (error) {
        schedulePatternCleanup(DOWNLOADS_DIR, id);
        throw error;
    }
}

/**
 * Re-encodes a full-res video to H.264 only if needed (codec check).
 * Uses the same encoding settings as 00__VIDEO.bat (CQ 23, high profile, 192k AAC).
 * No file-size cap — the result is sent as a document.
 *
 * @param {string} inputPath - Path to input video
 * @param {string} id - Job prefix for the output filename
 * @returns {Promise<string>} Path to the (possibly re-encoded) video
 */
async function reencodeFullRes(inputPath, id) {
    const streams = await probeStreams(inputPath);
    logger.info("Full-res video codec:", streams.vcodec);

    if (streams.vcodec === "h264") {
        logger.info("Full-res video is already H.264, skipping re-encode.");
        return inputPath;
    }

    const reencodedPath = path.join(DOWNLOADS_DIR, `${id}_h264.mp4`);
    const hasAudio = streams.acodec !== null;
    const useNvenc = await hasNvencSupport();
    const encoders = useNvenc ? [true, false] : [false];

    for (const nvenc of encoders) {
        logger.info(`Full-res re-encoding using ${nvenc ? "NVIDIA NVENC (GPU)" : "libx264 (CPU)"}...`);
        try {
            const args = buildEncoderArgs(nvenc, inputPath, reencodedPath, CQ_START, hasAudio);
            await execFileAsync("ffmpeg", args, { timeout: ENCODE_TIMEOUT });
            const stats = await fsPromises.stat(reencodedPath);
            await safeUnlink(inputPath);
            logger.info(`Full-res re-encode complete: ${reencodedPath} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
            return reencodedPath;
        } catch (err) {
            logger.error("Full-res re-encode failed:", err.message);
        }
    }

    logger.warn("Using original file (re-encode failed)");
    return inputPath;
}

module.exports = {
    downloadVideo,
    downloadAudio,
    downloadMediaForSticker,
    downloadVideoFullRes,
};
