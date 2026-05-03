/**
 * WppBot YouTube Volume Extension — Content Script
 *
 * Connects to the bot's WebSocket server and adjusts YouTube player volume
 * when instructed. Automatically reconnects on disconnect.
 */

(() => {
    const WS_URL = "ws://localhost:8765";
    const RECONNECT_DELAY = 3000; // ms

    let ws = null;

    function connect() {
        try {
            ws = new WebSocket(WS_URL);
        } catch {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            console.log("[WppBot] Connected to bot WebSocket");
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === "setVolume") {
                    const volume = Math.max(0, Math.min(1, msg.value));
                    setYouTubeVolume(volume);
                }
            } catch (err) {
                console.error("[WppBot] Error handling message:", err);
            }
        };

        ws.onclose = () => {
            console.log("[WppBot] Disconnected, reconnecting...");
            ws = null;
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose will fire after onerror, which handles reconnect
            ws?.close();
        };
    }

    function scheduleReconnect() {
        setTimeout(connect, RECONNECT_DELAY);
    }

    /**
     * Sets the YouTube player volume.
     * Uses the <video> element directly and also tries the YouTube player API.
     */
    function setYouTubeVolume(volume) {
        // Method 1: Direct video element
        const video = document.querySelector("video");
        if (video) {
            video.volume = volume;
            // Unmute if setting volume > 0
            if (volume > 0) {
                video.muted = false;
            }
            console.log(`[WppBot] Volume set to ${Math.round(volume * 100)}%`);
        }

        // Method 2: YouTube player API (if available)
        const player = document.getElementById("movie_player");
        if (player && typeof player.setVolume === "function") {
            player.setVolume(Math.round(volume * 100));
            if (volume > 0 && typeof player.unMute === "function") {
                player.unMute();
            }
        }
    }

    // Start connection
    connect();
})();
