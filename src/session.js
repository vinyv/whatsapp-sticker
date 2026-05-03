/**
 * Per-user session state manager for multi-step command flows.
 * Sessions expire after 2 minutes of inactivity.
 * @module session
 */

const { logger } = require("./utils");

/** @type {number} Session expiry time in ms (2 minutes) */
const SESSION_EXPIRY_MS = 120000;

/**
 * Active user sessions
 * @type {Map<string, { flow: string, step: string, data: object, timestamp: number }>}
 */
const sessions = new Map();

// Cleanup expired sessions every 30 seconds
setInterval(() => {
    const now = Date.now();
    for (const [userId, session] of sessions.entries()) {
        if (now - session.timestamp > SESSION_EXPIRY_MS) {
            sessions.delete(userId);
        }
    }
}, 30000);

/**
 * Gets the active session for a user
 * @param {string} userId - User's WhatsApp ID
 * @returns {object|null} Session state or null
 */
function getSession(userId) {
    const session = sessions.get(userId);
    if (!session) return null;

    // Check if expired
    if (Date.now() - session.timestamp > SESSION_EXPIRY_MS) {
        sessions.delete(userId);
        return null;
    }

    return session;
}

/**
 * Sets or updates a user's session state
 * @param {string} userId - User's WhatsApp ID
 * @param {object} state - Session state { flow, step, data }
 */
function setSession(userId, state) {
    sessions.set(userId, {
        ...state,
        timestamp: Date.now(),
    });
}

/**
 * Clears a user's session
 * @param {string} userId - User's WhatsApp ID
 * @returns {boolean} True if a session was cleared
 */
function clearSession(userId) {
    return sessions.delete(userId);
}

/**
 * Checks if a user has an active session
 * @param {string} userId - User's WhatsApp ID
 * @returns {boolean}
 */
function isInSession(userId) {
    return getSession(userId) !== null;
}

module.exports = {
    getSession,
    setSession,
    clearSession,
    isInSession,
    SESSION_EXPIRY_MS,
};
