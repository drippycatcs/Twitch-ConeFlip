const logger = require('../utils/logger');

class SocketHandler {
    constructor(io) {
        this.io = io;
        this.connectedClients = new Map();
        this.adminClients = new Set(); // track admin connections
        this.processedCones = new Set(); // Track cone IDs that have already been processed
    }

    // Check if cone result was already processed (deduplication)
    isConeAlreadyProcessed(coneId) {
        if (!coneId) return false;
        if (this.processedCones.has(coneId)) {
            logger.warn(`Duplicate cone result ignored: ${coneId}`);
            return true;
        }
        this.processedCones.add(coneId);
        // Clean up old entries after 60 seconds
        setTimeout(() => this.processedCones.delete(coneId), 60000);
        return false;
    }

    async initialize() {
        this.setupEventHandlers();
        logger.info('SocketHandler initialized');
    }

    setupEventHandlers() {
        this.io.on('connection', (socket) => {
            this.handleConnection(socket);
        });
    }

    handleConnection(socket) {
        // Get real client IP (handle proxies and IPv6)
        let clientIp = socket.handshake.address;
        
        // Check for forwarded headers (proxy/load balancer)
        if (socket.handshake.headers['x-forwarded-for']) {
            clientIp = socket.handshake.headers['x-forwarded-for'].split(',')[0].trim();
        } else if (socket.handshake.headers['x-real-ip']) {
            clientIp = socket.handshake.headers['x-real-ip'].trim();
        } else if (socket.handshake.headers['cf-connecting-ip']) {
            // Cloudflare
            clientIp = socket.handshake.headers['cf-connecting-ip'].trim();
        }
        
        // Convert IPv6 localhost to IPv4 for consistency
        if (clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
            clientIp = '127.0.0.1';
        }
        
        // Extract IPv4 from IPv6-mapped addresses
        if (clientIp.startsWith('::ffff:')) {
            clientIp = clientIp.substring(7);
        }

        const clientInfo = {
            id: socket.id,
            connectedAt: new Date(),
            ip: clientIp,
            userAgent: socket.handshake.headers['user-agent'],
            isAdmin: false,
            token: null,
            tokenAssociated: false
        };

        this.connectedClients.set(socket.id, clientInfo);
        
        logger.info(`Client connected: ${socket.id}`, {
            ip: clientInfo.ip,
            userAgent: clientInfo.userAgent
        });

        // Token association for game clients
        socket.on('associate_token', (data) => {
            logger.info(`Token association request from ${socket.id}`, { data });
            
            const { token } = data;
            if (!token) {
                logger.warn(`No token provided by ${socket.id}`);
                socket.emit('token_associated', { success: false, error: 'No token provided' });
                return;
            }
            
            const TokenService = require('../services/tokenService');
            
            logger.info(`Attempting to associate token ${token.substring(0, 8)}... with socket ${socket.id}`);
            
            try {
                const result = TokenService.associateTokenWithSocket(token, socket.id, clientInfo.userAgent, clientInfo.ip);
                
                logger.info(`Token association result for ${socket.id}:`, result);
                
                if (result.success) {
                    clientInfo.token = token;
                    clientInfo.tokenAssociated = true;
                    this.connectedClients.set(socket.id, clientInfo);
                    
                    socket.emit('token_associated', { success: true });
                    logger.info(`✅ Token associated with socket: ${socket.id}`);
                    
                    // Notify admins of token status change
                    this.broadcastTokenStatusUpdate();
                } else {
                    socket.emit('token_associated', { success: false, error: result.error });
                    logger.warn(`❌ Token association failed for ${socket.id}: ${result.error}`);
                }
            } catch (error) {
                logger.error(`Error during token association for ${socket.id}:`, error);
                socket.emit('token_associated', { success: false, error: 'Internal server error' });
            }
        });

        // client events
        socket.on('disconnect', (reason) => {
            this.handleDisconnection(socket, reason);
        });

        socket.on('ping', () => {
            socket.emit('pong', { timestamp: Date.now() });
        });

        // admin auth with brute-force protection
        let adminAuthAttempts = 0;
        socket.on('admin_auth', (password) => {
            if (adminAuthAttempts >= 5) {
                socket.emit('admin_authenticated', { success: false, error: 'Too many failed attempts. Reconnect to try again.' });
                return;
            }
            const { config } = require('../config/environment');
            if (password === config.DEBUG_PASSWORD) {
                clientInfo.isAdmin = true;
                this.adminClients.add(socket.id);
                socket.join('admin_room');
                socket.emit('admin_authenticated', { success: true });
                logger.info(`Client ${socket.id} authenticated as admin`);
            } else {
                adminAuthAttempts++;
                socket.emit('admin_authenticated', { success: false, error: 'wrong password' });
                logger.warn(`Failed admin auth attempt ${adminAuthAttempts}/5 from ${socket.id}`);
            }
        });

        // room management - block non-admin clients from joining admin_room
        socket.on('join_room', (room) => {
            if (typeof room === 'string' && room.length < 50) {
                if (room === 'admin_room' && !clientInfo.isAdmin) {
                    logger.warn(`Non-admin client ${socket.id} tried to join admin_room`);
                    return;
                }
                socket.join(room);
                logger.info(`Client ${socket.id} joined room: ${room}`);
            }
        });

        socket.on('leave_room', (room) => {
            if (typeof room === 'string') {
                socket.leave(room);
                logger.info(`Client ${socket.id} left room: ${room}`);
            }
        });

        // game events from client
        socket.on('game_event', (data) => {
            if (clientInfo.isAdmin) {
                // admins can send game events
                this.broadcastGameUpdate(data);
            }
        });

        // Handle cone win/fail results from authenticated clients
        socket.on('win', async (data) => {
            // Support both old format (string) and new format (object with coneId)
            const playerName = typeof data === 'string' ? data : data.playerName;
            const coneId = typeof data === 'object' ? data.coneId : null;

            if (!clientInfo.tokenAssociated) {
                logger.warn(`Unauthorized win event from ${socket.id} for player ${playerName}`);
                return;
            }

            // Deduplicate by coneId if provided
            if (coneId && this.isConeAlreadyProcessed(coneId)) {
                return;
            }

            logger.info(`Processing win for ${playerName} from socket ${socket.id}${coneId ? ` (cone: ${coneId})` : ''}`);

            try {
                const GameService = require('../services/gameService');
                await GameService.handleWin(playerName, 'coneflip');
                logger.info(`✅ Win processed successfully for ${playerName}`);
            } catch (error) {
                logger.error(`Failed to process win for ${playerName}:`, error);
            }
        });

        // Handle duel win events and announce in Twitch chat
        socket.on('duel_win', async (data) => {
            if (!clientInfo.tokenAssociated) {
                logger.warn(`Unauthorized duel_win event from ${socket.id}`);
                return;
            }

            const { winner, loser, duelId } = data;

            // Deduplicate by duelId if provided
            if (duelId && this.isConeAlreadyProcessed(duelId)) {
                return;
            }

            logger.info(`Processing duel win: ${winner} defeated ${loser} from socket ${socket.id}${duelId ? ` (duel: ${duelId})` : ''}`);
            
            try {
                // Process the duel win/loss stats (all duels go through frontend physics now)
                const GameService = require('../services/gameService');
                await GameService.handleWin(winner, 'duel');
                await GameService.handleLoss(loser, 'duel');
                logger.info(`✅ Duel stats processed: ${winner} won, ${loser} lost`);
                
                // Send chat announcement
                const TwitchService = require('../services/twitchService');
                if (TwitchService && TwitchService.sendChatMessage) {
                    const message = `maxwin ${winner} defeated ${loser} in a cone duel`;
                    await TwitchService.sendChatMessage(message);
                    logger.info(`✅ Duel winner announced in chat: ${message}`);
                } else {
                    logger.warn('TwitchService not available for duel announcement');
                }
            } catch (error) {
                logger.error(`Failed to process duel win:`, error);
            }
        });

        socket.on('fail', async (data) => {
            // Support both old format (string) and new format (object with coneId)
            const playerName = typeof data === 'string' ? data : data.playerName;
            const coneId = typeof data === 'object' ? data.coneId : null;

            if (!clientInfo.tokenAssociated) {
                logger.warn(`Unauthorized fail event from ${socket.id} for player ${playerName}`);
                return;
            }

            // Deduplicate by coneId if provided
            if (coneId && this.isConeAlreadyProcessed(coneId)) {
                return;
            }

            logger.info(`Processing fail for ${playerName} from socket ${socket.id}${coneId ? ` (cone: ${coneId})` : ''}`);

            try {
                const GameService = require('../services/gameService');
                await GameService.handleLoss(playerName, 'coneflip');
                logger.info(`✅ Fail processed successfully for ${playerName}`);
            } catch (error) {
                logger.error(`Failed to process fail for ${playerName}:`, error);
            }
        });

        socket.on('upside_down', async (data) => {
            if (!clientInfo.tokenAssociated) {
                logger.warn(`Unauthorized upside down event from ${socket.id} for player ${data.playerName}`);
                return;
            }

            const { playerName, gameType = 'coneflip', loserName, coneId } = data;

            // Deduplicate by coneId if provided
            if (coneId && this.isConeAlreadyProcessed(coneId)) {
                return;
            }

            logger.info(`Processing upside down ${gameType} win for ${playerName}${loserName ? ` vs ${loserName}` : ''} from socket ${socket.id}${coneId ? ` (cone: ${coneId})` : ''}`);
            
            try {
                const GameService = require('../services/gameService');
                const result = await GameService.handleUpsideDown(playerName, gameType, loserName);
                
                const winPoints = gameType === 'duel' ? 10 : 5;
                
                // Emit to all clients for celebration
                this.io.emit('upside_down', { 
                    winner: playerName,
                    loser: loserName,
                    gameType,
                    winPoints,
                    lossPoints: loserName ? -10 : 0,
                    newWinnerPoints: result.winner.points,
                    newLoserPoints: result.loser ? result.loser.points : null
                });
                
                logger.info(`✅ Upside down processed: ${playerName} +${winPoints}${loserName ? `, ${loserName} -10` : ''}`);
            } catch (error) {
                logger.error(`Failed to process upside down for ${playerName}:`, error);
            }
        });

        // Handle unbox animation finished from overlay client
        socket.on('unboxfinished', async (unboxId) => {
            if (typeof unboxId !== 'string' || !unboxId.startsWith('unbox_')) {
                logger.warn(`Invalid unboxfinished event from ${socket.id}: ${unboxId}`);
                return;
            }

            try {
                const GameService = require('../services/gameService');
                const completed = await GameService.completeUnbox(unboxId);
                if (completed) {
                    logger.info(`Unbox animation confirmed: ${unboxId}`);
                } else {
                    logger.warn(`Unbox complete rejected for ${unboxId} from ${socket.id}`);
                }
            } catch (error) {
                logger.error(`Failed to process unboxfinished for ${unboxId}:`, error);
            }
        });

        // Send welcome message
        socket.emit('connected', {
            message: 'Connected to ConeFlip server',
            timestamp: Date.now()
        });
    }

    handleDisconnection(socket, reason) {
        const clientInfo = this.connectedClients.get(socket.id);
        
        if (clientInfo) {
            const sessionDuration = Date.now() - clientInfo.connectedAt.getTime();
            logger.info(`Client disconnected: ${socket.id}`, {
                reason,
                sessionDuration: `${Math.round(sessionDuration / 1000)}s`,
                hadToken: !!clientInfo.token
            });
            
            // cleanup admin status
            if (clientInfo.isAdmin) {
                this.adminClients.delete(socket.id);
            }
            
            // cleanup token association
            if (clientInfo.tokenAssociated && clientInfo.token) {
                const TokenService = require('../services/tokenService');
                TokenService.disconnectSocket(socket.id);
                logger.info(`Token ${clientInfo.token.substring(0, 8)}... released from socket ${socket.id}`);
                
                // Notify admins of token status change
                this.broadcastTokenStatusUpdate();
            }
            
            this.connectedClients.delete(socket.id);
        }
    }

    // broadcast stuff
    broadcastGameUpdate(data) {
        this.io.emit('game_update', data);
    }

    broadcastToRoom(room, event, data) {
        this.io.to(room).emit(event, data);
    }

    broadcastTokenStatusUpdate() {
        const TokenService = require('../services/tokenService');
        const currentToken = TokenService.getCurrentToken();
        const tokenInfo = TokenService.getTokenInfo(currentToken);
        const isInUse = TokenService.isTokenInUse(currentToken);

        this.io.to('admin_room').emit('tokenStatusUpdate', {
            token: currentToken,
            inUse: isInUse,
            info: tokenInfo
        });
    }

    // Force refresh all connected clients - for server restarts
    forceRefreshAllClients() {
        logger.info(`🔄 Sending forceRefresh to ALL ${this.connectedClients.size} connected clients`);
        this.io.emit('forceRefresh', {
            message: 'Server restarted, refreshing page',
            timestamp: Date.now()
        });
    }

    // admin stuff works properly now
    emitToAdmins(event, data) {
        this.io.to('admin_room').emit(event, data);
    }

    notifyAdmins(message) {
        this.emitToAdmins('admin_notification', {
            message: message,
            timestamp: Date.now()
        });
    }

    // client info
    getStats() {
        return {
            connectedClients: this.connectedClients.size,
            adminClients: this.adminClients.size,
            rooms: Array.from(this.io.sockets.adapter.rooms.keys())
        };
    }

    getClientInfo(socketId) {
        return this.connectedClients.get(socketId);
    }

    // shutdown works beter now
    async shutdown() {
        logger.info('Shutting down SocketHandler...');
        
        // tell everyone we're dying
        this.io.emit('server_shutdown', {
            message: 'Server is shutting down',
            timestamp: Date.now()
        });

        // wait a bit so they get teh message
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // close all connections
        this.io.close(() => {
            logger.info('✓ SocketHandler shutdown completed');
        });
    }
}

module.exports = SocketHandler;