/**
 * Community Registration Service
 *
 * This service periodically sends a heartbeat to the ConeFlip community directory
 * at drippycat.lol so your instance can appear on the public "Communities Using ConeFlip"
 * section of the website. This helps other streamers discover active ConeFlip communities.
 *
 * What it sends:
 *   - Your Twitch channel name
 *   - Your instance's public URL (BASE_URL from config)
 *   - Basic aggregate stats (total flips, players, etc.) — same data already
 *     exposed publicly via /api/public/info
 *
 * What it does NOT send:
 *   - No API keys, tokens, or secrets
 *   - No individual player data
 *   - No private configuration
 *
 * You can disable this entirely by setting DISABLE_COMMUNITY_PING=true in your
 * environment or by removing this service. ConeFlip works fine without it.
 */

const { config } = require('../config/environment');
const logger = require('../utils/logger');

const COMMUNITY_API = 'https://drippycat.lol/api/community/ping';
const PING_INTERVAL = 30 * 60 * 1000; // 30 minutes

let pingTimer = null;

async function sendPing() {
    // Skip if explicitly disabled
    if (process.env.DISABLE_COMMUNITY_PING === 'true') return;

    const channel = config.TWITCH?.CHANNEL;
    const baseUrl = process.env.BASE_URL;

    // Need at least a channel name to register
    if (!channel) return;

    try {
        // Lazy-require to avoid circular dependency issues at startup
        const LeaderboardService = require('./leaderboardService');
        const SkinService = require('./skinService');

        const [leaderboardStats, skinStats] = await Promise.all([
            LeaderboardService.getStats().catch(() => ({})),
            Promise.resolve(SkinService.getSkinStats()).catch(() => ({}))
        ]);

        const totalFlips = (leaderboardStats.totalConeflipWins || 0) + (leaderboardStats.totalConeflipLosses || 0);
        const totalDuels = (leaderboardStats.totalDuelWins || 0) + (leaderboardStats.totalDuelLosses || 0);

        const payload = {
            channel: channel,
            url: baseUrl || null,
            stats: {
                totalFlips,
                totalDuels,
                uniquePlayers: leaderboardStats.playerCount || 0,
                totalXP: leaderboardStats.totalXP || 0,
                activeSkins: skinStats.totalAvailableSkins || 0
            }
        };

        const response = await fetch(COMMUNITY_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000) // 10s timeout
        });

        if (response.ok) {
            logger.info(`Community ping sent for ${channel}`);
        }
    } catch (error) {
        // Silently ignore — community ping is non-essential
        // Only log at debug level so it doesn't spam the console
        logger.debug?.(`Community ping failed: ${error.message}`);
    }
}

function start() {
    if (process.env.DISABLE_COMMUNITY_PING === 'true') {
        logger.info('Community ping disabled via DISABLE_COMMUNITY_PING');
        return;
    }

    // Send first ping after a short delay (let services fully initialize)
    setTimeout(() => {
        sendPing();
        // Then ping every 30 minutes
        pingTimer = setInterval(sendPing, PING_INTERVAL);
    }, 15000); // 15 second initial delay
}

function stop() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

module.exports = { start, stop };
