# WhatsApp Sticker Bot

A local WhatsApp bot that converts images and videos to stickers using the `/s` command and downloads videos from URLs using the `/d` command.

## Features

- 🖼️ Convert images to stickers
- 🎬 Convert videos/GIFs to animated stickers
- 💬 Reply to any media with `/s` to convert it
- 📥 Download videos from YouTube, TikTok, Instagram, Twitter, and more with `/d`
- 📦 Stickers include custom metadata ("feito por viny.")
- 🔄 Auto-reconnect on disconnection
- 🖥️ Background running support with pm2

## Requirements

- Node.js v18 or higher
- npm
- FFmpeg (included via dependencies)
- yt-dlp.exe (for video downloads - already included in the repo)

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Install pm2 globally (for background running):
```bash
npm install -g pm2
```

## Usage

### First Run (QR Code Login)

```bash
node index.js
```

Scan the QR code with your WhatsApp app to link the bot.

### Creating Stickers

**Option 1:** Send an image/video with `/s` as the caption

**Option 2:** Reply to any image/video message with `/s`

### Downloading Videos

Send a message with `/d <url>` to download a video from supported platforms:

```
/d https://www.youtube.com/watch?v=dQw4w9WgXcQ
/d https://www.tiktok.com/@user/video/123456789
/d https://www.instagram.com/reel/ABC123/
/d https://twitter.com/user/status/123456789
```

**Supported platforms:** YouTube, TikTok, Instagram, Twitter/X, Facebook, Reddit, and [many more](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).

**Note:** Videos larger than 64MB will fail (WhatsApp limit).

### Background Running

| Script | Description |
|--------|-------------|
| `start-background.bat` | Start bot in background |
| `stop-background.bat` | Stop the bot |
| `view-logs.bat` | View bot logs |

Or use pm2 commands directly:
```bash
pm2 start index.js --name wppbot   # Start
pm2 stop wppbot                     # Stop
pm2 logs wppbot                     # View logs
pm2 delete wppbot                   # Remove
```

## Configuration

Edit these constants in `index.js` to customize:

```javascript
const STICKER_PACK = 'feito por viny.';  // Pack name
const STICKER_AUTHOR = 'viny';            // Author name
```

## Notes

- Stickers are auto-optimized to fit WhatsApp's size limits (100KB for images, 500KB for videos)
- Animated stickers may appear slightly different on WhatsApp Web vs mobile
- Session data is stored in `.wwebjs_auth` folder

## License

CC-NC
