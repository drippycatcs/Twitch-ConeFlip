const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { requireDebugAuth, requireModeratorAuth } = require('../middleware/tokenAuth');
const { createRateLimiter } = require('../middleware/validation');
const GameService = require('../services/gameService');
const LeaderboardService = require('../services/leaderboardService');
const SkinService = require('../services/skinService');
const DatabaseService = require('../services/databaseService');
const TwitchService = require('../services/twitchService');
const TokenService = require('../services/tokenService');
const SubmissionService = require('../services/submissionService');
const logger = require('../utils/logger');

// Standalone browser info parser
function parseBrowserInfo(userAgent) {
    if (!userAgent) {
        return { name: 'Unknown', version: 'Unknown', type: 'Unknown' };
    }

    const ua = userAgent.toLowerCase();
    let browser = { name: 'Unknown', version: 'Unknown', type: 'Browser' };

    // Check for OBS Studio
    if (ua.includes('obs')) {
        browser.name = 'OBS Studio';
        browser.type = 'Streaming Software';
        const obsMatch = userAgent.match(/obs[\/\s](\d+[\.\d]*)/i);
        if (obsMatch) browser.version = obsMatch[1];
    }
    // Check for Chrome/Chromium based browsers
    else if (ua.includes('chrome') && !ua.includes('edg')) {
        if (ua.includes('opr')) {
            browser.name = 'Opera';
            const operaMatch = userAgent.match(/opr[\/\s](\d+[\.\d]*)/i);
            if (operaMatch) browser.version = operaMatch[1];
        } else if (ua.includes('brave')) {
            browser.name = 'Brave';
            const braveMatch = userAgent.match(/brave[\/\s](\d+[\.\d]*)/i);
            if (braveMatch) browser.version = braveMatch[1];
        } else {
            browser.name = 'Chrome';
            const chromeMatch = userAgent.match(/chrome[\/\s](\d+[\.\d]*)/i);
            if (chromeMatch) browser.version = chromeMatch[1];
        }
    }
    // Check for Edge
    else if (ua.includes('edg')) {
        browser.name = 'Microsoft Edge';
        const edgeMatch = userAgent.match(/edg[\/\s](\d+[\.\d]*)/i);
        if (edgeMatch) browser.version = edgeMatch[1];
    }
    // Check for Firefox
    else if (ua.includes('firefox')) {
        browser.name = 'Firefox';
        const firefoxMatch = userAgent.match(/firefox[\/\s](\d+[\.\d]*)/i);
        if (firefoxMatch) browser.version = firefoxMatch[1];
    }
    // Check for Safari
    else if (ua.includes('safari') && !ua.includes('chrome')) {
        browser.name = 'Safari';
        const safariMatch = userAgent.match(/version[\/\s](\d+[\.\d]*)/i);
        if (safariMatch) browser.version = safariMatch[1];
    }
    // Check for Internet Explorer
    else if (ua.includes('trident') || ua.includes('msie')) {
        browser.name = 'Internet Explorer';
        const ieMatch = userAgent.match(/(?:msie\s|rv:)(\d+[\.\d]*)/i);
        if (ieMatch) browser.version = ieMatch[1];
    }
    // Check for other streaming software
    else if (ua.includes('streamlabs')) {
        browser.name = 'Streamlabs';
        browser.type = 'Streaming Software';
    }
    else if (ua.includes('xsplit')) {
        browser.name = 'XSplit';
        browser.type = 'Streaming Software';
    }

    return browser;
}

// Rate limiting for debug operations
const debugRateLimit = createRateLimiter(60 * 1000, 60); // 60 requests per minute

// SocketHandler will be set by the server
let socketHandler = null;

// Method to set the SocketHandler instance
router.setSocketHandler = (handler) => {
    socketHandler = handler;
};

// Get debug dashboard data
router.get('/dashboard', 
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const [
            gameStatus,
            leaderboardStats,
            skinStats,
            dbHealth,
            twitchStatus
        ] = await Promise.all([
            GameService.getStatus(),
            LeaderboardService.getStats(),
            SkinService.getSkinStats(),
            DatabaseService.healthCheck(),
            Promise.resolve(TwitchService.getStatus())
        ]);

        res.json({
            status: 'success',
            data: {
                game: gameStatus,
                leaderboard: leaderboardStats,
                skins: skinStats,
                database: dbHealth,
                twitch: twitchStatus,
                timestamp: new Date().toISOString()
            }
        });
    })
);

// Simulate cone flip
router.post('/simulate/cone',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { 
            name = 'debug_user', 
            forceWin = null, 
            skin = null 
        } = req.body;

        // Add player to leaderboard if not exists
        await LeaderboardService.addPlayer(name);
        
        // Set skin if specified
        if (skin && SkinService.isValidSkin(skin)) {
            await SkinService.setSkin(name, skin);
        }

        // Simulate cone flip
        const result = await GameService.simulateCone(name, forceWin);
        
        logger.info('Debug cone simulation', { name, forceWin, result });
        
        res.json({
            status: 'success',
            message: `Simulated cone flip for ${name}`,
            data: result
        });
    })
);

// Simulate duel
router.post('/simulate/duel',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { 
            player1 = 'debug_user1', 
            player2 = 'debug_user2',
            forceWinner = null 
        } = req.body;

        // Add players to leaderboard if not exist
        await Promise.all([
            LeaderboardService.addPlayer(player1),
            LeaderboardService.addPlayer(player2)
        ]);

        // Simulate duel
        const result = await GameService.simulateDuel(player1, player2, forceWinner);
        
        logger.info('Debug duel simulation', { player1, player2, forceWinner, result });
        
        res.json({
            status: 'success',
            message: `Simulated duel: ${player1} vs ${player2}`,
            data: result
        });
    })
);

// Simulate skin unboxing
router.post('/simulate/unbox',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { 
            name = 'debug_user',
            forceSkin = null,
            count = 1
        } = req.body;

        const results = [];
        
        for (let i = 0; i < Math.min(count, 10); i++) {
            let result;
            if (forceSkin === '__trail__') {
                // Force a trail unbox
                result = await SkinService._handleTrailUnbox(name);
                result.forced = true;
            } else if (forceSkin && SkinService.isValidSkin(forceSkin)) {
                result = await SkinService.setSkin(name, forceSkin);
                await SkinService.addSkinToInventory(name, forceSkin, null, 1);
                result.forced = true;
            } else {
                result = await SkinService.setRandomSkin(name);
            }
            
            results.push(result);
            
            // Trigger the unbox animation on the /unbox page
            const chatMessage = result.message || (result.isTrailUnbox
                ? `@${name} unboxed a trail: ${result.trailName}!`
                : `@${name} unboxed ${result.skin} skin! (${result.rarity} Grade)`);

            if (result.isTrailUnbox) {
                await GameService.triggerUnboxAnimation(
                    name,
                    '__trail__',
                    chatMessage
                );
            } else if (result.success && result.skin) {
                await GameService.triggerUnboxAnimation(
                    name,
                    result.skin,
                    chatMessage
                );

                // BACKUP: Emit user skin update directly from here
                if (socketHandler && socketHandler.io) {
                    const availableSkins = SkinService.getAvailableSkinsMap();
                    const skinPath = availableSkins[result.skin] || '/skins/cone_default.png';

                    socketHandler.io.emit('userSkinUpdate', {
                        playerName: name,
                        skinName: result.skin,
                        skinPath: skinPath
                    });

                    logger.info(`🚀 BACKUP USER SKIN UPDATE EMITTED FROM DEBUG ROUTE: ${name} → ${result.skin}`);
                }

                // Add a small delay between animations if multiple unboxes
                if (count > 1 && i < count - 1) {
                    await new Promise(resolve => setTimeout(resolve, 6000)); // 6 second delay for animation
                }
            }
        }
        
        logger.info('Debug unbox simulation', { name, count, forceSkin, results });
        
        res.json({
            status: 'success',
            message: `Simulated ${count} unbox(es) for ${name}`,
            data: results
        });
    })
);

// Add test users to leaderboard
router.post('/populate/users',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { count = 10 } = req.body;
        const users = [];
        
        for (let i = 1; i <= Math.min(count, 50); i++) {
            const name = `test_user_${i}`;
            await LeaderboardService.addPlayer(name);
            
            // Simulate some games
            const wins = Math.floor(Math.random() * 20);
            const losses = Math.floor(Math.random() * 15);
            
            for (let w = 0; w < wins; w++) {
                await LeaderboardService.updatePlayer(name, true);
            }
            for (let l = 0; l < losses; l++) {
                await LeaderboardService.updatePlayer(name, false);
            }
            
            // Random skin
            await SkinService.setRandomSkin(name);
            
            users.push(name);
        }
        
        logger.info('Debug users populated', { count, users });
        
        res.json({
            status: 'success',
            message: `Created ${count} test users with random stats`,
            data: users
        });
    })
);

// Reset player stats
router.post('/reset/player',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Player name is required'
            });
        }

        const result = await LeaderboardService.resetPlayer(name);

        logger.info('Debug player reset', { name });

        res.json({
            status: 'success',
            message: `Reset stats for ${name}`,
            data: result
        });
    })
);

// NUCLEAR OPTION: Reset ALL player stats (scores, wins, losses) but keep skins
router.post('/reset/all-players',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        logger.warn('NUCLEAR RESET INITIATED - All player scores are about to be obliterated!');

        const result = await LeaderboardService.resetAllPlayers();

        logger.warn('NUCLEAR RESET COMPLETE', { playersAffected: result.playersAffected });

        // Emit a refresh event to update leaderboards
        if (socketHandler && socketHandler.io) {
            socketHandler.io.emit('leaderboardUpdate');
            socketHandler.io.emit('statsUpdate');
        }

        res.json({
            status: 'success',
            message: 'TACTICAL NUKE INCOMING! All player scores have been reset to 0.',
            data: result
        });
    })
);

// Trigger special events
router.post('/trigger/event',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { event, data = {} } = req.body;
        
        let result;
        
        switch (event) {
            case 'slow_motion':
                result = await GameService.triggerSlowMotion();
                break;
            case 'confetti':
                result = await GameService.triggerConfetti(data.position);
                break;
            case 'gold_celebration':
                result = await GameService.triggerGoldCelebration(data.name || 'debug_user');
                break;
            case 'restart_game':
                result = await GameService.restart();
                break;
            case 'show_leaderboard':
                result = await GameService.showLeaderboard(data.target);
                break;
            default:
                return res.status(400).json({
                    status: 'error',
                    message: `Unknown event: ${event}`
                });
        }
        
        logger.info('Debug event triggered', { event, data });
        
        res.json({
            status: 'success',
            message: `Triggered event: ${event}`,
            data: result
        });
    })
);

// Database operations
router.post('/database/backup',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const backup = await DatabaseService.createBackup();
        
        logger.info('Debug database backup created', backup);
        
        res.json({
            status: 'success',
            message: 'Database backup created',
            data: backup
        });
    })
);

router.get('/database/stats',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const stats = await DatabaseService.getStats();
        
        res.json({
            status: 'success',
            data: stats
        });
    })
);

// Clear caches
router.post('/cache/clear',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        LeaderboardService.clearCache();
        
        logger.info('Debug caches cleared');
        
        res.json({
            status: 'success',
            message: 'All caches cleared'
        });
    })
);

// Get system info
router.get('/system',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const systemInfo = {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            env: config.NODE_ENV,
            timestamp: new Date().toISOString()
        };
        
        res.json({
            status: 'success',
            data: systemInfo
        });
    })
);

// Token management endpoints
router.get('/token/current',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const currentToken = TokenService.getCurrentToken();
        const tokenInfo = TokenService.getTokenInfo(currentToken);
        
        res.json({
            status: 'success',
            data: {
                token: currentToken,
                info: tokenInfo
            }
        });
    })
);

router.post('/token/revoke',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const currentToken = TokenService.getCurrentToken();
        const newToken = TokenService.regenerateCurrentToken();
        
        logger.info('Token revoked via debug panel', { oldToken: currentToken.substring(0, 8), newToken: newToken.substring(0, 8) });
        
        // Broadcast token status update via WebSocket
        if (socketHandler) {
            socketHandler.broadcastTokenStatusUpdate();
        }
        
        res.json({
            status: 'success',
            message: 'Token revoked and regenerated',
            data: {
                newToken: newToken
            }
        });
    })
);

router.post('/sessions/revoke',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { socketId } = req.body;
        
        if (!socketId) {
            return res.status(400).json({
                status: 'error',
                message: 'Socket ID is required'
            });
        }
        
        if (!socketHandler) {
            return res.status(500).json({
                status: 'error',
                message: 'Socket handler not available'
            });
        }
        
        const clientInfo = socketHandler.getClientInfo(socketId);
        if (!clientInfo) {
            return res.status(404).json({
                status: 'error',
                message: 'Socket not found'
            });
        }
        
        // Notify the socket that their session was revoked
        const socket = socketHandler.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.emit('session_revoked', {
                reason: 'Manually revoked by admin',
                message: 'Your session has been manually revoked by an administrator'
            });
            
            // Clean up token association
            if (clientInfo.token) {
                TokenService.disconnectSocket(socketId);
                clientInfo.token = null;
                clientInfo.tokenAssociated = false;
                socketHandler.connectedClients.set(socketId, clientInfo);
            }
            
            logger.info(`Session manually revoked for socket ${socketId} by admin`);
            
            // Broadcast token status update
            socketHandler.broadcastTokenStatusUpdate();
            
            res.json({
                status: 'success',
                message: 'Session revoked successfully',
                data: { socketId }
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: 'Socket connection not found'
            });
        }
    })
);

router.get('/token/status',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const currentToken = TokenService.getCurrentToken();
        const tokenInfo = TokenService.getTokenInfo(currentToken);
        const isInUse = TokenService.isTokenInUse(currentToken);
        
        res.json({
            status: 'success',
            data: {
                token: currentToken,
                inUse: isInUse,
                info: tokenInfo
            }
        });
    })
);

router.get('/sessions/active',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const sessions = [];
        
        // Get socket handler stats if available
        if (socketHandler) {
            const connectedClients = socketHandler.connectedClients;

            for (const [socketId, clientInfo] of connectedClients) {
                if (clientInfo.tokenAssociated && clientInfo.token) {
                    const tokenInfo = TokenService.getTokenInfo(clientInfo.token);

                    // Parse browser info from this specific socket's user agent
                    const browserInfo = parseBrowserInfo(clientInfo.userAgent);

                    sessions.push({
                        socketId: socketId,
                        token: clientInfo.token.substring(0, 8) + '...',
                        connectedAt: clientInfo.connectedAt,
                        ip: clientInfo.ip,
                        tokenBoundToIp: tokenInfo?.ipAddress || null,
                        userAgent: clientInfo.userAgent,
                        browserInfo: browserInfo,
                        lastActivity: tokenInfo?.lastActivity || null,
                        sessionDuration: Math.round((Date.now() - clientInfo.connectedAt.getTime()) / 1000),
                        isAdmin: clientInfo.isAdmin
                    });
                }
            }
        }
        
        res.json({
            status: 'success',
            data: {
                activeSessions: sessions,
                totalSessions: sessions.length,
                timestamp: new Date().toISOString(),
                debug: {
                    hasSocketHandler: !!socketHandler,
                    connectedClientsCount: socketHandler ? socketHandler.connectedClients.size : 0
                }
            }
        });
    })
);

// Disconnect a specific session
router.post('/sessions/disconnect',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { socketId } = req.body;
        
        if (!socketId) {
            return res.status(400).json({
                status: 'error',
                message: 'Socket ID is required'
            });
        }
        
        if (!socketHandler) {
            return res.status(500).json({
                status: 'error',
                message: 'Socket handler not available'
            });
        }
        
        const clientInfo = socketHandler.getClientInfo(socketId);
        if (!clientInfo) {
            return res.status(404).json({
                status: 'error',
                message: 'Socket not found'
            });
        }
        
        // Get the socket connection
        const socket = socketHandler.io.sockets.sockets.get(socketId);
        if (socket) {
            // Store token info before cleanup for checking remaining sessions
            const token = clientInfo.token;
            
            // Check for remaining sessions BEFORE we disconnect this one
            let isLastSession = false;
            if (token) {
                const remainingSessions = Array.from(socketHandler.connectedClients.values())
                    .filter(client => client.token === token && client.tokenAssociated && client.socketId !== socketId);
                
                isLastSession = remainingSessions.length === 0;
                logger.info(`Found ${remainingSessions.length} other sessions using token ${token.substring(0, 8)}...`);
            }
            
            // Only clean up TokenService if this is the last session using the token
            if (token && isLastSession) {
                TokenService.disconnectSocket(socketId);
                logger.info(`Last session using token - cleaned up TokenService for socket ${socketId}`);
            } else if (token) {
                logger.info(`Other sessions still using token - only removing socket mapping for ${socketId}`);
                // Just remove this specific socket from the socketTokens map, don't touch the token's main data
                TokenService.removeSocketMapping(socketId);
            }
            
            // Disconnect the socket
            socket.disconnect(true);
            
            logger.info(`Session manually disconnected for socket ${socketId} by admin`);
            
            // Only broadcast token status update if this was the last session using the token
            if (token && isLastSession) {
                logger.info('This was the last session using the token, broadcasting status update');
                socketHandler.broadcastTokenStatusUpdate();
            } else if (token) {
                logger.info('Other sessions still using token, not broadcasting status update');
            }
            
            res.json({
                status: 'success',
                message: 'Session disconnected successfully',
                data: { socketId }
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: 'Socket connection not found'
            });
        }
    })
);

// Skin management endpoints (moderators can access)
router.get('/skins/list',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const availableSkins = SkinService.getAvailableSkinsMap();
        const skinConfig = SkinService.skinConfig || [];
        
        const skinList = Object.entries(availableSkins).map(([name, skinPath]) => {
            // skinPath is something like '/skins/cone_default.png' or '/skins/holo_darkmatter.jpg'
            // Extract just the filename from the path
            const filename = skinPath.replace('/skins/', '');
            
            // Determine if it's a holo skin based on filename
            const isHolo = filename.startsWith('holo_');
            
            // For doppler skins, add _1 for preview if not already specified
            let finalFilename = filename;
            if (filename === 'holo_doppler') {
                finalFilename = 'holo_doppler_1.jpg';
            }
            
            // Get config data for this skin
            const configData = skinConfig.find(skin => skin.name === name) || {};
            
            return {
                name: name, // Display name without prefix (e.g., 'default', 'darkmatter')
                filename: finalFilename,
                originalName: name, // Keep the original skin name for API calls
                isHolo: isHolo,
                enabled: true, // All skins in available map are enabled
                canUnbox: configData.canUnbox || false,
                unboxWeight: configData.unboxWeight || 0,
                rarity: SkinService.calculateRarity(configData.unboxWeight || 0),
                effect: SkinService.calculateEffect(configData)
            };
        });
        
        res.json({
            status: 'success',
            data: skinList
        });
    })
);

router.post('/skins/toggle',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { name, enabled } = req.body;
        
        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name is required'
            });
        }
        
        // For now, just log the action since we don't have enable/disable functionality
        logger.info(`Skin ${name} ${enabled ? 'enabled' : 'disabled'} via admin panel`);
        
        res.json({
            status: 'success',
            message: `Skin ${enabled ? 'enabled' : 'disabled'}`,
            data: { name, enabled }
        });
    })
);

router.post('/skins/delete',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { name } = req.body;
        
        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name is required'
            });
        }
        
        // Don't allow deletion of default/essential skins
        const protectedSkins = ['default', 'gold'];
        if (protectedSkins.includes(name)) {
            return res.status(400).json({
                status: 'error',
                message: 'Cannot delete protected skin'
            });
        }
        
        try {
            const fs = require('fs');
            const path = require('path');
            const configPath = path.join(process.cwd(), 'public', 'skins', 'config.json');
            
            // Read current config
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            // Find the skin to delete
            const skinIndex = configData.findIndex(skin => skin.name === name);
            if (skinIndex === -1) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Skin not found in configuration'
                });
            }
            
            const skinToDelete = configData[skinIndex];
            
            // Try to delete the skin file(s) - use basename to prevent path traversal
            const skinsDir = path.join(process.cwd(), 'public', 'skins');
            const skinFile = path.join(skinsDir, path.basename(skinToDelete.visuals));

            // Verify resolved path stays within skins directory
            if (!skinFile.startsWith(skinsDir)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Invalid skin file path'
                });
            }
            
            try {
                if (fs.existsSync(skinFile)) {
                    fs.unlinkSync(skinFile);
                    logger.info(`Deleted skin file: ${skinToDelete.visuals}`);
                }
            } catch (fileError) {
                logger.warn(`Failed to delete skin file ${skinToDelete.visuals}:`, fileError.message);
            }
            
            // Remove from config
            configData.splice(skinIndex, 1);
            
            // Write back to file
            fs.writeFileSync(configPath, JSON.stringify(configData, null, 4));
            
            // Reload skin system
            await SkinService.loadSkinConfiguration();
            
            // Emit refresh events to all connected clients
            const { socketHandler } = require('../websocket/socketHandler');
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('skinRefresh');
                socketHandler.io.emit('unboxConfigRefresh');
                logger.info('Emitted refresh events after skin deletion');
            }
            
            logger.info(`Skin ${name} deleted successfully via admin panel`);
            
            res.json({
                status: 'success',
                message: `Skin "${name}" deleted successfully`,
                data: { name, deletedFile: skinToDelete.visuals }
            });
            
        } catch (error) {
            logger.error('Failed to delete skin:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to delete skin: ' + error.message
            });
        }
    })
);

// Get submission queue
router.get('/skins/submissions',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const submissions = SubmissionService.getSubmissions('pending');
        
        res.json({
            status: 'success',
            data: submissions
        });
    })
);

router.post('/skins/submissions/approve',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { id, canUnbox, unboxWeight } = req.body;
        
        if (!id) {
            return res.status(400).json({
                status: 'error',
                message: 'Submission ID is required'
            });
        }
        
        const result = await SubmissionService.approveSubmission(id);
        
        if (result.success) {
            // Always emit refresh events after skin approval, regardless of config updates
            let configUpdated = false;
            
            // If custom config was provided, update the skin config
            if (canUnbox !== undefined && unboxWeight !== undefined) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const configPath = path.join(process.cwd(), 'public', 'skins', 'config.json');
                    
                    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    const skinIndex = configData.findIndex(skin => skin.name === result.data.skinName);
                    
                    if (skinIndex !== -1) {
                        configData[skinIndex].canUnbox = canUnbox;
                        configData[skinIndex].unboxWeight = canUnbox ? unboxWeight : 0;
                        
                        fs.writeFileSync(configPath, JSON.stringify(configData, null, 4));
                        
                        logger.info(`Updated approved skin config for ${result.data.skinName}:`, { canUnbox, unboxWeight });
                        
                        // Reload skin system to pick up the config changes
                        await SkinService.loadSkinConfiguration();
                        configUpdated = true;
                    }
                } catch (error) {
                    logger.error('Failed to update approved skin config:', error);
                }
            }
            
            // Always emit refresh events after skin approval (the skin was already added by SubmissionService)
            const { socketHandler } = require('../websocket/socketHandler');
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('skinRefresh');
                socketHandler.io.emit('unboxConfigRefresh');
                logger.info(`Emitted refresh events after skin approval for ${result.data.skinName}${configUpdated ? ' (with config update)' : ''}`);
            }
            
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    })
);

// Update submission name
router.post('/skins/submissions/update-name',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { id, newName } = req.body;
        
        if (!id || !newName) {
            return res.status(400).json({
                status: 'error',
                message: 'Submission ID and new name are required'
            });
        }
        
        // Check for duplicate names
        if (SubmissionService.checkDuplicateName(newName)) {
            return res.status(400).json({
                status: 'error',
                message: 'A submission with this name already exists'
            });
        }
        
        const result = await SubmissionService.updateSubmissionName(id, newName.trim());
        
        if (result) {
            res.json({
                status: 'success',
                message: 'Submission name updated successfully',
                data: result
            });
        } else {
            res.status(404).json({
                status: 'error',
                message: 'Submission not found'
            });
        }
    })
);

// Rename a skin
router.post('/skins/rename',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        const { oldName, newName } = req.body;
        
        if (!oldName || !newName) {
            return res.status(400).json({
                status: 'error',
                message: 'Both old name and new name are required'
            });
        }
        
        if (oldName === newName) {
            return res.json({
                status: 'success',
                message: 'Name unchanged'
            });
        }
        
        try {
            const fs = require('fs');
            const path = require('path');
            const configPath = path.join(process.cwd(), 'public', 'skins', 'config.json');
            
            // Read current config
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            // Check if old skin exists
            const skinIndex = configData.findIndex(skin => skin.name === oldName);
            if (skinIndex === -1) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Original skin not found'
                });
            }
            
            // Check if new name already exists
            const existingSkin = configData.find(skin => skin.name === newName);
            if (existingSkin) {
                return res.status(400).json({
                    status: 'error',
                    message: 'A skin with the new name already exists'
                });
            }
            
            // Update the skin name
            configData[skinIndex].name = newName;
            
            // Write back to file
            fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
            
            // Reload skin system
            await SkinService.loadSkinConfiguration();
            
            // Emit refresh events to all connected clients
            const { socketHandler } = require('../websocket/socketHandler');
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('skinRefresh');
                socketHandler.io.emit('unboxConfigRefresh');
            }
            
            logger.info(`Skin renamed from ${oldName} to ${newName}`);
            
            res.json({
                status: 'success',
                message: `Skin renamed from "${oldName}" to "${newName}"`,
                data: { oldName, newName }
            });
            
        } catch (error) {
            logger.error('Failed to rename skin:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to rename skin: ' + error.message
            });
        }
    })
);

// Emit refresh events to all connected clients
router.post('/emit-refresh',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        try {
            const { socketHandler } = require('../websocket/socketHandler');
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('skinRefresh');
                socketHandler.io.emit('unboxConfigRefresh');
                
                logger.info('Emitted refresh events to all connected clients');
                
                res.json({
                    status: 'success',
                    message: 'Refresh events emitted successfully'
                });
            } else {
                res.status(500).json({
                    status: 'error',
                    message: 'WebSocket not available'
                });
            }
        } catch (error) {
            logger.error('Failed to emit refresh events:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to emit refresh events'
            });
        }
    })
);

router.post('/skins/submissions/reject',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { id, reason } = req.body;
        
        if (!id) {
            return res.status(400).json({
                status: 'error',
                message: 'Submission ID is required'
            });
        }
        
        // Check if this is a contest submission before rejecting
        const submission = SubmissionService.getSubmissionById(id);
        let warningMessage = '';
        
        if (submission && submission.contest) {
            warningMessage = ' ⚠️ WARNING: This was a contest submission and has been removed from the contest.';
            
            // Remove contest flag from submission
            submission.contest = false;
            submission.updatedAt = new Date().toISOString();
            await SubmissionService.saveSubmissions();
            
            // Remove any votes for this contest submission
            try {
                const databaseService = require('../services/databaseService');
                await databaseService.run('DELETE FROM contest_votes WHERE submission_id = ?', [id]);
                logger.info('Contest votes removed for rejected submission:', { submissionId: id, name: submission.name });
            } catch (error) {
                logger.error('Error removing contest votes for rejected submission:', error);
            }
        }
        
        const result = await SubmissionService.rejectSubmission(id, reason);
        
        if (result.success) {
            res.json({
                status: 'success',
                message: result.message + warningMessage,
                data: result.data,
                wasContestSubmission: submission?.contest || false
            });
        } else {
            res.status(400).json({
                status: 'error',
                message: result.message
            });
        }
    })
);

// Get skin configuration
router.get('/skins/config',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        // Get the skin configuration data
        const skinConfig = SkinService.skinConfig || [];
        
        res.json({
            status: 'success',
            data: skinConfig
        });
    })
);

// Update skin configuration
router.post('/skins/config/update',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { name, canUnbox, unboxWeight } = req.body;
        
        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name is required'
            });
        }
        
        // Read current config
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(process.cwd(), 'public', 'skins', 'config.json');
        
        try {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            // Find and update the skin
            const skinIndex = configData.findIndex(skin => skin.name === name);
            if (skinIndex === -1) {
                return res.status(404).json({
                    status: 'error',
                    message: 'Skin not found'
                });
            }
            
            // Update skin properties
            configData[skinIndex].canUnbox = canUnbox;
            configData[skinIndex].unboxWeight = canUnbox ? unboxWeight : 0;
            
            // Write back to file
            fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
            
            // Reload skin system to update cached configuration
            await SkinService.loadSkinConfiguration();
            
            // Emit refresh events to all connected clients
            const { socketHandler } = require('../websocket/socketHandler');
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('skinRefresh');
                socketHandler.io.emit('unboxConfigRefresh');
            }
            
            logger.info(`Updated skin config for ${name}:`, { canUnbox, unboxWeight });
            
            res.json({
                status: 'success',
                message: 'Skin configuration updated and reloaded',
                data: { name, canUnbox, unboxWeight }
            });
        } catch (error) {
            logger.error('Failed to update skin config:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to update skin configuration'
            });
        }
    })
);

// Reload skin system
router.post('/skins/reload',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            await SkinService.loadSkinConfiguration();

            logger.info('Skin system reloaded via admin panel');

            res.json({
                status: 'success',
                message: 'Skin system reloaded successfully'
            });
        } catch (error) {
            logger.error('Failed to reload skin system:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to reload skin system'
            });
        }
    })
);

// Get current seasonal skin
router.get('/skins/seasonal',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const seasonalSkin = SkinService.getSeasonalSkin();

        res.json({
            status: 'success',
            data: {
                seasonalSkin: seasonalSkin,
                isActive: !!seasonalSkin
            }
        });
    })
);

// Set seasonal skin
router.post('/skins/seasonal',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { skinName } = req.body;

        try {
            const result = await SkinService.setSeasonalSkin(skinName || null);

            logger.info(`Seasonal skin ${skinName ? 'set to ' + skinName : 'cleared'} via admin panel`);

            res.json({
                status: 'success',
                message: skinName
                    ? `Seasonal skin set to "${skinName}". All users now have access to this skin.`
                    : `Seasonal skin cleared. Users who had it selected have been reset to default.`,
                data: result
            });
        } catch (error) {
            logger.error('Failed to set seasonal skin:', error);
            res.status(400).json({
                status: 'error',
                message: error.message || 'Failed to set seasonal skin'
            });
        }
    })
);

// Clear seasonal skin
router.delete('/skins/seasonal',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const result = await SkinService.setSeasonalSkin(null);

            logger.info('Seasonal skin cleared via admin panel');

            res.json({
                status: 'success',
                message: 'Seasonal skin cleared. Users who had it selected have been reset to default.',
                data: result
            });
        } catch (error) {
            logger.error('Failed to clear seasonal skin:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to clear seasonal skin'
            });
        }
    })
);

// Announcement management endpoints (moderators can access)
router.get('/announcement',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const announcementPath = path.join(process.cwd(), 'public', 'announcement.json');
            
            if (fs.existsSync(announcementPath)) {
                const announcement = JSON.parse(fs.readFileSync(announcementPath, 'utf8'));
                res.json({ status: 'success', data: announcement });
            } else {
                res.json({ status: 'success', data: { enabled: false, content: "", updatedAt: null, updatedBy: null } });
            }
        } catch (error) {
            logger.error('Error getting announcement:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get announcement' });
        }
    })
);

router.post('/announcement',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const { enabled, content } = req.body;
            const fs = require('fs');
            const path = require('path');
            const announcementPath = path.join(process.cwd(), 'public', 'announcement.json');
            
            // Strip HTML tags from content to prevent XSS
            const sanitizedContent = String(content || '').replace(/<[^>]*>/g, '');

            const announcementData = {
                enabled: Boolean(enabled),
                content: sanitizedContent,
                updatedAt: new Date().toISOString(),
                updatedBy: 'admin'
            };
            
            fs.writeFileSync(announcementPath, JSON.stringify(announcementData, null, 2));
            
            // Emit refresh event to all connected clients
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('announcementUpdate', announcementData);
            }
            
            logger.info('Announcement updated:', { enabled, contentLength: content?.length || 0 });
            res.json({ status: 'success', data: announcementData });
        } catch (error) {
            logger.error('Error updating announcement:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update announcement' });
        }
    })
);

// Public announcement endpoint (no auth required)
router.get('/announcement/public',
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const announcementPath = path.join(process.cwd(), 'public', 'announcement.json');
            
            if (fs.existsSync(announcementPath)) {
                const announcement = JSON.parse(fs.readFileSync(announcementPath, 'utf8'));
                res.json({ status: 'success', data: announcement });
            } else {
                res.json({ status: 'success', data: { enabled: false, content: "" } });
            }
        } catch (error) {
            logger.error('Error getting public announcement:', error);
            res.json({ status: 'success', data: { enabled: false, content: "" } });
        }
    })
);

// Sound volume settings
router.get('/settings/volume',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const settingsPath = path.join(process.cwd(), 'public', 'settings.json');

            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                res.json({ status: 'success', data: { volume: settings.volume ?? 100 } });
            } else {
                res.json({ status: 'success', data: { volume: 100 } });
            }
        } catch (error) {
            logger.error('Error getting volume setting:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get volume setting' });
        }
    })
);

router.post('/settings/volume',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        try {
            const { volume } = req.body;
            const fs = require('fs');
            const path = require('path');
            const settingsPath = path.join(process.cwd(), 'public', 'settings.json');

            // Read existing settings or create new
            let settings = {};
            if (fs.existsSync(settingsPath)) {
                settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            }

            // Update volume (clamp between 0 and 100)
            settings.volume = Math.max(0, Math.min(100, Number(volume) || 100));
            settings.updatedAt = new Date().toISOString();

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

            // Emit volume update to all connected clients
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('volumeUpdate', { volume: settings.volume });
            }

            logger.info(`Sound volume set to ${settings.volume}%`);
            res.json({ status: 'success', data: { volume: settings.volume } });
        } catch (error) {
            logger.error('Error setting volume:', error);
            res.status(500).json({ status: 'error', message: 'Failed to set volume' });
        }
    })
);

// Public endpoint to get volume (no auth required)
router.get('/settings/volume/public',
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const settingsPath = path.join(process.cwd(), 'public', 'settings.json');

            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                res.json({ volume: settings.volume ?? 100 });
            } else {
                res.json({ volume: 100 });
            }
        } catch (error) {
            res.json({ volume: 100 });
        }
    })
);

// Contest management endpoints (moderators can access)
router.get('/contest',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            if (fs.existsSync(contestPath)) {
                const contest = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
                res.json({ status: 'success', data: contest });
            } else {
                res.json({ status: 'success', data: { enabled: false, prize: "", description: "", allowSubmissions: false, updatedAt: null, updatedBy: null } });
            }
        } catch (error) {
            logger.error('Error getting contest:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get contest' });
        }
    })
);

router.post('/contest',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const { enabled, prize, description, allowSubmissions } = req.body;
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            const contestData = {
                enabled: Boolean(enabled),
                prize: String(prize || ''),
                description: String(description || ''),
                allowSubmissions: Boolean(allowSubmissions),
                updatedAt: new Date().toISOString(),
                updatedBy: 'admin'
            };
            
            fs.writeFileSync(contestPath, JSON.stringify(contestData, null, 2));
            
            // Emit refresh event to all connected clients
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('contestUpdate', contestData);
            }
            
            logger.info('Contest updated:', { enabled, allowSubmissions, prizeLength: prize?.length || 0 });
            res.json({ status: 'success', data: contestData });
        } catch (error) {
            logger.error('Error updating contest:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update contest' });
        }
    })
);

// Public contest endpoint (no auth required)
router.get('/contest/public',
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            if (fs.existsSync(contestPath)) {
                const contest = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
                res.json({ status: 'success', data: contest });
            } else {
                res.json({ status: 'success', data: { enabled: false, prize: "", description: "", allowSubmissions: false } });
            }
        } catch (error) {
            logger.error('Error getting public contest:', error);
            res.json({ status: 'success', data: { enabled: false, prize: "", description: "", allowSubmissions: false } });
        }
    })
);

// Remove submission from contest
router.post('/contest/remove',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        try {
            const { submissionId } = req.body;
            
            if (!submissionId) {
                return res.status(400).json({ status: 'error', message: 'Submission ID is required' });
            }
            
            const submissionService = require('../services/submissionService');
            const submission = submissionService.getSubmissionById(submissionId);
            
            if (!submission) {
                return res.status(404).json({ status: 'error', message: 'Submission not found' });
            }
            
            // Remove contest flag from submission
            submission.contest = false;
            submission.updatedAt = new Date().toISOString();
            await submissionService.saveSubmissions();
            
            // Also remove any existing votes for this submission
            const databaseService = require('../services/databaseService');
            await databaseService.run('DELETE FROM contest_votes WHERE submission_id = ?', [submissionId]);
            
            logger.info('Submission removed from contest:', { submissionId, name: submission.name });
            res.json({ status: 'success', message: 'Submission removed from contest successfully' });
            
        } catch (error) {
            logger.error('Error removing submission from contest:', error);
            res.status(500).json({ status: 'error', message: 'Failed to remove submission from contest' });
        }
    })
);

// Reset contest database
router.post('/contest/reset',
    requireDebugAuth,
    asyncHandler(async (req, res) => {
        try {
            const databaseService = require('../services/databaseService');

            // Delete all contest votes
            await databaseService.run('DELETE FROM contest_votes');

            logger.info('Contest database reset - all votes cleared');
            res.json({ status: 'success', message: 'Contest database reset successfully' });

        } catch (error) {
            logger.error('Error resetting contest database:', error);
            res.status(500).json({ status: 'error', message: 'Failed to reset contest database' });
        }
    })
);

// Follow reward management endpoints
router.get('/follow-reward',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const setupPath = path.join(process.cwd(), 'data', 'setup.json');

            let followRewardSettings = {
                enabled: false,
                chatEnabled: true,
                message: '@{user} thanks for following! Enjoy a free coneflip!'
            };

            if (fs.existsSync(setupPath)) {
                const setupConfig = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
                followRewardSettings = {
                    enabled: setupConfig.FOLLOW_REWARD_ENABLED === true || setupConfig.FOLLOW_REWARD_ENABLED === 'true',
                    chatEnabled: setupConfig.FOLLOW_REWARD_CHAT_ENABLED !== false && setupConfig.FOLLOW_REWARD_CHAT_ENABLED !== 'false',
                    message: setupConfig.FOLLOW_REWARD_MESSAGE || '@{user} thanks for following! Enjoy a free coneflip!'
                };
            }

            res.json({ status: 'success', data: followRewardSettings });
        } catch (error) {
            logger.error('Error getting follow reward settings:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get follow reward settings' });
        }
    })
);

router.post('/follow-reward',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const { enabled, chatEnabled, message } = req.body;
            const fs = require('fs');
            const path = require('path');
            const { reloadConfig } = require('../config/environment');
            const setupPath = path.join(process.cwd(), 'data', 'setup.json');

            // Read existing setup config
            let setupConfig = {};
            if (fs.existsSync(setupPath)) {
                setupConfig = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
            }

            // Update follow reward settings
            setupConfig.FOLLOW_REWARD_ENABLED = Boolean(enabled);
            setupConfig.FOLLOW_REWARD_CHAT_ENABLED = Boolean(chatEnabled);
            setupConfig.FOLLOW_REWARD_MESSAGE = String(message || '@{user} thanks for following! Enjoy a free coneflip!');

            // Write back to file
            fs.writeFileSync(setupPath, JSON.stringify(setupConfig, null, 2));

            // Reload config to apply changes
            reloadConfig();

            logger.info('Follow reward settings updated:', { enabled, chatEnabled, messageLength: message?.length || 0 });

            res.json({
                status: 'success',
                data: {
                    enabled: setupConfig.FOLLOW_REWARD_ENABLED,
                    chatEnabled: setupConfig.FOLLOW_REWARD_CHAT_ENABLED,
                    message: setupConfig.FOLLOW_REWARD_MESSAGE
                }
            });
        } catch (error) {
            logger.error('Error updating follow reward settings:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update follow reward settings' });
        }
    })
);

// Level up chat message settings
router.get('/level-up-chat',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const setupPath = path.join(process.cwd(), 'data', 'setup.json');

            let enabled = false;

            if (fs.existsSync(setupPath)) {
                const setupConfig = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
                enabled = setupConfig.LEVEL_UP_CHAT_ENABLED === true || setupConfig.LEVEL_UP_CHAT_ENABLED === 'true';
            }

            res.json({ status: 'success', data: { enabled } });
        } catch (error) {
            logger.error('Error getting level up chat settings:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get level up chat settings' });
        }
    })
);

router.post('/level-up-chat',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        try {
            const { enabled } = req.body;
            const fs = require('fs');
            const path = require('path');
            const { reloadConfig } = require('../config/environment');
            const setupPath = path.join(process.cwd(), 'data', 'setup.json');

            // Read existing setup config
            let setupConfig = {};
            if (fs.existsSync(setupPath)) {
                setupConfig = JSON.parse(fs.readFileSync(setupPath, 'utf8'));
            }

            // Update level up chat setting
            setupConfig.LEVEL_UP_CHAT_ENABLED = enabled === true || enabled === 'true';

            // Write back to setup.json
            fs.writeFileSync(setupPath, JSON.stringify(setupConfig, null, 2));

            // Reload config to apply changes
            reloadConfig();

            logger.info('Level up chat settings updated:', { enabled: setupConfig.LEVEL_UP_CHAT_ENABLED });

            res.json({
                status: 'success',
                data: { enabled: setupConfig.LEVEL_UP_CHAT_ENABLED }
            });
        } catch (error) {
            logger.error('Error updating level up chat settings:', error);
            res.status(500).json({ status: 'error', message: 'Failed to update level up chat settings' });
        }
    })
);

// Player management endpoints (moderators can access)

// Search players
router.get('/players/search',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { q: searchTerm, limit = 20 } = req.query;

        if (!searchTerm || searchTerm.trim().length < 1) {
            return res.status(400).json({
                status: 'error',
                message: 'Search term is required'
            });
        }

        const results = await LeaderboardService.searchPlayers(searchTerm, parseInt(limit));

        res.json({
            status: 'success',
            data: results
        });
    })
);

// Get player details
router.get('/players/:name',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const name = req.params.name.toLowerCase().trim();
        const playerData = await LeaderboardService.getPlayer(name);

        res.json({
            status: 'success',
            data: playerData
        });
    })
);

// Edit player stats
router.post('/players/edit',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { name, stats } = req.body;

        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Player name is required'
            });
        }

        if (!stats || typeof stats !== 'object') {
            return res.status(400).json({
                status: 'error',
                message: 'Stats object is required'
            });
        }

        try {
            const result = await LeaderboardService.editPlayerStats(name, stats);

            // Emit leaderboard update to all clients
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('leaderboardUpdate');
                socketHandler.io.emit('statsUpdate');
            }

            logger.info(`Player stats edited via mod panel: ${name}`, stats);

            res.json({
                status: 'success',
                message: result.message,
                data: result.data
            });
        } catch (error) {
            logger.error(`Failed to edit player stats for ${name}:`, error);
            res.status(400).json({
                status: 'error',
                message: error.message || 'Failed to edit player stats'
            });
        }
    })
);

// Delete player
router.post('/players/delete',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({
                status: 'error',
                message: 'Player name is required'
            });
        }

        try {
            const result = await LeaderboardService.deletePlayer(name);

            // Emit leaderboard update to all clients
            if (socketHandler && socketHandler.io) {
                socketHandler.io.emit('leaderboardUpdate');
                socketHandler.io.emit('statsUpdate');
            }

            logger.info(`Player deleted via mod panel: ${name}`);

            res.json({
                status: 'success',
                message: result.message
            });
        } catch (error) {
            logger.error(`Failed to delete player ${name}:`, error);
            res.status(400).json({
                status: 'error',
                message: error.message || 'Failed to delete player'
            });
        }
    })
);

// Get all players (paginated)
router.get('/players',
    requireModeratorAuth,
    asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const sortBy = req.query.sortBy === 'level' ? 'level' : 'points';

        const leaderboard = await LeaderboardService.getLeaderboard(page, limit, sortBy);

        res.json({
            status: 'success',
            data: leaderboard.data,
            pagination: leaderboard.pagination
        });
    })
);

module.exports = router; 