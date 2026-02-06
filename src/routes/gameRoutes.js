const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { requireDebugAuth, requireModeratorAuth } = require('../middleware/tokenAuth');
const { validateAddCone, validateDuel, createRateLimiter } = require('../middleware/validation');
const GameService = require('../services/gameService');
const logger = require('../utils/logger');

// Rate limiting for game actions
const gameRateLimit = createRateLimiter(60 * 1000, 30); // 30 requests per minute

// Add a cone flip - MODERATORS CAN ACCESS
router.get('/cone/add',
    requireModeratorAuth,
    gameRateLimit,
    validateAddCone,
    asyncHandler(async (req, res) => {
        const { name } = req.validatedData;
        
        const result = await GameService.addCone(name);
        
        logger.userAction('cone_add_request', name);
        
        res.json({
            status: 'success',
            message: `Cone added for ${name}`,
            data: result
        });
    })
);

// Start a duel - MODERATORS CAN ACCESS
router.get('/cone/duel',
    requireModeratorAuth,
    gameRateLimit,
    validateDuel,
    asyncHandler(async (req, res) => {
        const { name, target } = req.validatedData;
        
        const result = await GameService.addDuel(name, target);
        
        logger.userAction('duel_request', name, { target });
        
        res.json({
            status: 'success',
            message: `Duel started: ${name} vs ${target}`,
            data: result
        });
    })
);

// Get game status - PUBLIC
router.get('/status', asyncHandler(async (req, res) => {
    const status = await GameService.getStatus();
    res.json(status);
}));

// Get active games - PUBLIC
router.get('/active', asyncHandler(async (req, res) => {
    const activeGames = await GameService.getActiveGames();
    res.json({
        status: 'success',
        data: activeGames
    });
}));

// Get game statistics - PUBLIC
router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await GameService.getGameStats();
    res.json({
        status: 'success',
        data: stats
    });
}));

// Restart/reset endpoint - ADMIN ONLY
router.post('/restart', 
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        await GameService.restart();
        
        logger.info('Game restart requested');
        
        res.json({
            status: 'success',
            message: 'Game restarted successfully'
        });
    })
);

module.exports = router; 