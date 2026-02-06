const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { config } = require('../config/environment');
const LeaderboardService = require('../services/leaderboardService');
const SkinService = require('../services/skinService');
const TwitchService = require('../services/twitchService');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Intentional: wildcard CORS for public read-only stats API so third-party
// sites and browser extensions can fetch instance info without credentials.
router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// GET /api/public/info
// Returns channel name, 7TV cosmetics, and aggregate stats for this instance
router.get('/info', asyncHandler(async (req, res) => {
    try {
        const channel = config.TWITCH.CHANNEL || 'unknown';

        // Fetch stats + 7TV data in parallel
        const [leaderboardStats, skinStats, paintData, isLive] = await Promise.all([
            LeaderboardService.getStats(),
            Promise.resolve(SkinService.getSkinStats()),
            TwitchService.getUser7TVPaint(channel).catch(() => null),
            TwitchService.isChannelLive(channel).catch(() => false)
        ]);

        const totalFlips = (leaderboardStats.totalConeflipWins || 0) + (leaderboardStats.totalConeflipLosses || 0);
        const totalDuels = (leaderboardStats.totalDuelWins || 0) + (leaderboardStats.totalDuelLosses || 0);

        // Build paint object (null if no paint)
        let paint = null;
        if (paintData && !paintData.message) {
            paint = {
                name: paintData.name,
                kind: paintData.kind,
                function: paintData.function,
                gradientAngle: paintData.gradientAngle,
                gradientStops: paintData.gradientStops,
                color: paintData.color,
                image: paintData.image,
                shadows: paintData.shadows
            };
        }

        // Read last reset from resets.json
        let lastReset = null;
        let lastResetPlayers = null;
        try {
            const resetsPath = path.join(__dirname, '../../data/resets.json');
            if (fs.existsSync(resetsPath)) {
                const resets = JSON.parse(fs.readFileSync(resetsPath, 'utf8'));
                if (resets.length > 0) {
                    const last = resets[resets.length - 1];
                    lastReset = last.date;
                    lastResetPlayers = last.playersAffected || null;
                }
            }
        } catch (e) {
            // no resets file, that's fine
        }

        res.json({
            channel: channel,
            avatar_url: paintData ? paintData.avatar_url : null,
            isLive: isLive,
            lastReset: lastReset,
            lastResetPlayers: lastResetPlayers,
            paint: paint,
            stats: {
                totalFlips: totalFlips,
                totalDuels: totalDuels,
                uniquePlayers: leaderboardStats.playerCount || 0,
                topPlayer: leaderboardStats.topPlayer ? leaderboardStats.topPlayer.name : null,
                avgWinRate: Math.round((leaderboardStats.averageWinRate || 0) * 100) / 100,
                activeSkins: skinStats.totalAvailableSkins || 0,
                totalXP: leaderboardStats.totalXP || 0
            }
        });
    } catch (error) {
        logger.error('Public info endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch public info' });
    }
}));

module.exports = router;
