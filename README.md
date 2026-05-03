# WhatsApp Sticker Bot

A robust local WhatsApp bot that converts images and videos to stickers and downloads videos from various platforms.

## Features

### Sticker Creation
- 🖼️ **Images to Stickers**: Convert any image to a sticker
- 🎬 **Videos/GIFs to Stickers**: Convert videos to animated stickers (auto-optimized)
- 💬 **Reply Support**: Reply `/s` to any media message to convert it
- 📦 **Custom Metadata**: Stickers include custom pack and author names
- ♻️ **Recents Prevention**: Uses `StickerTypes.FULL` to help avoid flooding "Recently Used"

### Video Downloading
- 📥 **Download**: `/d <url>` to download and send a video (auto-deletes from server)
- 🌐 **Wide Support**: YouTube, TikTok, Instagram, Twitter/X, Reddit, and [many more](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- 🍪 **Cookie Support**: Uses `cookies.txt` for reliable TikTok/Instagram access
- ⏱️ **Rate Limiting**: Prevents spam with configurable cooldowns
- 🔢 **Concurrent Limits**: Controls max simultaneous downloads

### System & Performance
- 🚀 **GPU Acceleration**: NVIDIA NVENC hardware encoding with automatic CPU fallback
- 🔄 **Auto-Reconnect**: Robust connection handling with automatic recovery
- 🖥️ **System Tray**: Control the bot from the Windows taskbar
- 🕵️ **Background Mode**: Compatible with `pm2` or batch scripts
- 🛑 **Graceful Shutdown**: Clean exit on SIGTERM/SIGINT signals
- 📝 **Timestamped Logs**: ISO timestamps for easier debugging

## Requirements

- **OS**: Windows (optimized for Windows usage)
- **Node.js**: v18 or higher
- **FFmpeg**: Must be in system PATH
- **yt-dlp**: Download from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) and place `yt-dlp.exe` in the project root

### Optional
- **NVIDIA GPU**: For hardware-accelerated video encoding (falls back to CPU if unavailable)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/your-username/whatsapp-sticker-bot.git
   cd whatsapp-sticker-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Download `yt-dlp.exe` from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) and place it in the project root.

4. (Optional) Install `pm2` for background management:
   ```bash
   npm install -g pm2
   ```

## Usage

### 1. Start the Bot

**Normal Mode:**
```bash
node index.js
```

**With System Tray:**
```bash
node index.js --tray
```

Scan the QR code with WhatsApp to log in.

### 2. Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `/s` | Convert image/video to sticker (Caption or Reply) | Send image with caption `/s` |
| `/d <url>` | Download and send video (Temporary) | `/d https://youtu.be/...` |

### 3. Background Running (Windows)

Scripts are provided for easy management:
- `start-background.bat`: Start bot hidden in background
- `stop-background.bat`: Stop the background process
- `view-logs.bat`: Tail the logs to check status

## Configuration

Configuration can be customized via **environment variables** or by editing `src/config.js`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STICKER_PACK` | "feito por viny." | Sticker pack name shown in WhatsApp |
| `STICKER_AUTHOR` | "viny" | Sticker author name |
| `QUALITY_START` | 50 | Initial sticker compression quality (1-100) |
| `QUALITY_MIN` | 10 | Minimum sticker quality before giving up |
| `DOWNLOAD_TIMEOUT` | 300000 | Download timeout in milliseconds (5 min) |
| `ENCODE_TIMEOUT` | 300000 | Video encoding timeout in milliseconds |
| `RATE_LIMIT_MS` | 10000 | Cooldown between downloads per chat (10s) |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Maximum simultaneous downloads |
| `DOWNLOADS_DIR` | ./downloads | Directory for downloaded files |
| `YTDLP_PATH` | ./yt-dlp.exe | Path to yt-dlp executable |
| `COOKIES_PATH` | ./cookies.txt | Path to cookies file |
| `AUTH_DIR` | ./.wwebjs_auth | WhatsApp auth state directory |

### Example

```bash
# Custom sticker metadata
set STICKER_PACK="My Sticker Pack"
set STICKER_AUTHOR="MyName"
node index.js --tray
```


## Troubleshooting

| Issue | Solution |
|-------|----------|
| "File not supported" | Large videos (>64MB) are re-encoded. Very large files may still fail. |
| TikTok/Instagram errors | Ensure `cookies.txt` is up to date in the root directory |
| No GPU acceleration | Install NVIDIA drivers; bot will auto-fallback to CPU encoding |
| yt-dlp not found | Download from [releases](https://github.com/yt-dlp/yt-dlp/releases) and place in root |

## Project Structure

```
WppBot/
├── index.js           # Main entry point
├── src/
│   ├── config.js      # Configuration with env var support
│   ├── utils.js       # Utilities (logger, Semaphore, helpers)
│   ├── video.js       # Video download & encoding
│   ├── sticker.js     # Sticker creation
│   ├── tray.js        # System tray functionality
│   └── commands/      # Command handlers
│       ├── download.js
│       └── sticker.js
├── downloads/         # Temporary video storage
├── cookies.txt        # Cookies for TikTok/Instagram
└── yt-dlp.exe         # Video downloader (not included, download separately)
```

## License

CC-NC
