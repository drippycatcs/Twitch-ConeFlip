const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { validateLeaderboardQuery, createRateLimiter } = require('../middleware/validation');
const LeaderboardService = require('../services/leaderboardService');
const GameService = require('../services/gameService');
const logger = require('../utils/logger');

// Rate limiting for leaderboard requests
const leaderboardRateLimit = createRateLimiter(60 * 1000, 120); // 120 requests per minute

// Get leaderboard data
router.get('/',
    leaderboardRateLimit,
    validateLeaderboardQuery,
    asyncHandler(async (req, res) => {
        const { name, show, page = 1, limit = 50 } = req.validatedData;
        // Get sortBy from query params (not validated, defaults to 'points')
        const sortBy = req.query.sortBy === 'level' ? 'level' : 'points';

        // Handle show leaderboard request
        if (show) {
            await GameService.showLeaderboard(name);
            return res.json({
                status: 'success',
                message: 'Leaderboard display triggered'
            });
        }

        // Handle specific player lookup
        if (name) {
            const playerData = await LeaderboardService.getPlayer(name);
            const message = LeaderboardService.formatPlayerStats(playerData);

            return res.json({
                status: 'success',
                message,
                data: playerData
            });
        }

        // Get full leaderboard with sortBy option
        const leaderboard = await LeaderboardService.getLeaderboard(page, limit, sortBy);

        res.json({
            status: 'success',
            data: leaderboard.data,
            pagination: leaderboard.pagination,
            sortBy: leaderboard.sortBy
        });
    })
);

// Get leaderboard statistics
router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await LeaderboardService.getStats();
    const message = LeaderboardService.formatLeaderboardStats(stats);
    
    res.json({
        status: 'success',
        message,
        data: stats
    });
}));

// Search players
router.get('/search',
    leaderboardRateLimit,
    asyncHandler(async (req, res) => {
        const { q: searchTerm, limit = 20 } = req.query;
        
        if (!searchTerm || searchTerm.trim().length < 2) {
            return res.status(400).json({
                status: 'error',
                message: 'Search term must be at least 2 characters'
            });
        }
        
        const results = await LeaderboardService.searchPlayers(searchTerm, limit);
        
        res.json({
            status: 'success',
            data: results
        });
    })
);

// Get specific player by name
router.get('/player/:name', asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    const playerData = await LeaderboardService.getPlayer(name);
    
    res.json({
        status: 'success',
        data: playerData
    });
}));

module.exports = router; 