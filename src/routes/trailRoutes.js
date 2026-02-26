const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { requireDebugAuth, requireModeratorAuth } = require('../middleware/tokenAuth');
const { validateSetSkin, createRateLimiter } = require('../middleware/validation');
const TrailService = require('../services/trailService');
const TwitchService = require('../services/twitchService');
const { config } = require('../config/environment');
const logger = require('../utils/logger');

// Rate limiting
const trailsRateLimit = createRateLimiter(60 * 1000, 60); // 60 requests per minute

// Get all trail configurations
router.get('/config', asyncHandler(async (req, res) => {
    try {
        const trailConfig = TrailService.getAllTrails();
        res.json(trailConfig);
    } catch (error) {
        logger.error('Error fetching trail config:', error);
        res.json([]);
    }
}));

// Get available trails for selection
router.get('/available', asyncHandler(async (req, res) => {
    try {
        const availableTrails = TrailService.getAvailableTrails();
        res.json(availableTrails);
    } catch (error) {
        logger.error('Error fetching available trails:', error);
        res.json({});
    }
}));

// Get trail odds for unboxing
router.get('/odds', asyncHandler(async (req, res) => {
    const odds = {
        'gold': 2,
        'covert': 3.5,
        'classified': 10.5,
        'restricted': 27.5,
        'mil-spec': 56.5
    };
    res.json({
        status: 'success',
        data: odds
    });
}));

// Set/give a trail to a user - MODERATORS CAN ACCESS
router.get('/give',
    requireModeratorAuth,
    trailsRateLimit,
    validateSetSkin, // Reuse validation (checks name and item parameters)
    asyncHandler(async (req, res) => {
        const { name, skin: trail } = req.validatedData; // Reuse skin validation for trail
        
        // Get Twitch ID if possible
        const twitchId = await TwitchService.getTwitchId(name);
        
        // Set the current trail
        const result = await TrailService.setTrail(name, trail, twitchId);
        
        // Also add the trail to their inventory if they don't have it
        await TrailService.giveTrail(name, trail, twitchId);
        
        logger.userAction('trail_given', name, { trail });
        
        res.json({
            status: 'success',
            ...result
        });
    })
);

// Get user's current trail and inventory
router.get('/user/:name', asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    
    // Get both current trail and inventory
    const [trail, inventory] = await Promise.all([
        TrailService.getPlayerTrail(name),
        TrailService.getPlayerTrailInventory(name)
    ]);
    
    res.json({
        status: 'success',
        data: {
            name,
            trail,
            inventory
        }
    });
}));

// Get user's trail inventory
router.get('/inventory/:name', asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    const inventory = await TrailService.getPlayerTrailInventory(name);
    
    res.json({
        status: 'success',
        data: inventory
    });
}));

// Get all user trails (similar to skins/users endpoint)
router.get('/users', asyncHandler(async (req, res) => {
    try {
        const DatabaseService = require('../services/databaseService');
        const userTrails = await DatabaseService.getAllUserTrails();
        
        res.json({
            status: 'success',
            data: userTrails
        });
    } catch (error) {
        logger.error('Error fetching user trails:', error);
        res.json({
            status: 'success',
            data: []
        });
    }
}));

// Trail unboxing removed - trails will be purchasable in the future

// Select trail for authenticated user (from profile)
router.post('/select',
    asyncHandler(async (req, res) => {
        const { trailName } = req.body;
        
        // Check if user is authenticated
        if (!req.session.user || !req.session.user.id) {
            return res.status(401).json({
                status: 'error',
                message: 'Authentication required'
            });
        }
        
        if (!trailName) {
            return res.status(400).json({
                status: 'error',
                message: 'Trail name is required'
            });
        }
        
        try {
            const username = req.session.user.login;
            const twitchId = req.session.user.id;
            
            // Check if user owns this trail (unless it's default)
            if (trailName.toLowerCase() !== 'default') {
                const userInventory = await TrailService.getPlayerTrailInventory(username);
                const hasTrail = userInventory && userInventory.some(item => {
                    const itemTrailName = typeof item === 'string' ? item : (item.trail || item.name || item);
                    return itemTrailName && itemTrailName.toLowerCase() === trailName.toLowerCase();
                });
                
                if (!hasTrail) {
                    return res.status(403).json({
                        status: 'error',
                        message: `You don't own the "${trailName}" trail`
                    });
                }
            }
            
            // Set the trail
            const result = await TrailService.setTrail(username, trailName, twitchId);
            
            logger.info(`User ${username} selected trail: ${trailName}`);
            
            res.json({
                status: 'success',
                message: `Trail changed to "${trailName}"!`,
                trail: trailName
            });
        } catch (error) {
            logger.error('Error selecting trail:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to select trail'
            });
        }
    })
);

module.exports = router; 