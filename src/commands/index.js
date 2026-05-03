/**
 * Central export for all command handlers.
 * @module commands
 */

const { matchDownloadCommand, handleDownloadCommand } = require("./download");
const { matchStickerCommand, handleStickerCommand } = require("./sticker");
const { matchSearchReply, handleSearchReply, handleSearchCommand } = require("./search");
const {
    matchBookClubCommand,
    handleBookClubCommand,
    handleSessionStep,
} = require("./bookclub");
const { matchVolumeCommand, handleVolumeCommand } = require("./volume");

module.exports = {
    // Download
    matchDownloadCommand,
    handleDownloadCommand,

    // Search
    matchSearchReply,
    handleSearchReply,
    handleSearchCommand,

    // Sticker
    matchStickerCommand,
    handleStickerCommand,

    // Book Club
    matchBookClubCommand,
    handleBookClubCommand,
    handleSessionStep,

    // Volume
    matchVolumeCommand,
    handleVolumeCommand,
};
