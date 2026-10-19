#!/bin/bash
# WppBot Cloud Setup Script for Oracle Cloud ARM VM (Ubuntu 22.04+)
# Run as root or with sudo: sudo bash setup.sh

set -e

echo "=== WppBot Cloud Setup ==="

# 1. System updates
echo "[1/6] Updating system packages..."
apt-get update && apt-get upgrade -y

# 2. Install Node.js 22 LTS (ARM). Node 20 is EOL, and yt-dlp's Node JS runtime needs >= 22.
echo "[2/6] Installing Node.js 22 LTS..."
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node -v)"
fi

# 3. Install FFmpeg (includes libwebp for video stickers) and yt-dlp (cloud /ds fallback)
echo "[3/6] Installing FFmpeg and yt-dlp..."
apt-get install -y ffmpeg
case "$(uname -m)" in
    aarch64|arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;;
    *)             YTDLP_ASSET="yt-dlp_linux" ;;
esac
# Standalone binary (not apt/pip) so the bot can self-update it with --update-to
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET" -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
echo "yt-dlp $(/usr/local/bin/yt-dlp --version)"

# 4. Clone repo and install dependencies
echo "[4/6] Setting up WppBot..."
INSTALL_DIR="/opt/wppbot"
if [ ! -d "$INSTALL_DIR" ]; then
    git clone https://github.com/vinyv/whatsapp-sticker.git "$INSTALL_DIR"
else
    echo "Directory already exists, pulling latest..."
    cd "$INSTALL_DIR" && git pull
fi
cd "$INSTALL_DIR"
npm install --production

# 5. Create .env from template if it doesn't exist
echo "[5/6] Setting up configuration..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.cloud.example" "$INSTALL_DIR/.env"
    echo ">>> Created .env from template. Please edit it with your API keys:"
    echo ">>>   nano $INSTALL_DIR/.env"
else
    echo ".env already exists, skipping."
fi

# Create data directory for book club JSON
mkdir -p "$INSTALL_DIR/data"

# 6. Install systemd service
echo "[6/6] Installing systemd service..."
cp "$INSTALL_DIR/deploy/wppbot.service" /etc/systemd/system/wppbot.service
systemctl daemon-reload
systemctl enable wppbot

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit your .env:  nano $INSTALL_DIR/.env"
echo "  2. Start the bot:   sudo systemctl start wppbot"
echo "  3. Scan QR code:    sudo journalctl -u wppbot -f"
echo "  4. Check status:    sudo systemctl status wppbot"
echo ""
