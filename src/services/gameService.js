const LeaderboardService = require('./leaderboardService');
const SkinService = require('./skinService');
const TwitchService = require('./twitchService');
const XPService = require('./xpService');
const logger = require('../utils/logger');
const { config } = require('../config/environment');

class GameService {
    constructor() {
        this.io = null;
        this.initialized = false;
        this.activeGames = new Map();
        this.gameQueue = [];
        this.duelQueue = [];
        this.isProcessing = false;
        this._previousTopLevelPlayer = null;
        this.pendingUnboxes = new Map(); // unboxId -> { message, playerName, skin, fallbackTimer }
    }

    async initialize() {
        // Seed the top level player so we don't announce on server restart
        try {
            const topLevelPlayer = await LeaderboardService.getTopPlayerByLevel();
            this._previousTopLevelPlayer = topLevelPlayer ? topLevelPlayer.name : null;
            logger.info(`Seeded top level player: ${this._previousTopLevelPlayer || 'none'}`);
        } catch (error) {
            logger.warn('Failed to seed top level player:', error.message);
        }

        this.initialized = true;
        logger.info('GameService initialized');
    }

    setSocketHandler(socketHandler) {
        this.io = socketHandler.io;
        logger.info('GameService socket handler set');
    }

    async addCone(playerName) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            // Get Twitch ID for the player
            const TwitchService = require('./twitchService');
            let twitchId = null;
            
            try {
                twitchId = await TwitchService.getTwitchId(playerName);
                logger.info(`Twitch ID lookup for ${playerName}: ${twitchId || 'not found'}`);
            } catch (error) {
                logger.warn(`Failed to get Twitch ID for ${playerName}:`, error.message);
                twitchId = null;
            }

            // Add player to leaderboard if they don't exist
            await LeaderboardService.addPlayer(playerName, twitchId);

            // Apply skin shuffle if enabled (emits userSkinUpdate before addCone)
            await SkinService.applyShuffleIfEnabled(playerName);

            // Emit to all clients
            this.io.emit('addCone', playerName);

            logger.gameEvent('cone_added', { player: playerName, twitchId });

            return {
                player: playerName,
                twitchId,
                action: 'cone_added',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error(`Failed to add cone for ${playerName}:`, error);
            throw error;
        }
    }

    async addDuel(player1, player2) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            // Get Twitch IDs for both players
            const TwitchService = require('./twitchService');
            let twitchId1 = null;
            let twitchId2 = null;
            
            try {
                [twitchId1, twitchId2] = await Promise.all([
                    TwitchService.getTwitchId(player1),
                    TwitchService.getTwitchId(player2)
                ]);
                logger.info(`Twitch ID lookup for duel: ${player1}=${twitchId1 || 'not found'}, ${player2}=${twitchId2 || 'not found'}`);
            } catch (error) {
                logger.warn(`Failed to get Twitch IDs for duel ${player1} vs ${player2}:`, error.message);
                twitchId1 = null;
                twitchId2 = null;
            }

            // Add both players to leaderboard if they don't exist
            await Promise.all([
                LeaderboardService.addPlayer(player1, twitchId1),
                LeaderboardService.addPlayer(player2, twitchId2)
            ]);

            // Apply skin shuffle if enabled for both players
            await Promise.all([
                SkinService.applyShuffleIfEnabled(player1),
                SkinService.applyShuffleIfEnabled(player2)
            ]);

            // Emit to all clients
            this.io.emit('addConeDuel', player1, player2);

            logger.gameEvent('duel_added', { player1, player2, twitchId1, twitchId2 });

            return {
                player1,
                player2,
                twitchId1,
                twitchId2,
                action: 'duel_added',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.error(`Failed to add duel ${player1} vs ${player2}:`, error);
            throw error;
        }
    }

    async handleWin(playerName, gameType = 'coneflip') {
        try {
            // Get current top player before updating
            const currentTopPlayers = await LeaderboardService.getTopPlayers(1);
            const previousTopPlayer = currentTopPlayers.length > 0 ? currentTopPlayers[0].name : null;

            // Update player statistics with game type
            const updatedPlayer = await LeaderboardService.updatePlayer(playerName, true, gameType);

            // Award XP for the win
            const eventType = `${gameType}_win`;
            const xpResult = await XPService.awardXP(playerName, eventType, updatedPlayer.currentStreak);

            // Emit XP popup event to frontend
            if (xpResult && this.io) {
                this.io.emit('xp_popup', {
                    playerName,
                    xpAwarded: xpResult.xpAwarded,
                    baseXP: xpResult.baseXP,
                    streakBonus: xpResult.streakBonus,
                    totalXP: xpResult.totalXP,
                    level: xpResult.level
                });

                // Check for level up
                if (xpResult.leveledUp) {
                    this.io.emit('level_up', {
                        playerName,
                        newLevel: xpResult.level,
                        previousLevel: xpResult.previousLevel
                    });

                    // Announce level up in Twitch chat (if enabled)
                    if (config.LEVEL_UP_CHAT_ENABLED) {
                        try {
                            await TwitchService.sendChatMessage(
                                `${playerName} reached Cone Level ${xpResult.level}!`
                            );
                        } catch (chatError) {
                            logger.warn(`Failed to send level up chat message: ${chatError.message}`);
                        }
                    }
                }
            }

            // Check if #1 level player changed (obsidian skin)
            await this.checkObsidianSkin(playerName);

            // Check if this player just became the new #1 (based on points now)
            if (updatedPlayer.rank === 1 && previousTopPlayer !== playerName) {
                logger.info(`New #1 player detected: ${playerName} (overtook ${previousTopPlayer || 'no one'}) with ${updatedPlayer.points} points`);

                // Trigger gold celebration for new top player
                await this.triggerGoldCelebration(playerName);

                // Emit goldSkin event to update frontend
                this.io.emit('goldSkin', { name: playerName, rank: 1, points: updatedPlayer.points });
            }

            logger.gameEvent('player_win', { player: playerName, gameType, stats: updatedPlayer, xpResult });

            return { ...updatedPlayer, xpResult };
        } catch (error) {
            logger.error(`Failed to handle win for ${playerName}:`, error);
            throw error;
        }
    }

    async handleLoss(playerName, gameType = 'coneflip') {
        try {
            // Update player statistics with game type
            const updatedPlayer = await LeaderboardService.updatePlayer(playerName, false, gameType);

            // Award XP for the loss (consolation XP)
            const eventType = `${gameType}_loss`;
            const xpResult = await XPService.awardXP(playerName, eventType, 0); // Streak is 0 on loss

            // Emit XP popup event to frontend
            if (xpResult && this.io) {
                this.io.emit('xp_popup', {
                    playerName,
                    xpAwarded: xpResult.xpAwarded,
                    baseXP: xpResult.baseXP,
                    streakBonus: 0,
                    totalXP: xpResult.totalXP,
                    level: xpResult.level
                });

                // Check for level up (rare but possible with loss XP)
                if (xpResult.leveledUp) {
                    this.io.emit('level_up', {
                        playerName,
                        newLevel: xpResult.level,
                        previousLevel: xpResult.previousLevel
                    });

                    // Announce level up in Twitch chat (if enabled)
                    if (config.LEVEL_UP_CHAT_ENABLED) {
                        try {
                            await TwitchService.sendChatMessage(
                                `${playerName} reached Cone Level ${xpResult.level}!`
                            );
                        } catch (chatError) {
                            logger.warn(`Failed to send level up chat message: ${chatError.message}`);
                        }
                    }
                }
            }

            // Check if #1 level player changed (obsidian skin)
            await this.checkObsidianSkin(playerName);

            logger.gameEvent('player_loss', { player: playerName, gameType, stats: updatedPlayer, xpResult });

            return { ...updatedPlayer, xpResult };
        } catch (error) {
            logger.error(`Failed to handle loss for ${playerName}:`, error);
            throw error;
        }
    }

    async handleUpsideDown(playerName, gameType = 'coneflip', loserName = null) {
        try {
            // Upside down win points: +5 for coneflip, +10 for duel
            const winPoints = gameType === 'duel' ? 10 : 5;
            
            // Get current top player before updating
            const currentTopPlayers = await LeaderboardService.getTopPlayers(1);
            const previousTopPlayer = currentTopPlayers.length > 0 ? currentTopPlayers[0].name : null;

            // Add bonus points for upside down win
            const updatedWinner = await LeaderboardService.updatePlayerPoints(playerName, winPoints);
            
            // If there's a loser, penalize them -10 points
            let updatedLoser = null;
            if (loserName) {
                updatedLoser = await LeaderboardService.updatePlayerPoints(loserName, -10);
                logger.gameEvent('upside_down_penalty', { 
                    player: loserName, 
                    pointsChange: -10,
                    stats: updatedLoser 
                });
            }
            
            // Check if winner just became the new #1
            if (updatedWinner.rank === 1 && previousTopPlayer !== playerName) {
                logger.info(`New #1 player detected: ${playerName} (overtook ${previousTopPlayer || 'no one'}) with ${updatedWinner.points} points`);
                
                // Trigger gold celebration for new top player
                await this.triggerGoldCelebration(playerName);
                
                // Emit goldSkin event to update frontend
                this.io.emit('goldSkin', { name: playerName, rank: 1, points: updatedWinner.points });
            }
            
            // Check if #1 level player changed (obsidian skin)
            await this.checkObsidianSkin(playerName);

            logger.gameEvent('upside_down_win', {
                winner: playerName,
                loser: loserName,
                gameType,
                winPoints,
                stats: updatedWinner
            });

            return { winner: updatedWinner, loser: updatedLoser };
        } catch (error) {
            logger.error(`Failed to handle upside down for ${playerName}:`, error);
            throw error;
        }
    }

    async showLeaderboard(targetPlayer = null) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            // Fetch fresh leaderboard data
            const leaderboardData = await LeaderboardService.getLeaderboard(1, 25);
            
            // First emit fresh data to update the leaderboard
            this.io.emit('refreshLb', leaderboardData.data);
            
            // Then show the leaderboard with target highlighting
            this.io.emit('showLb', targetPlayer);

            logger.gameEvent('leaderboard_shown', { target: targetPlayer });

            return { action: 'leaderboard_shown', target: targetPlayer };
        } catch (error) {
            logger.error('Failed to show leaderboard:', error);
            throw error;
        }
    }

    async triggerGoldCelebration(playerName) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            this.io.emit('newGoldCelebration', playerName);

            logger.gameEvent('gold_celebration', { player: playerName });

            return { action: 'gold_celebration', player: playerName };
        } catch (error) {
            logger.error(`Failed to trigger gold celebration for ${playerName}:`, error);
            throw error;
        }
    }

    async checkObsidianSkin(playerName) {
        try {
            const topLevelPlayer = await LeaderboardService.getTopPlayerByLevel();
            if (!topLevelPlayer) return;

            const currentTop = topLevelPlayer.name;

            if (currentTop !== this._previousTopLevelPlayer) {
                const previousHolder = this._previousTopLevelPlayer;
                this._previousTopLevelPlayer = currentTop;

                // Announce in Twitch chat
                let message;
                if (previousHolder) {
                    message = `${currentTop} just overtook ${previousHolder} as the highest level player and earned the Obsidian Cone!`;
                } else {
                    message = `${currentTop} is the highest level player and earned the Obsidian Cone!`;
                }

                try {
                    await TwitchService.sendChatMessage(message);
                } catch (chatError) {
                    logger.warn(`Failed to send obsidian chat message: ${chatError.message}`);
                }

                // Emit socket event for frontend
                if (this.io) {
                    this.io.emit('obsidianSkin', { name: currentTop, previousHolder });
                }

                logger.info(`Obsidian Cone transferred: ${previousHolder || 'none'} -> ${currentTop}`);
            }
        } catch (error) {
            logger.warn(`Failed to check obsidian skin: ${error.message}`);
        }
    }

    async triggerSlowMotion() {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            this.io.emit('slowMotion');

            logger.gameEvent('slow_motion_triggered');

            return { action: 'slow_motion_triggered' };
        } catch (error) {
            logger.error('Failed to trigger slow motion:', error);
            throw error;
        }
    }

    async triggerConfetti(position = null) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            this.io.emit('confetti', position);

            logger.gameEvent('confetti_triggered', { position });

            return { action: 'confetti_triggered', position };
        } catch (error) {
            logger.error('Failed to trigger confetti:', error);
            throw error;
        }
    }

    async triggerUnboxAnimation(playerName, skin, message) {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            // Generate unique unbox ID
            const unboxId = `unbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            // Fallback: send chat message after 30s if client never confirms
            const fallbackTimer = setTimeout(async () => {
                const pending = this.pendingUnboxes.get(unboxId);
                if (pending) {
                    this.pendingUnboxes.delete(unboxId);
                    logger.warn(`Unbox fallback triggered for ${playerName} (${unboxId}) - client never confirmed`);
                    try {
                        await TwitchService.sendChatMessage(message);
                    } catch (chatError) {
                        logger.warn(`Failed to send fallback unbox chat message: ${chatError.message}`);
                    }
                }
            }, 30000);

            // Store pending unbox server-side
            this.pendingUnboxes.set(unboxId, { message, playerName, skin, fallbackTimer });

            // Emit animation event with unboxId (message is NOT sent to client)
            this.io.emit('unboxSkinAnim', skin, playerName, unboxId);

            logger.gameEvent('unbox_animation', { player: playerName, skin, unboxId });

            return { action: 'unbox_animation', player: playerName, skin, unboxId };
        } catch (error) {
            logger.error(`Failed to trigger unbox animation for ${playerName}:`, error);
            throw error;
        }
    }

    async completeUnbox(unboxId) {
        const pending = this.pendingUnboxes.get(unboxId);
        if (!pending) {
            logger.warn(`Unbox complete rejected - unknown unboxId: ${unboxId}`);
            return false;
        }

        // Clear the fallback timer
        clearTimeout(pending.fallbackTimer);
        this.pendingUnboxes.delete(unboxId);

        // Send chat message 2 seconds after animation finishes
        setTimeout(async () => {
            try {
                await TwitchService.sendChatMessage(pending.message);
                logger.info(`Unbox chat message sent for ${pending.playerName}: ${pending.message}`);
            } catch (chatError) {
                logger.warn(`Failed to send unbox chat message: ${chatError.message}`);
            }
        }, 2000);

        return true;
    }

    async restart() {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            // Clear any active games
            this.activeGames.clear();
            this.gameQueue.length = 0;
            this.duelQueue.length = 0;
            this.isProcessing = false;

            // Emit restart to all clients
            this.io.emit('restart');

            logger.gameEvent('game_restarted');

            return { action: 'game_restarted', timestamp: new Date().toISOString() };
        } catch (error) {
            logger.error('Failed to restart game:', error);
            throw error;
        }
    }

    async refreshSkins() {
        try {
            if (!this.initialized) {
                throw new Error('GameService not initialized');
            }

            this.io.emit('skinRefresh');
            this.io.emit('unboxConfigRefresh'); // Also refresh unbox configuration

            logger.gameEvent('skins_refreshed');

            return { action: 'skins_refreshed' };
        } catch (error) {
            logger.error('Failed to refresh skins:', error);
            throw error;
        }
    }

    // Debug/simulation methods
    async simulateCone(playerName, forceWin = null) {
        try {
            await this.addCone(playerName);

            // Simulate result after a short delay
            setTimeout(async () => {
                const isWin = forceWin !== null ? forceWin : Math.random() > 0.5;
                
                if (isWin) {
                    await this.handleWin(playerName);
                    this.io.emit('win', playerName);
                } else {
                    await this.handleLoss(playerName);
                    this.io.emit('fail', playerName);
                }
            }, 2000);

            return { 
                player: playerName, 
                simulated: true, 
                forceWin 
            };
        } catch (error) {
            logger.error(`Failed to simulate cone for ${playerName}:`, error);
            throw error;
        }
    }

    async simulateDuel(player1, player2, forceWinner = null) {
        try {
            await this.addDuel(player1, player2);

            // Note: Don't determine winners here! Let the frontend physics simulation
            // handle the actual outcome and emit duel_win events when the physics
            // actually determines which cone(s) succeeded or failed.
            
            return { 
                player1, 
                player2, 
                simulated: true, 
                forceWinner 
            };
        } catch (error) {
            logger.error(`Failed to simulate duel ${player1} vs ${player2}:`, error);
            throw error;
        }
    }

    getStatus() {
        return {
            initialized: this.initialized,
            activeGames: this.activeGames.size,
            queuedGames: this.gameQueue.length,
            queuedDuels: this.duelQueue.length,
            isProcessing: this.isProcessing,
            connectedClients: this.io ? this.io.engine.clientsCount : 0,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        };
    }

    async getGameStats() {
        try {
            const [leaderboardStats, skinStats] = await Promise.all([
                LeaderboardService.getStats(),
                Promise.resolve(SkinService.getSkinStats())
            ]);

            return {
                leaderboard: leaderboardStats,
                skins: skinStats,
                game: this.getStatus()
            };
        } catch (error) {
            logger.error('Failed to get game stats:', error);
            throw error;
        }
    }

    getActiveGames() {
        return Array.from(this.activeGames.entries()).map(([id, game]) => ({
            id,
            ...game
        }));
    }
}

// Create singleton instance
const gameService = new GameService();

module.exports = gameService; 