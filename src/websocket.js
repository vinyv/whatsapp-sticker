/**
 * WebSocket server for communicating with the YouTube volume extension.
 * Runs on localhost:8765 and broadcasts volume commands to connected clients.
 * @module websocket
 */

const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const { logger } = require("./utils");

/** @type {number} WebSocket server port */
const WS_PORT = 8765;

/** @type {Set<WebSocket>} Connected clients */
const clients = new Set();

/** @type {WebSocketServer|null} */
let wss = null;

/**
 * Starts the WebSocket server
 */
function startWebSocketServer() {
    wss = new WebSocketServer({ port: WS_PORT });

    wss.on("listening", () => {
        logger.info(`WebSocket server listening on ws://localhost:${WS_PORT}`);
    });

    wss.on("connection", (ws) => {
        clients.add(ws);
        logger.info(`Extension connected (${clients.size} client(s))`);

        ws.on("close", () => {
            clients.delete(ws);
            logger.info(`Extension disconnected (${clients.size} client(s))`);
        });

        ws.on("error", (err) => {
            logger.error("WebSocket client error:", err.message);
            clients.delete(ws);
        });
    });

    wss.on("error", (err) => {
        logger.error("WebSocket server error:", err.message);
    });
}

/**
 * Sends a message to all connected clients
 * @param {object} message - Message object to send (will be JSON-stringified)
 */
function broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of clients) {
        if (ws.readyState !== WebSocket.OPEN) {
            clients.delete(ws);
            continue;
        }
        try {
            ws.send(data);
        } catch (err) {
            logger.error("WebSocket send error:", err.message);
            clients.delete(ws);
        }
    }
}

/**
 * Checks if any extension client is connected
 * @returns {boolean} True if at least one client is connected
 */
function isConnected() {
    return clients.size > 0;
}

module.exports = {
    startWebSocketServer,
    broadcast,
    isConnected,
};
