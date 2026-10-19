# WhatsApp Sticker Bot

A WhatsApp bot that converts images and videos to stickers, downloads media from various platforms, and runs a book club.

## Architecture

- **Cloud bot** (`index.js`, Oracle Cloud VM, systemd): WhatsApp connection, stickers, book club, Spotify → Apple Music.
- **Local worker** (`local-worker/`, your Windows PC, reached via Cloudflare Tunnel): yt-dlp downloads and GPU encoding.
  Downloads run as background jobs that the cloud polls, so long encodes aren't cut off by Cloudflare's 100 s request limit.
- When the PC is off, `/ds` still works by downloading on the cloud VM; other downloads report that the PC is offline.

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

- **Node.js**: v22 or higher (yt-dlp uses it as its JavaScript runtime for YouTube)
- **FFmpeg**: Must be in system PATH
- **yt-dlp**: Standalone binary — `yt-dlp.exe` in the project root on the PC (`deploy/setup.sh` installs it on the cloud VM).
  It updates itself every 12 h (`YTDLP_UPDATE_CHANNEL` / `YTDLP_UPDATE_INTERVAL_MS`). Installing [Deno](https://deno.com) is optional; Node is used otherwise.

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

**Cloud bot** (first time: `sudo bash deploy/setup.sh`):
```bash
sudo systemctl start wppbot
sudo journalctl -u wppbot -f   # scan the QR code shown here
```

**Local worker** (on the PC, after `npm install` in both the root and `local-worker/`):
```bash
local-worker\start.bat
```

### 2. Commands

| Command | Description | Example |
| :--- | :--- | :--- |
| `/s` | Convert image/video to sticker (Caption or Reply) | Send image with caption `/s` |
| `/d <url>` | Download and send video (≤720p) | `/d https://youtu.be/...` |
| `/dd <url>` | Same as `/d`, but keep the file on the PC | |
| `/da <url>` / `/dda <url>` | Download audio as MP3 (`/dda` keeps the file) | |
| `/ds <url>` | Download the first seconds of a video as a sticker | |
| `/ping` | Bot uptime, PC worker status and yt-dlp version | |
| `/ajuda` | List all commands (incl. book club) | |

Any `/d*` command with text instead of a URL searches YouTube and lets you pick a result. Spotify links are answered automatically with the Apple Music link.

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
| `STICKER_PACK` | "automatizado por" | Sticker pack name shown in WhatsApp |
| `STICKER_AUTHOR` | "vinycius.me" | Sticker author name |
| `QUALITY_START` | 30 | Initial sticker compression quality (1-100) |
| `QUALITY_MIN` | 10 | Minimum sticker quality before giving up |
| `DOWNLOAD_TIMEOUT` | 300000 | Download timeout in milliseconds (5 min) |
| `ENCODE_TIMEOUT` | 300000 | Video encoding timeout in milliseconds |
| `RATE_LIMIT_MS` | 10000 | Cooldown between downloads per chat (10s) |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | Maximum simultaneous downloads |
| `DOWNLOADS_DIR` | ./downloads | Directory for downloaded files |
| `YTDLP_PATH` | ./yt-dlp.exe | Path to yt-dlp executable |
| `COOKIES_PATH` | ./cookies.txt | Cookies file (passed to yt-dlp whenever it exists) |
| `YTDLP_UPDATE_CHANNEL` | nightly | yt-dlp self-update channel (`stable`, `nightly`, `master`) |
| `YTDLP_UPDATE_INTERVAL_MS` | 43200000 | How often yt-dlp self-updates (0 = never) |
| `LOCAL_WORKER_URL` | | Cloud: URL of the local worker (Cloudflare Tunnel) |
| `LOCAL_WORKER_SECRET` / `WORKER_SECRET` | | Shared secret between cloud and worker — always set it |
| `AUTH_DIR` | ./.wwebjs_auth | WhatsApp auth state directory |

### Example

```bash
# Custom sticker metadata
set STICKER_PACK="My Sticker Pack"
set STICKER_AUTHOR="MyName"
node index.js
```


## Troubleshooting

| Issue | Solution |
|-------|----------|
| "File not supported" | Videos are re-encoded to H.264/AAC when needed; anything still over 64 MB is sent as a document. |
| YouTube "Sign in to confirm" / missing formats | Refresh `cookies.txt`; check `/ping` shows a recent yt-dlp version |
| TikTok/Instagram errors | Ensure `cookies.txt` is up to date in the root directory |
| No GPU acceleration | Install NVIDIA drivers; bot will auto-fallback to CPU encoding |
| yt-dlp not found | Download from [releases](https://github.com/yt-dlp/yt-dlp/releases) and place in root |

## Project Structure

```
WppBot/
├── index.js                 # Cloud bot entry point
├── local-worker/index.js    # PC worker API (downloads, encoding)
├── deploy/                  # Cloud VM setup script + systemd unit
├── src/
│   ├── config.js            # Configuration with env var support
│   ├── utils.js             # Utilities (logger, Semaphore, helpers)
│   ├── ytdlp.js             # yt-dlp wrapper + self-update
│   ├── video.js             # Video download & encoding
│   ├── sticker.js           # Sticker creation
│   ├── local-worker-client.js  # Cloud → worker HTTP client
│   └── commands/            # Command handlers (download, search, sticker, bookclub, ...)
├── downloads/               # Temporary video storage
├── cookies.txt        # Cookies for TikTok/Instagram
└── yt-dlp.exe         # Video downloader (not included, download separately)
```

## License

CC-NC
