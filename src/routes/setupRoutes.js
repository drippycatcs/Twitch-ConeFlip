const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { requireDebugAuth } = require('../middleware/tokenAuth');
const ConfigService = require('../services/configService');
const { reloadConfig } = require('../config/environment');
const logger = require('../utils/logger');

// get setup status (both root and /status should work) - REQUIRE AUTH
router.get('/', requireDebugAuth, asyncHandler(async (req, res) => {
    const config = ConfigService.getAll();
    res.json(config);
}));

router.get('/status', requireDebugAuth, asyncHandler(async (req, res) => {
    const config = ConfigService.getAll();
    res.json(config);
}));

// save configuration - handle both /save and root POST - REQUIRE AUTH
router.post('/', requireDebugAuth, asyncHandler(async (req, res) => {
    const config = req.body;
    await ConfigService.saveConfig(config);

    // Reload environment config (updates ADMINS, MODERATORS, etc.)
    reloadConfig();

    logger.info('Configuration saved via setup');

    // reload twitch service with new config
    try {
        const twitchService = require('../services/twitchService');
        await twitchService.reconnect();
    } catch (error) {
        logger.error('Failed to reconnect Twitch service:', error);
    }

    res.json({
        success: true,
        message: 'Configuration saved successfully'
    });
}));

router.post('/save', requireDebugAuth, asyncHandler(async (req, res) => {
    const config = req.body;
    await ConfigService.saveConfig(config);

    // Reload environment config (updates ADMINS, MODERATORS, etc.)
    reloadConfig();

    logger.info('Configuration saved via setup');

    // reload twitch service with new config
    try {
        const twitchService = require('../services/twitchService');
        await twitchService.reconnect();
    } catch (error) {
        logger.error('Failed to reconnect Twitch service:', error);
    }

    res.json({
        success: true,
        message: 'Configuration saved successfully'
    });
}));

// test configuration endpoint - REQUIRE AUTH
router.post('/test', requireDebugAuth, asyncHandler(async (req, res) => {
    const config = req.body;
    
    // basic validation
    const errors = [];
    const warnings = [];
    
    if (!config.TWITCH_CHANNEL) {
        errors.push('Missing Twitch Channel');
    }
    
    if (!config.BOT_NAME) {
        errors.push('Missing Bot Name');
    }
    
    if (!config.BOT_ACCESS_TOKEN) {
        errors.push('Missing Bot Access Token');
    }
    
    if (!config.STREAMER_ACCESS_TOKEN) {
        warnings.push('Missing Streamer Access Token (optional)');
    }
    
    if (!config.TWITCH_CLIENT) {
        warnings.push('Missing Twitch Client ID (optional)');
    }
    
    const result = {
        success: errors.length === 0,
        errors,
        warnings,
        config: {
            channel: config.TWITCH_CHANNEL,
            bot: config.BOT_NAME,
            hasBotToken: !!config.BOT_ACCESS_TOKEN,
            hasStreamerToken: !!config.STREAMER_ACCESS_TOKEN,
            hasClientId: !!config.TWITCH_CLIENT
        }
    };
    
    res.json(result);
}));

module.exports = router; 