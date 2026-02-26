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

// GET /api/public/avatar/:username
// Returns the best avatar for a user (tries 7TV via GraphQL first, falls back to Twitch profile pic)
router.get('/avatar/:username', asyncHandler(async (req, res) => {
    try {
        const username = req.params.username.toLowerCase().trim();
        if (!username) {
            return res.json({ avatar_url: null });
        }

        // Try 7TV avatar first (uses GraphQL search by username - same as profile.html/paint endpoint)
        try {
            const paintData = await TwitchService.getUser7TVPaint(username);
            if (paintData && paintData.avatar_url) {
                const url = paintData.avatar_url.startsWith('/') ? 'https:' + paintData.avatar_url : paintData.avatar_url;
                return res.json({ avatar_url: url });
            }
        } catch (e) {
            // 7TV failed, fall through to Twitch
        }

        // Fallback: Twitch profile picture
        const twitchId = await TwitchService.getTwitchId(username);
        if (!twitchId) {
            return res.json({ avatar_url: null });
        }

        const axios = require('axios');
        const response = await axios.get('https://api.twitch.tv/helix/users', {
            params: { id: twitchId },
            headers: {
                'Client-ID': config.TWITCH.CLIENT_ID,
                'Authorization': `Bearer ${config.TWITCH.STREAMER_ACCESS_TOKEN}`
            }
        });

        const user = response.data?.data?.[0];
        res.json({ avatar_url: user?.profile_image_url || null });
    } catch (error) {
        logger.error('Avatar endpoint error:', error.message);
        res.json({ avatar_url: null });
    }
}));

module.exports = router;
