/**
 * Sticker creation functionality
 * @module sticker
 */

const fsPromises = require("fs").promises;
const path = require("path");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const { Image } = require("node-webpmux");
const {
    STICKER_PACK,
    STICKER_AUTHOR,
    MAX_STICKER_SIZE_IMAGE,
    MAX_STICKER_SIZE_VIDEO,
    QUALITY_START,
    QUALITY_MIN,
    QUALITY_STEP,
    STICKER_MAX_DIMENSION,
    STICKER_TARGET_FPS,
    STICKER_MAX_DURATION,
    DOWNLOADS_DIR,
    PROBE_TIMEOUT,
    ENCODE_TIMEOUT,
} = require("./config");
const { execFileAsync, safeUnlink, scheduleCleanup, logger } = require("./utils");

// --- Video sticker quality settings (for direct WebP encoding) ---
// FFmpeg libwebp q:v range: 0-100, higher = better quality but larger file
const WEBP_QUALITY_START = 70;
const WEBP_QUALITY_MIN = 20;
const WEBP_QUALITY_STEP = 10;

/**
 * Gets video metadata (width, height, duration, fps) using ffprobe
 * @param {string} filePath - Path to video file
 * @returns {Promise<{width: number, height: number, duration: number, fps: number}>}
 */
async function getVideoMetadata(filePath) {
    try {
        const { stdout } = await execFileAsync(
            "ffprobe",
            [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate,duration",
                "-show_entries", "format=duration",
                "-of", "json",
                filePath,
            ],
            { timeout: PROBE_TIMEOUT }
        );

        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] || {};
        const format = data.format || {};

        // Parse framerate (can be "30/1" or "29.97")
        let fps = 30;
        if (stream.r_frame_rate) {
            const parts = stream.r_frame_rate.split("/");
            if (parts.length === 2) {
                fps = parseInt(parts[0]) / parseInt(parts[1]);
            } else {
                fps = parseFloat(stream.r_frame_rate);
            }
        }

        // Duration from stream or format
        const duration = parseFloat(stream.duration || format.duration || 10);

        return {
            width: stream.width || 512,
            height: stream.height || 512,
            duration: duration,
            fps: fps,
        };
    } catch (error) {
        logger.warn("Could not get video metadata:", error.message);
        return { width: 512, height: 512, duration: 10, fps: 30 };
    }
}

/**
 * Builds the EXIF metadata buffer for a WhatsApp sticker.
 * This is the same format that wa-sticker-formatter uses internally.
 *
 * @param {string} pack - Sticker pack name
 * @param {string} author - Sticker author name
 * @returns {Buffer} EXIF buffer ready to inject into a WebP file
 */
function buildStickerExif(pack, author) {
    const data = JSON.stringify({
        "sticker-pack-id": `sticker_${Date.now()}`,
        "sticker-pack-name": pack || "",
        "sticker-pack-publisher": author || "",
        "emojis": [],
    });

    const exif = Buffer.concat([
        Buffer.from([
            0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
            0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
        ]),
        Buffer.from(data, "utf-8"),
    ]);

    // Write the data length at offset 14 (4 bytes, little-endian)
    exif.writeUIntLE(Buffer.byteLength(data, "utf-8"), 14, 4);
    return exif;
}

/**
 * Injects sticker EXIF metadata into a WebP buffer using node-webpmux.
 *
 * @param {Buffer} webpBuffer - Raw animated WebP buffer
 * @param {string} pack - Sticker pack name
 * @param {string} author - Sticker author name
 * @returns {Promise<Buffer>} WebP buffer with EXIF metadata
 */
async function injectStickerMetadata(webpBuffer, pack, author) {
    const img = new Image();
    await img.load(webpBuffer);
    img.exif = buildStickerExif(pack, author);
    return await img.save(null);
}

/**
 * Converts a video buffer directly to an animated WebP sticker using FFmpeg's
 * libwebp codec. This bypasses wa-sticker-formatter's broken video→GIF→WebP
 * pipeline which causes severe color banding artifacts (GIF is limited to
 * 256 colors).
 *
 * The function handles all sticker requirements:
 * - Scales to fit within 512×512 (preserving aspect ratio)
 * - Pads to exactly 512×512 with transparent background
 * - Reduces FPS to target for smaller file size
 * - Trims duration to max allowed
 * - Iterates quality until file fits within WhatsApp's size limit
 * - Injects EXIF metadata for sticker pack/author info
 *
 * @param {Buffer} buffer - Input video buffer
 * @returns {Promise<Buffer>} Animated WebP sticker buffer with metadata
 */
async function createVideoSticker(buffer) {
    const timestamp = Date.now();
    const inputPath = path.join(DOWNLOADS_DIR, `sticker_input_${timestamp}.mp4`);
    const preprocessedPath = path.join(DOWNLOADS_DIR, `sticker_pre_${timestamp}.mp4`);

    try {
        // Ensure downloads directory exists
        await fsPromises.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => { });

        // Write buffer to temp file
        await fsPromises.writeFile(inputPath, buffer);

        // Get input video metadata
        const meta = await getVideoMetadata(inputPath);
        logger.info(`Input video: ${meta.width}x${meta.height}, ${meta.duration.toFixed(2)}s, ${meta.fps.toFixed(1)}fps`);

        // --- Phase 1: Preprocess to a small intermediate MP4 ---
        // This runs once and produces a tiny file that the quality loop
        // can iterate on quickly (instead of re-processing the original
        // large video on every quality attempt).
        // Phase 1 only scales and reduces fps — NO padding here.
        // H.264/MP4 doesn't support transparency, so padding with
        // a transparent color would produce black bars.
        const preFilters = [
            `fps=${STICKER_TARGET_FPS}`,
            `scale=${STICKER_MAX_DIMENSION}:${STICKER_MAX_DIMENSION}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        ].join(",");

        const preArgs = ["-i", inputPath];

        // Trim duration if needed
        if (meta.duration > STICKER_MAX_DURATION) {
            preArgs.push("-t", STICKER_MAX_DURATION.toString());
        }

        preArgs.push(
            "-vf", preFilters,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "18",         // Keep high quality for the intermediate
            "-pix_fmt", "yuv420p",
            "-an",
            "-y",
            preprocessedPath,
        );

        logger.info("Preprocessing video for sticker...");
        await execFileAsync("ffmpeg", preArgs, { timeout: ENCODE_TIMEOUT });

        // Done with the original input
        await safeUnlink(inputPath);

        // --- Phase 2: Convert preprocessed MP4 → animated WebP ---
        // Iterate quality on the small preprocessed file (fast).
        let quality = WEBP_QUALITY_START;
        let stickerBuffer;

        while (quality >= WEBP_QUALITY_MIN) {
            const outputPath = path.join(DOWNLOADS_DIR, `sticker_webp_${timestamp}_q${quality}.webp`);

            try {
                // The preprocessed MP4 is yuv420p (no alpha). We must add
                // an alpha channel BEFORE padding, otherwise the "transparent"
                // pad color renders as black.
                const vf = [
                    `format=yuva420p`,
                    `pad=${STICKER_MAX_DIMENSION}:${STICKER_MAX_DIMENSION}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
                ].join(",");

                const args = [
                    "-i", preprocessedPath,
                    "-vf", vf,
                    "-vcodec", "libwebp",
                    "-lossless", "0",
                    "-compression_level", "3",
                    "-q:v", quality.toString(),
                    "-loop", "0",
                    "-an",
                    "-pix_fmt", "yuva420p",
                    "-vsync", "0",
                    "-y",
                    outputPath,
                ];

                logger.info(`Encoding video sticker (quality ${quality})...`);
                await execFileAsync("ffmpeg", args, { timeout: ENCODE_TIMEOUT });

                // Read the WebP output
                const webpBuffer = await fsPromises.readFile(outputPath);
                scheduleCleanup(outputPath, 1000);

                logger.info(`Video sticker quality ${quality}: ${(webpBuffer.length / 1024).toFixed(1)}KB`);

                // Inject sticker metadata (pack name, author)
                stickerBuffer = await injectStickerMetadata(webpBuffer, STICKER_PACK, STICKER_AUTHOR);
                logger.info(`Video sticker with metadata: ${(stickerBuffer.length / 1024).toFixed(1)}KB`);

                if (stickerBuffer.length <= MAX_STICKER_SIZE_VIDEO) {
                    break;
                }

                // File too large, try lower quality
                quality -= WEBP_QUALITY_STEP;

                if (quality < WEBP_QUALITY_MIN) {
                    logger.warn(`Video sticker still exceeds ${MAX_STICKER_SIZE_VIDEO} bytes at minimum quality`);
                }
            } catch (encodeError) {
                logger.error(`Video sticker encoding failed at quality ${quality}:`, encodeError.message);
                await safeUnlink(outputPath);
                throw encodeError;
            }
        }

        // Cleanup preprocessed file
        await safeUnlink(preprocessedPath);

        // Return best effort even if still over size limit
        return stickerBuffer;
    } catch (error) {
        logger.error("Video sticker creation failed:", error.message);
        await safeUnlink(inputPath);
        await safeUnlink(preprocessedPath);
        throw error;
    }
}

/**
 * Creates a sticker from an image or video buffer
 *
 * For images: uses wa-sticker-formatter (Sharp-based, works well)
 * For videos: converts directly to animated WebP via FFmpeg's libwebp codec,
 *   bypassing wa-sticker-formatter's broken video→GIF→WebP pipeline that
 *   causes severe artifacts due to GIF's 256-color limitation.
 *
 * @param {Buffer} buffer - Image or video buffer
 * @param {boolean} [isVideo=false] - Whether the input is a video
 * @returns {Promise<Buffer>} Sticker buffer ready to send
 */
async function createSticker(buffer, isVideo = false) {
    // Validate input buffer
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("Invalid buffer provided for sticker creation");
    }

    // Video stickers: direct FFmpeg libwebp conversion (bypasses GIF bottleneck)
    if (isVideo) {
        logger.info(`Input video size: ${(buffer.length / 1024).toFixed(1)}KB`);
        return await createVideoSticker(buffer);
    }

    // Image stickers: use wa-sticker-formatter (Sharp handles these fine)
    let quality = QUALITY_START;
    let stickerBuffer;

    while (quality >= QUALITY_MIN) {
        const sticker = new Sticker(buffer, {
            pack: STICKER_PACK,
            author: STICKER_AUTHOR,
            type: StickerTypes.FULL,
            quality: quality,
        });

        await sticker.build();
        stickerBuffer = await sticker.get();

        logger.info(`Sticker quality ${quality}: ${stickerBuffer.length} bytes`);

        if (stickerBuffer.length <= MAX_STICKER_SIZE_IMAGE) {
            break;
        }

        quality -= QUALITY_STEP;

        // Warn when reaching minimum quality
        if (quality < QUALITY_MIN) {
            logger.warn(`Sticker still exceeds ${MAX_STICKER_SIZE_IMAGE} bytes at minimum quality`);
        }
    }

    // Return best effort even if still over size limit
    return stickerBuffer;
}

module.exports = {
    createSticker,
    createVideoSticker,
};
