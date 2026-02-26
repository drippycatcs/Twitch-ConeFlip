const axios = require('axios');
const tmi = require('tmi.js');
const { EventSubWsListener } = require('@twurple/eventsub-ws');
const { ApiClient } = require('@twurple/api');
const { StaticAuthProvider } = require('@twurple/auth');
const { config } = require('../config/environment');
const logger = require('../utils/logger');

class TwitchService {
    constructor() {
        this.chatClient = null;
        this.eventSubClient = null;
        this.apiClient = null;
        this.initialized = false;
        this.isConnected = false;
        
        // Services will be injected after initialization
        this.gameService = null;
        this.leaderboardService = null;
        this.skinService = null;
        
        // Cache for API responses
        this.cache = {
            emotes: { data: null, lastUpdated: 0 },
            userIds: new Map(),
            paints: new Map()
        };
        this.cacheDuration = 5 * 60 * 1000; // 5 minutes
        
        // Per-user cooldowns (2 seconds per user for regular commands)
        this.userCooldowns = new Map(); // Map<username, lastCommandTime>
        this.userCooldownDuration = 2000; // 2 seconds

        // Global cooldowns for specific commands (shared across ALL users)
        this.globalCommandCooldowns = new Map(); // Map<command, lastUsedTime>
        this.globalCooldownCommands = {
            '!bombdrippycat': 5000 // 5 seconds global
        };

        // Pending buy cone confirmations: Map<username, { skin, timestamp }>
        this.pendingBuyCone = new Map();

        // Periodic cleanup of caches and cooldowns every 15 minutes
        this._cleanupInterval = setInterval(() => {
            this._cleanupExpiredEntries();
        }, 15 * 60 * 1000);
        this._cleanupInterval.unref();
    }

    _cleanupExpiredEntries() {
        const now = Date.now();

        // Clean expired user cooldowns (older than cooldown window)
        for (const [username, lastTime] of this.userCooldowns) {
            if (now - lastTime > this.userCooldownDuration * 10) {
                this.userCooldowns.delete(username);
            }
        }

        // Clean expired cached user IDs
        for (const [username, cached] of this.cache.userIds) {
            if (now - cached.timestamp > this.cacheDuration) {
                this.cache.userIds.delete(username);
            }
        }

        // Clean expired cached paints
        for (const [username, cached] of this.cache.paints) {
            if (now - cached.timestamp > this.cacheDuration) {
                this.cache.paints.delete(username);
            }
        }
    }

    // Inject services after they're initialized
    setServices(gameService, leaderboardService, skinService, trailService) {
        this.gameService = gameService;
        this.leaderboardService = leaderboardService;
        this.skinService = skinService;
        this.trailService = trailService;
    }

    async initialize() {
        try {
            // Initialize chat client if we have bot credentials
            if (config.TWITCH.BOT_ACCESS_TOKEN && config.TWITCH.BOT_NAME) {
                await this.initializeChatClient();
            } else {
                logger.warn('Twitch bot credentials not provided, chat features will be disabled');
            }

            // Initialize EventSub client if we have streamer credentials
            if (config.TWITCH.STREAMER_ACCESS_TOKEN && config.TWITCH.CLIENT_ID && config.TWITCH.USER_ID) {
                await this.initializeEventSubClient();
            } else {
                logger.warn('Twitch EventSub credentials not provided, channel point redemptions will be disabled');
            }

            this.initialized = true;
            logger.info('TwitchService initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize TwitchService:', error);
            // Don't throw here, let the service work with limited functionality
        }
    }

    async initializeChatClient() {
        try {
            this.chatClient = new tmi.Client({
                options: { debug: config.NODE_ENV === 'development' },
                identity: {
                    username: config.TWITCH.BOT_NAME,
                    password: `oauth:${config.TWITCH.BOT_ACCESS_TOKEN}`
                },
                channels: [config.TWITCH.CHANNEL]
            });

            // Set up event handlers
            this.chatClient.on('connected', (addr, port) => {
                this.isConnected = true;
                logger.info(`Twitch chat connected to ${addr}:${port}`);
            });

            this.chatClient.on('disconnected', (reason) => {
                this.isConnected = false;
                logger.warn(`Twitch chat disconnected: ${reason}`);
            });

            this.chatClient.on('reconnect', () => {
                logger.info('Twitch chat reconnecting...');
            });

            // Handle chat messages for commands
            this.chatClient.on('message', (channel, tags, message, self) => {
                if (self) return; // Ignore bot's own messages
                this.handleChatMessage(channel, tags, message);
            });

            await this.chatClient.connect();
        } catch (error) {
            logger.error('Failed to initialize Twitch chat client:', error);
            throw error;
        }
    }

    async initializeEventSubClient() {
        try {
            // Create auth provider for API client
            const authProvider = new StaticAuthProvider(config.TWITCH.CLIENT_ID, config.TWITCH.STREAMER_ACCESS_TOKEN);
            
            // Create API client
            this.apiClient = new ApiClient({ authProvider });
            
            // Create EventSub WebSocket listener
            this.eventSubClient = new EventSubWsListener({ apiClient: this.apiClient });
            
            // Subscribe to channel point redemptions
            await this.eventSubClient.onChannelRedemptionAdd(config.TWITCH.USER_ID, (event) => {
                this.handleChannelPointRedemption(event);
            });

            // Subscribe to channel follow events (for follow rewards)
            logger.info(`[FOLLOW] Subscribing to follow events for broadcaster ID: ${config.TWITCH.USER_ID}`);
            try {
                await this.eventSubClient.onChannelFollow(config.TWITCH.USER_ID, config.TWITCH.USER_ID, (event) => {
                    logger.info(`[FOLLOW] Raw follow event received:`, JSON.stringify(event, null, 2));
                    this.handleChannelFollowEvent(event);
                });
                logger.info('[FOLLOW] Successfully subscribed to follow events');
            } catch (followError) {
                logger.error('[FOLLOW] Failed to subscribe to follow events:', followError);
            }

            // Start the EventSub listener
            await this.eventSubClient.start();

            logger.info('Twitch EventSub client initialized and listening for channel point redemptions and follows');
            logger.info(`[FOLLOW] Follow reward config at startup: ENABLED=${config.FOLLOW_REWARD?.ENABLED}, CHAT_ENABLED=${config.FOLLOW_REWARD?.CHAT_MESSAGE_ENABLED}`);
        } catch (error) {
            logger.error('Failed to initialize Twitch EventSub client:', error);
            throw error;
        }
    }

    async handleChatMessage(channel, tags, message) {
        try {
            const username = tags.username || 'unknown';

            // Check for pending buy cone confirmation before filtering on !
            if (this.pendingBuyCone.has(username)) {
                await this._handleBuyConeResponse(username, tags, message.trim());
                return;
            }

            // Only process messages that start with !
            if (!message.startsWith('!')) return;

            if (tags.username === config.TWITCH.BOT_NAME) {
                return;
            }
            
            // Use ONLY login name (username) - never use display name
            const userId = tags['user-id'];
            const isMod = tags.mod || tags['user-type'] === 'mod' || tags.username === 'drippycatcs';
            const isBroadcaster = tags.badges?.broadcaster === '1';
            const isAdmin = isMod || isBroadcaster;
            
            const now = Date.now();

            // Parse command and arguments
            const parts = message.trim().split(' ');
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);

            // Check if this command has a global cooldown (shared across all users)
            if (this.globalCooldownCommands[command]) {
                const lastUsed = this.globalCommandCooldowns.get(command) || 0;
                if (now - lastUsed < this.globalCooldownCommands[command]) {
                    return; // Command is on global cooldown, ignore silently
                }
            } else {
                // Regular command: check per-user cooldown
                const lastUserCommand = this.userCooldowns.get(username) || 0;
                if (now - lastUserCommand < this.userCooldownDuration) {
                    return; // User is on cooldown, ignore silently
                }
            }
            
            logger.info(`Chat command: ${command} from ${username}`, { args, isAdmin });
            
            // Handle commands
            switch (command) {
                case '!coneflip':
                    await this.handleConeFlipCommand(username, args);
                    break;
                case '!leaderboard':
                    await this.handleLeaderboardCommand(username, args);
                    break;
                case '!conestats':
                    await this.handleConeStatsCommand(username);
                    break;
                case '!myskins':
                    await this.handleMySkinsCommand(username, args);
                    break;
                case '!setskin':
                    await this.handleSetSkinCommand(username, args);
                    break;
                case '!settrail':
                    await this.handleSetTrailCommand(username, args);
                    break;
                case '!coneskins':
                    await this.handleConeSkinsCommand(username);
                    break;
                case '!coneshuffle':
                    await this.handleConeShuffleCommand(username, userId);
                    break;
                case '!contest':
                    await this.handleContestCommand(username);
                    break;
                // Admin commands
                case '!giveskin':
                    if (isAdmin) await this.handleGiveSkinCommand(username, args);
                    break;
                case '!givetrail':
                    if (isAdmin) await this.handleGiveTrailCommand(username, args);
                    break;
                case '!simcone':
                    if (isAdmin) await this.handleSimConeCommand(username, args);
                    break;
                case '!simduel':
                    if (isAdmin) await this.handleSimDuelCommand(username, args);
                    break;
                case '!refreshcones':
                    if (isAdmin) await this.handleRefreshConesCommand(username);
                    break;
                case '!conestuck':
                    if (isAdmin) await this.handleConeStuckCommand(username);
                    break;
                case '!bombdrippycat':
                    await this.handleBombDrippycatCommand(username, channel);
                    break;
                default:
                    // Unknown command, ignore silently
                    return;
            }

            // Update cooldown after successful command execution
            if (this.globalCooldownCommands[command]) {
                this.globalCommandCooldowns.set(command, now);
            } else {
                this.userCooldowns.set(username, now);
            }
            
        } catch (error) {
            logger.error('Error handling chat message:', error);
        }
    }

    async handleChannelPointRedemption(event) {
        try {
            // Use ONLY login name (userName) - never use display name
            const username = event.userName || 'unknown';
            const rewardId = event.rewardId;
            const userInput = event.input || '';
            
            logger.info(`Channel point redemption: ${event.rewardTitle} by ${username}`, { 
                rewardId, 
                userInput,
                cost: event.rewardCost 
            });

            // Handle different reward types
            if (rewardId === config.TWITCH.CONE_REWARD) {
                // Cone flip redemption
                await this.gameService.addCone(username);
                logger.info(`Cone flip triggered for ${username} via channel points`);
                
            } else if (rewardId === config.TWITCH.DUEL_REWARD) {
                // Duel redemption - parse target from user input
                let targetUser = 'random_opponent';
                if (userInput && userInput.trim()) {
                    targetUser = this.parseUsername(userInput.trim());

                    // Validate target name length (Twitch usernames are max 25 chars)
                    if (targetUser.length > 25) {
                        await this.sendChatMessage(`@${username} Duel target name is too long! Twitch usernames can only be up to 25 characters.`);
                        logger.info(`Duel rejected for ${username}: target name "${targetUser}" exceeds 25 characters`);
                        return;
                    }

                    // Prevent self-dueling
                    if (targetUser.toLowerCase() === username.toLowerCase()) {
                        await this.sendChatMessage(`@${username} You can't duel yourself!`);
                        logger.info(`Duel rejected for ${username}: attempted to duel themselves`);
                        return;
                    }
                }
                await this.gameService.addDuel(username, targetUser);
                logger.info(`Duel triggered: ${username} vs ${targetUser} via channel points`);
                
            } else if (rewardId === config.TWITCH.UNBOX_CONE) {
                // Unbox cone redemption
                if (this.skinService && this.skinService.setRandomSkin) {
                    const result = await this.skinService.setRandomSkin(username);
                    const chatMessage = result.message || (result.isTrailUnbox
                        ? `@${username} unboxed a trail: ${result.trailName}!`
                        : `@${username} unboxed ${result.skin} skin! (${result.rarity} Grade)`);

                    if (result.isTrailUnbox) {
                        // Trail unbox - use special animation skin name
                        logger.info(`Trail unboxed for ${username} via channel points: ${result.trailName} (Gold)`);
                        if (this.gameService && this.gameService.triggerUnboxAnimation) {
                            await this.gameService.triggerUnboxAnimation(
                                username,
                                '__trail__',
                                chatMessage
                            );
                        }
                    } else {
                        // Normal skin unbox
                        logger.info(`Skin unboxed for ${username} via channel points: ${result.skin} (${result.rarity})`);
                        if (this.gameService && this.gameService.triggerUnboxAnimation) {
                            await this.gameService.triggerUnboxAnimation(
                                username,
                                result.skin,
                                chatMessage
                            );
                        }
                    }

                } else {
                    logger.warn('Skin service not available for unbox redemption');
                }
                
            } else if (rewardId === config.TWITCH.BUY_CONE) {
                // Buy cone redemption - purchase specific skin from user input
                if (!this.skinService) {
                    logger.warn('Skin service not available for buy cone redemption');
                    return;
                }

                if (!userInput || !userInput.trim()) {
                    const skinsUrl = `${config.BASE_URL}/skins-all`;
                    await this.sendChatMessage(`@${username} Please type the name of the cone you want in chat! Browse all cones here: ${skinsUrl}`);
                }

                // Set pending state - one purchase allowed per redeem, auto-expire after 60s
                this.pendingBuyCone.set(username, { skin: null, timestamp: Date.now() });
                setTimeout(() => this.pendingBuyCone.delete(username), 60000);

                if (userInput && userInput.trim()) {
                    await this._processBuyConeInput(username, userInput.trim());
                }
                
            } else if (rewardId === config.TWITCH.BUY_TRAIL_REWARD) {
                // Buy trail redemption - purchase specific trail from user input
                if (!this.trailService) {
                    logger.warn('Trail service not available for buy trail redemption');
                    return;
                }

                if (!userInput || !userInput.trim()) {
                    await this.sendChatMessage(`@${username} Please specify which trail you want to buy! Example: "fire" or "rainbow"`);
                    logger.info(`Buy trail redemption failed for ${username}: No trail specified`);
                    return;
                }

                const requestedTrail = userInput.trim().toLowerCase();
                logger.info(`Buy trail redemption: ${username} requested "${requestedTrail}"`);

                // Check if the requested trail is valid
                if (!this.trailService.isValidTrail(requestedTrail)) {
                    const availableTrails = Object.keys(this.trailService.getAvailableTrails()).filter(trail => trail !== 'default');
                    const trailList = availableTrails.slice(0, 5).join(', '); // Show first 5 trails
                    const message = availableTrails.length > 5 
                        ? `@${username} Sorry! "${requestedTrail}" is not a valid trail. Available trails: ${trailList}... (and more)`
                        : `@${username} Sorry! "${requestedTrail}" is not a valid trail. Available trails: ${trailList}`;
                    
                    await this.sendChatMessage(message);
                    logger.info(`Buy trail redemption failed for ${username}: Invalid trail "${requestedTrail}"`);
                    return;
                }

                try {
                    // Set the specific trail and add to inventory
                    const twitchId = await this.getTwitchId(username);
                    await this.trailService.setTrail(username, requestedTrail, twitchId);
                    await this.trailService.giveTrail(username, requestedTrail, twitchId);
                    
                    await this.sendChatMessage(`@${username} Successfully bought the "${requestedTrail}" trail! 🎉`);
                    logger.info(`Buy trail redemption successful for ${username}: ${requestedTrail}`);
                } catch (error) {
                    await this.sendChatMessage(`@${username} Error processing your trail purchase. Please try again.`);
                    logger.error(`Buy trail redemption error for ${username}:`, error);
                }
                
            } else {
                logger.debug(`Unknown reward redemption: ${rewardId} by ${username}`);
            }

        } catch (error) {
            logger.error('Error handling channel point redemption:', error);
        }
    }

    async handleChannelFollowEvent(event) {
        try {
            logger.info(`[FOLLOW] ========== FOLLOW EVENT RECEIVED ==========`);
            logger.info(`[FOLLOW] Event data: ${JSON.stringify(event, null, 2)}`);

            // Check if follow reward is enabled
            logger.info(`[FOLLOW] FOLLOW_REWARD config: ${JSON.stringify(config.FOLLOW_REWARD)}`);
            if (!config.FOLLOW_REWARD || !config.FOLLOW_REWARD.ENABLED) {
                logger.info('[FOLLOW] Follow reward is disabled in config, skipping reward but logging follow');
            }

            const username = event.userName || event.userDisplayName || 'unknown';
            const userId = event.userId;

            logger.info(`[FOLLOW] New follower: ${username} (ID: ${userId})`);

            // Always log the follow, even if rewards are disabled
            if (!config.FOLLOW_REWARD || !config.FOLLOW_REWARD.ENABLED) {
                return;
            }

            // Check if this user is already in the leaderboard (not a new player)
            const existingPlayer = await this.leaderboardService.getPlayer(username);
            logger.info(`[FOLLOW] Existing player check for ${username}: ${JSON.stringify(existingPlayer)}`);

            if (existingPlayer && existingPlayer.hasPlayed) {
                logger.info(`[FOLLOW] Follower ${username} is already in leaderboard, skipping free coneflip`);
                return;
            }

            // Give them a free coneflip
            await this.gameService.addCone(username);
            logger.info(`[FOLLOW] Free coneflip given to new follower: ${username}`);

            // Send customizable chat message if enabled
            if (config.FOLLOW_REWARD.CHAT_MESSAGE_ENABLED && config.FOLLOW_REWARD.CHAT_MESSAGE) {
                const message = config.FOLLOW_REWARD.CHAT_MESSAGE.replace(/{user}/g, username);
                await this.sendChatMessage(message);
                logger.info(`[FOLLOW] Chat message sent for ${username}`);
            }

        } catch (error) {
            logger.error('[FOLLOW] Error handling channel follow event:', error);
        }
    }

    // Command handlers
    async handleConeFlipCommand(username, args) {
        try {
            const targetUser = args.length > 0 ? this.parseUsername(args[0]) : username;
            const stats = await this.leaderboardService.getPlayer(targetUser);
            
            if (!stats || !stats.hasPlayed) {
                await this.sendChatMessage(`@${username} ${targetUser} hasn't played any cone flips yet!`);
                return;
            }
            
            const winRate = Math.round(stats.winrate || 0);
            await this.sendChatMessage(
                `@${username} ${targetUser}'s cone stats: ${stats.wins} wins, ${stats.fails} fails, ${winRate}% win rate (Rank #${stats.rank} | ${stats.points} points) | View them here: ${config.BASE_URL}/u/${targetUser}`
            );
        } catch (error) {
            logger.error('Error in coneflip command:', error);
            await this.sendChatMessage(`@${username} Error getting cone flip stats!`);
        }
    }

    async handleLeaderboardCommand(username, args) {
        try {
            // Import GameService
            const GameService = require('./gameService');
            
            // Show leaderboard on stream like admin panel does
            await GameService.showLeaderboard();
            
            logger.info(`Leaderboard displayed on stream triggered by ${username}`);
        } catch (error) {
            logger.error('Error in leaderboard command:', error);
            await this.sendChatMessage(`@${username} Error showing leaderboard!`);
        }
    }

    async handleConeStatsCommand(username) {
        try {
            const stats = await this.leaderboardService.getStats();
            const avgWinRate = Math.round(stats.averageWinRate || 0);
            
            await this.sendChatMessage(
                `@${username} Cone stats: ${stats.playerCount} players, ${stats.totalGamesPlayed} games played, ${avgWinRate}% average win rate | View them here: ${config.BASE_URL}/leaderboard-public`
            );
        } catch (error) {
            logger.error('Error in conestats command:', error);
            await this.sendChatMessage(`@${username} Error getting cone stats!`);
        }
    }

    async handleMySkinsCommand(username, args) {
        try {
            const targetUser = args.length > 0 ? this.parseUsername(args[0]) : username;
            const currentSkin = await this.skinService.getUserSkin(targetUser);
            const inventory = await this.skinService.getUserInventory(targetUser);
            
            if (!currentSkin) {
                await this.sendChatMessage(`@${username} ${targetUser} doesn't have any skins yet! `);
                return;
            }
            
            const inventoryCount = inventory ? inventory.length : 0;
            await this.sendChatMessage(
                `@${username} ${targetUser}'s current skin: ${currentSkin} | View your inventory here: ${config.BASE_URL}/u/${targetUser}`
            );
        } catch (error) {
            logger.error('Error in myskins command:', error);
            await this.sendChatMessage(`@${username} Error getting skin info!`);
        }
    }

    async handleSetSkinCommand(username, args) {
        try {
            if (args.length === 0) {
                await this.sendChatMessage(`@${username} Usage: !setskin <skin_name>`);
                return;
            }
            
            const skinName = args.join(' ').toLowerCase();
            
            // Special handling for subcone - verify subscription status
            if (skinName === 'subcone') {
                const subscriptionTier = await this.isSubscriber(username);
                if (subscriptionTier === 0) {
                    await this.sendChatMessage(`@${username} You need to be subscribed to use the subcone skin!`);
                    return;
                }
            }
            
            const userInventory = await this.skinService.getUserInventory(username);
            
            // Handle both string and object formats in inventory
            const hasSkin = userInventory && userInventory.some(item => {
                // Handle both string and object formats
                const itemSkinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                return itemSkinName && itemSkinName.toLowerCase() === skinName;
            });
            
            if (!hasSkin && skinName !== 'default') {
                await this.sendChatMessage(`@${username} You don't own the "${skinName}" skin!`);
                return;
            }
            
            await this.skinService.setSkin(username, skinName);
            await this.sendChatMessage(`@${username} Skin changed to "${skinName}"!`);
        } catch (error) {
            logger.error('Error in setskin command:', error);
            await this.sendChatMessage(`@${username} Error setting skin!`);
        }
    }

    async handleConeSkinsCommand(username) {
        try {
            await this.sendChatMessage(
                `@${username} View all available skins and drop rates: ${config.BASE_URL}/skins`
            );
        } catch (error) {
            logger.error('Error in coneskins command:', error);
            await this.sendChatMessage(`@${username} Error getting skin info!`);
        }
    }

    async handleConeShuffleCommand(username, userId) {
        try {
            const currentState = await this.skinService.getShuffleEnabled(username);
            const newState = !currentState;
            await this.skinService.setShuffleEnabled(username, newState);
            await this.sendChatMessage(
                `@${username} Skin shuffle ${newState ? 'enabled' : 'disabled'}!`
            );
        } catch (error) {
            logger.error('Error in coneshuffle command:', error);
            await this.sendChatMessage(`@${username} Error toggling skin shuffle!`);
        }
    }

    async handleContestCommand(username) {
        try {
            // Check if contest is enabled
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            let contestData = { enabled: false, prize: '', description: '' };
            if (fs.existsSync(contestPath)) {
                contestData = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
            }
            
            if (!contestData.enabled) {
                await this.sendChatMessage(`@${username} No contest is currently active. Check back later!`);
                return;
            }
            
            const prizeText = contestData.prize ? ` | Prize: ${contestData.prize}` : '';
            await this.sendChatMessage(
                `@${username} Contest is LIVE! Submit your cone skins and vote for winners: ${config.BASE_URL}/contest${prizeText}`
            );
        } catch (error) {
            logger.error('Error in contest command:', error);
            await this.sendChatMessage(`@${username} Error getting contest info!`);
        }
    }

    async handleSetTrailCommand(username, args) {
        try {
            if (!this.trailService) {
                await this.sendChatMessage(`@${username} Trail system is not available!`);
                return;
            }

            if (args.length === 0) {
                await this.sendChatMessage(`@${username} Usage: !settrail <trail_name>`);
                return;
            }
            
            const trailName = args.join(' ').toLowerCase().trim();
            
            // Validate trail exists
            if (!this.trailService.isValidTrail(trailName)) {
                await this.sendChatMessage(`@${username} Invalid trail: ${trailName}`);
                return;
            }
            
            // Default trail is always available
            if (trailName === 'default') {
                await this.trailService.setTrail(username, trailName);
                await this.sendChatMessage(`@${username} Trail changed to "${trailName}"!`);
                return;
            }
            
            // Check if user owns this trail
            const userInventory = await this.trailService.getPlayerTrailInventory(username);
            
            // Handle both string and object formats in inventory
            const hasTrail = userInventory && userInventory.some(item => {
                // Handle both string and object formats
                const itemTrailName = typeof item === 'string' ? item : (item.trail || item.name || item);
                return itemTrailName && itemTrailName.toLowerCase() === trailName.toLowerCase();
            });
            
            if (!hasTrail) {
                await this.sendChatMessage(`@${username} You don't own the "${trailName}" trail! Use !givetrail to get trails.`);
                return;
            }
            
            await this.trailService.setTrail(username, trailName);
            await this.sendChatMessage(`@${username} Trail changed to "${trailName}"!`);
        } catch (error) {
            logger.error('Error in settrail command:', error);
            await this.sendChatMessage(`@${username} Error setting trail!`);
        }
    }

    async handleGiveTrailCommand(username, args) {
        try {
            if (!this.trailService) {
                await this.sendChatMessage(`@${username} Trail system is not available!`);
                return;
            }

            if (args.length < 2) {
                await this.sendChatMessage(`@${username} Usage: !givetrail <player> <trail_name>`);
                return;
            }
            
            const targetPlayer = args[0].toLowerCase().replace('@', '').trim();
            const trailName = args.slice(1).join(' ').toLowerCase().trim();
            
            logger.info(`Admin ${username} giving trail "${trailName}" to "${targetPlayer}"`);

            if (!this.trailService.isValidTrail(trailName)) {
                logger.debug(`Invalid trail requested: "${trailName}"`);
                await this.sendChatMessage(`@${username} Invalid trail: ${trailName}`);
                return;
            }
            
            await this.trailService.giveTrail(targetPlayer, trailName);
            await this.sendChatMessage(`@${username} Gave ${trailName} trail to ${targetPlayer}!`);
        } catch (error) {
            logger.error('Error in givetrail command:', error);
            await this.sendChatMessage(`@${username} Error giving trail!`);
        }
    }

    // Admin command handlers
    async handleGiveSkinCommand(username, args) {
        try {
            if (args.length < 2) {
                await this.sendChatMessage(`@${username} Usage: !giveskin <username> <skin_name>`);
                return;
            }
            
            const targetUser = this.parseUsername(args[0]);
            const skinName = args.slice(1).join(' ').toLowerCase();
            
            const twitchId = await this.getTwitchId(targetUser);
            await this.skinService.setSkin(targetUser, skinName, twitchId);
            await this.skinService.addSkinToInventory(targetUser, skinName, twitchId, 1);
            
            await this.sendChatMessage(`@${username} Gave ${skinName} skin to ${targetUser}!`);
        } catch (error) {
            logger.error('Error in giveskin command:', error);
            await this.sendChatMessage(`@${username} Error giving skin!`);
        }
    }

    async handleSimConeCommand(username, args) {
        try {
            if (args.length === 0) {
                await this.sendChatMessage(`@${username} Usage: !simcone <username>`);
                return;
            }
            
            const targetUser = this.parseUsername(args[0]);
            await this.gameService.addCone(targetUser);
            await this.sendChatMessage(`@${username} Simulated cone flip for ${targetUser}!`);
        } catch (error) {
            logger.error('Error in simcone command:', error);
            await this.sendChatMessage(`@${username} Error simulating cone!`);
        }
    }

    async handleSimDuelCommand(username, args) {
        try {
            if (args.length < 1) {
                await this.sendChatMessage(`@${username} Usage: !simduel <username> [target]`);
                return;
            }

            const player1 = this.parseUsername(args[0]);
            const player2 = args.length > 1 ? this.parseUsername(args[1]) : 'test_opponent';

            // Validate name lengths (Twitch usernames are max 25 chars)
            if (player1.length > 25) {
                await this.sendChatMessage(`@${username} Player name is too long! Twitch usernames can only be up to 25 characters.`);
                return;
            }
            if (player2.length > 25) {
                await this.sendChatMessage(`@${username} Target name is too long! Twitch usernames can only be up to 25 characters.`);
                return;
            }

            await this.gameService.addDuel(player1, player2);
            await this.sendChatMessage(`@${username} Simulated duel: ${player1} vs ${player2}!`);
        } catch (error) {
            logger.error('Error in simduel command:', error);
            await this.sendChatMessage(`@${username} Error simulating duel!`);
        }
    }

    async handleRefreshConesCommand(username) {
        try {
            await this.gameService.restart();
            await this.sendChatMessage(`@${username} Cones refreshed! All ongoing games stopped.`);
        } catch (error) {
            logger.error('Error in refreshcones command:', error);
            await this.sendChatMessage(`@${username} Error refreshing cones!`);
        }
    }

    async handleConeStuckCommand(username) {
        try {
            // Trigger multiple cone effects for the "conestuck" event
            for (let i = 0; i < 5; i++) {
                setTimeout(() => {
                    this.gameService.addCone(`ConestuckUser${i + 1}`);
                }, i * 500);
            }
            await this.sendChatMessage(`@${username} CONESTUCK EVENT ACTIVATED! 🌪️`);
        } catch (error) {
            logger.error('Error in conestuck command:', error);
            await this.sendChatMessage(`@${username} Error triggering conestuck!`);
        }
    }

    async handleBombDrippycatCommand(username, channel) {
        try {
            logger.info(`Executing !bombdrippycat command for ${username} in ${channel}`);
            await this.sendChatMessageToChannel(channel, `Drippycat has been notified.`);
        } catch (error) {
            logger.error('Error in bombdrippycat command:', error);
        }
    }

    // Helper function to parse username from @username format
    parseUsername(input) {
        return input.replace(/^@/, '').toLowerCase().trim();
    }

    async _processBuyConeInput(username, input) {
        // Only search buyable (canUnbox) skins - no gold, default, or special skins
        const result = this.skinService.findClosestSkin(input, { buyableOnly: true });

        if (!result) {
            // No match at all - send link to skins page and ask to try again
            const skinsUrl = `${config.BASE_URL}skins`;
            await this.sendChatMessage(`@${username} Couldn't find a buyable cone matching "${input}". Browse all cones here: ${skinsUrl} - then type the name in chat!`);
            // Keep pending open for retry but don't reset (preserves single-purchase limit)
            const pending = this.pendingBuyCone.get(username);
            if (pending) {
                pending.skin = null;
                pending.timestamp = Date.now();
            }
            return;
        }

        if (result.exact) {
            // Exact match - give it directly and clear pending (one purchase per redeem)
            this.pendingBuyCone.delete(username);
            await this._giveBuyConeSkin(username, result.match);
        } else {
            // Partial match - ask for confirmation
            await this.sendChatMessage(`@${username} Did you mean "${result.match}"? Type yes or no in chat!`);
            const pending = this.pendingBuyCone.get(username);
            if (pending) {
                pending.skin = result.match;
                pending.timestamp = Date.now();
            }
        }
    }

    async _handleBuyConeResponse(username, tags, message) {
        const pending = this.pendingBuyCone.get(username);
        if (!pending) return;

        // Check if expired (60 seconds)
        if (Date.now() - pending.timestamp > 60000) {
            this.pendingBuyCone.delete(username);
            return;
        }

        const lower = message.toLowerCase();

        if (pending.skin) {
            // We asked "did you mean X?" - waiting for yes/no
            if (lower === 'yes' || lower === 'y') {
                // Clear pending BEFORE giving skin (one purchase per redeem)
                this.pendingBuyCone.delete(username);
                await this._giveBuyConeSkin(username, pending.skin);
            } else if (lower === 'no' || lower === 'n') {
                const skinsUrl = `${config.BASE_URL}/skins-all`;
                await this.sendChatMessage(`@${username} No problem! Browse all cones here: ${skinsUrl} - then type the name in chat!`);
                pending.skin = null;
                pending.timestamp = Date.now();
            }
            // Ignore other messages while waiting for yes/no
        } else {
            // No skin suggested yet - treat their message as a new skin name attempt
            await this._processBuyConeInput(username, message);
        }
    }

    async _giveBuyConeSkin(username, skinName) {
        try {
            const twitchId = await this.getTwitchId(username);
            await this.skinService.setSkin(username, skinName, twitchId);
            await this.skinService.addSkinToInventory(username, skinName, twitchId, 1);
            await this.sendChatMessage(`@${username} Successfully bought the "${skinName}" cone skin!`);
            logger.info(`Buy cone redemption successful for ${username}: ${skinName}`);
        } catch (error) {
            await this.sendChatMessage(`@${username} Error processing your cone purchase. Please try again.`);
            logger.error(`Buy cone redemption error for ${username}:`, error);
        }
    }

    async sendChatMessage(message) {
        try {
            if (!this.isConnected || !this.chatClient) {
                logger.warn('Chat client not connected, cannot send message');
                return false;
            }

            logger.info(`Sending chat message to ${config.TWITCH.CHANNEL}: ${message.substring(0, 50)}...`);
            await this.chatClient.say(config.TWITCH.CHANNEL, message);
            logger.info(`Chat message sent successfully`);
            return true;
        } catch (error) {
            logger.error('Failed to send chat message:', error);
            return false;
        }
    }

    async sendChatMessageToChannel(channel, message) {
        try {
            if (!this.isConnected || !this.chatClient) {
                logger.warn('Chat client not connected, cannot send message');
                return false;
            }

            logger.info(`Sending chat message to ${channel}: ${message.substring(0, 50)}...`);
            await this.chatClient.say(channel, message);
            logger.info(`Chat message sent successfully to ${channel}`);
            return true;
        } catch (error) {
            logger.error(`Failed to send chat message to ${channel}:`, error);
            return false;
        }
    }

    async getTwitchId(username) {
        try {
            // Check cache first
            if (this.cache.userIds.has(username)) {
                const cached = this.cache.userIds.get(username);
                if (Date.now() - cached.timestamp < this.cacheDuration) {
                    return cached.id;
                }
            }

            if (!config.TWITCH.CLIENT_ID || !config.TWITCH.STREAMER_ACCESS_TOKEN) {
                logger.debug('Twitch API credentials not available for user lookup');
                return null;
            }

            const response = await axios.get('https://api.twitch.tv/helix/users', {
                params: { login: username },
                headers: {
                    'Client-ID': config.TWITCH.CLIENT_ID,
                    'Authorization': `Bearer ${config.TWITCH.STREAMER_ACCESS_TOKEN}`
                }
            });

            if (response.data.data && response.data.data.length > 0) {
                const userId = response.data.data[0].id;
                
                // Cache the result
                this.cache.userIds.set(username, {
                    id: userId,
                    timestamp: Date.now()
                });
                
                return userId;
            }
            
            return null;
        } catch (error) {
            logger.error('Error getting Twitch ID:', error);
            return null;
        }
    }

    /**
     * Checks if a user is subscribed to the channel
     * @param {string} username - The Twitch username to check
     * @returns {Promise<number>} - The subscription tier (0 = not subscribed, 1 = Tier 1, 2 = Tier 2, 3 = Tier 3)
     */
    async isSubscriber(username) {
        try {
            if (!config.TWITCH.CLIENT_ID || !config.TWITCH.STREAMER_ACCESS_TOKEN || !config.TWITCH.USER_ID) {
                logger.debug('Twitch API credentials not available for subscription check');
                return 0;
            }

            const userId = await this.getTwitchId(username);
            if (!userId) {
                logger.debug(`Could not get Twitch ID for ${username}`);
                return 0;
            }

            const response = await axios.get('https://api.twitch.tv/helix/subscriptions', {
                headers: {
                    'Client-ID': config.TWITCH.CLIENT_ID,
                    'Authorization': `Bearer ${config.TWITCH.STREAMER_ACCESS_TOKEN}`,
                    'Accept': 'application/json'
                },
                params: {
                    broadcaster_id: config.TWITCH.USER_ID,
                    user_id: userId,
                },
            });

            if (response.data.data && response.data.data.length > 0) {
                const sub = response.data.data[0];
                switch (sub.tier) {
                    case "1000":
                        return 1;
                    case "2000":
                        return 2;
                    case "3000":
                        return 3;
                    default:
                        logger.warn(`Unexpected subscription tier value: ${sub.tier} for ${username}`);
                        return 0;
                }
            } else {
                return 0;
            }
        } catch (error) {
            // Don't log as error since many users won't be subscribed
            logger.debug(`Could not check subscription status for ${username}:`, error.response?.data || error.message);
            return 0;
        }
    }

    async isChannelLive(channel) {
        try {
            if (!config.TWITCH.CLIENT_ID || !config.TWITCH.STREAMER_ACCESS_TOKEN) {
                return false;
            }

            const response = await axios.get('https://api.twitch.tv/helix/streams', {
                params: { user_login: channel },
                headers: {
                    'Client-ID': config.TWITCH.CLIENT_ID,
                    'Authorization': `Bearer ${config.TWITCH.STREAMER_ACCESS_TOKEN}`
                }
            });

            return response.data.data && response.data.data.length > 0;
        } catch (error) {
            logger.debug(`Could not check live status for ${channel}:`, error.message);
            return false;
        }
    }

    async getUser7TVPaint(username) {
        try {
            // Check cache first
            if (this.cache.paints.has(username)) {
                const cached = this.cache.paints.get(username);
                if (Date.now() - cached.timestamp < this.cacheDuration) {
                    return cached.paint;
                }
            }

            // First, fetch user ID by Twitch username using GraphQL
            const fetchUserQuery = `
                query FetchUser($username: String!) {
                    users(query: $username) {
                        id
                        username
                    }
                }
            `;

            const userResponse = await axios.post(
                'https://7tv.io/v3/gql',
                {
                    operationName: 'FetchUser',
                    query: fetchUserQuery,
                    variables: { username: username }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${config.SEVENTV_TOKEN}`
                    }
                }
            );

            if (userResponse.data.errors || !userResponse.data.data.users.length) {
                logger.debug(`7TV user not found for ${username}`);
                return null;
            }

            const userId = userResponse.data.data.users[0].id;

            // Fetch user paint and badge information using GraphQL
            const fetchUserPaintQuery = `
                query GetUserForUserPage($id: ObjectID!) {
                    user(id: $id) {
                        id
                        username
                        display_name
                        avatar_url
                        style {
                            color
                            paint {
                                id
                                kind
                                name
                                function
                                color
                                angle
                                shape
                                image_url
                                repeat
                                stops {
                                    at
                                    color
                                }
                                shadows {
                                    x_offset
                                    y_offset
                                    radius
                                    color
                                }
                            }
                            badge {
                                id
                                kind
                                name
                                tooltip
                                tag
                            }
                        }
                    }
                }
            `;

            const paintResponse = await axios.post(
                'https://7tv.io/v3/gql',
                {
                    query: fetchUserPaintQuery,
                    variables: { id: userId }
                },
                {
                    headers: { 'Content-Type': 'application/json' }
                }
            );

            if (paintResponse.data.errors) {
                logger.debug('GraphQL Errors:', paintResponse.data.errors);
                return null;
            }

            const userData = paintResponse.data.data.user;
            if (!userData) {
                logger.debug('User data not found.');
                return null;
            }

            // Format paint details exactly like the old implementation
            let paintDetails;
            const paint = userData.style.paint;
            if (!paint) {
                paintDetails = { message: 'No active paint set.' };
            } else {
                paintDetails = {
                    name: paint.name,
                    kind: paint.kind,
                    function: paint.function,
                    shape: paint.shape
                };

                if (paint.function === 'LINEAR_GRADIENT' || paint.function === 'RADIAL_GRADIENT') {
                    paintDetails.gradientAngle = paint.angle || 'N/A';
                    if (paint.stops && paint.stops.length) {
                        paintDetails.gradientStops = paint.stops.map((stop, index) => ({
                            order: index + 1,
                            at: stop.at * 100 + '%',
                            color: stop.color
                        }));
                    } else {
                        paintDetails.gradientStops = [];
                    }
                } else {
                    paintDetails.color = paint.color || 'N/A';
                }

                if (paint.image_url) {
                    paintDetails.image = paint.image_url;
                }

                if (paint.shadows && paint.shadows.length) {
                    paintDetails.shadows = paint.shadows.map(shadow => ({
                        x_offset: shadow.x_offset,
                        y_offset: shadow.y_offset,
                        radius: shadow.radius,
                        color: shadow.color
                    }));
                } else {
                    paintDetails.shadows = [];
                }
            }

            paintDetails.username = userData.username;
            paintDetails.avatar_url = userData.avatar_url || null;

            // Cache the result
            this.cache.paints.set(username, {
                paint: paintDetails,
                timestamp: Date.now()
            });

            return paintDetails;
        } catch (error) {
            logger.debug(`Error getting 7TV paint for ${username}:`, error.message);
            return null;
        }
    }

    async getStreamEmotes() {
        try {
            const emoteMap = await this.getStreamerEmoteList();
            return Object.keys(emoteMap);
        } catch (error) {
            logger.error('Error getting stream emotes:', error);
            return [];
        }
    }

    async getStreamerEmoteList() {
        try {
            // Check cache first
            if (this.cache.emotes.data && Date.now() - this.cache.emotes.lastUpdated < this.cacheDuration) {
                return this.cache.emotes.data;
            }

            // Fetch streamer's 7TV user ID using GraphQL (same as old project)
            const fetchUserQuery = `
                query FetchUser($username: String!) {
                    users(query: $username) {
                        id
                        username
                    }
                }
            `;
            const userResponse = await axios.post(
                'https://7tv.io/v3/gql',
                {
                    operationName: 'FetchUser',
                    query: fetchUserQuery,
                    variables: { username: config.TWITCH.CHANNEL.replace('#', '') }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${config.SEVENTV_TOKEN}`
                    }
                }
            );

            let emoteMap = {};

            if (!userResponse.data.errors && userResponse.data.data.users.length > 0) {
                const userId = userResponse.data.data.users[0].id;

                // Fetch streamer's emote list with URLs using GraphQL
                const fetchEmotesQuery = `
                    query GetUserEmotes($id: ObjectID!) {
                        user(id: $id) {
                            emote_sets {
                                emotes {
                                    id
                                    name
                                    data {
                                        host {
                                            url
                                        }
                                        name
                                    }
                                }
                            }
                        }
                    }
                `;
                const emotesResponse = await axios.post(
                    'https://7tv.io/v3/gql',
                    {
                        query: fetchEmotesQuery,
                        variables: { id: userId }
                    },
                    {
                        headers: { 'Content-Type': 'application/json' }
                    }
                );

                if (!emotesResponse.data.errors) {
                    const userData = emotesResponse.data.data.user;
                    if (userData && userData.emote_sets) {
                        userData.emote_sets.forEach(set => {
                            set.emotes.forEach(emote => {
                                if (emote.data && emote.data.host && emote.data.host.url) {
                                    const name = emote.name.toLowerCase();
                                    emoteMap[name] = `${emote.data.host.url}/4x.webp`;
                                }
                            });
                        });
                    }
                }
            }

            // Fetch and merge global 7TV emotes
            try {
                const globalResponse = await axios.get('https://7tv.io/v3/emote-sets/global');
                if (globalResponse.data && globalResponse.data.emotes) {
                    globalResponse.data.emotes.forEach(emote => {
                        if (emote.name && emote.data && emote.data.host && emote.data.host.url) {
                            const name = emote.name.toLowerCase();
                            // Don't overwrite streamer emotes with global ones
                            if (!(name in emoteMap)) {
                                emoteMap[name] = `${emote.data.host.url}/4x.webp`;
                            }
                        }
                    });
                }
            } catch (error) {
                logger.debug('Error fetching 7TV global emotes:', error);
            }

            // Cache the results
            this.cache.emotes = {
                data: emoteMap,
                lastUpdated: Date.now()
            };

            return emoteMap;
        } catch (error) {
            logger.error('Error fetching streamer emote list:', error);
            return {};
        }
    }

    async isEmote(text) {
        try {
            const emoteMap = await this.getStreamerEmoteList();
            const lowerText = text.toLowerCase();
            const isEmote = lowerText in emoteMap;
            
            return {
                isEmote,
                url: isEmote ? emoteMap[lowerText] : null,
                name: text,
                source: isEmote ? '7tv' : null
            };
        } catch (error) {
            logger.debug('Error checking if text is emote:', error);
            return {
                isEmote: false,
                url: null,
                name: text,
                source: null
            };
        }
    }

    // Service management methods
    async cleanup() {
        try {
            if (this.chatClient) {
                await this.chatClient.disconnect();
                this.chatClient = null;
            }
            
            if (this.eventSubClient) {
                await this.eventSubClient.stop();
                this.eventSubClient = null;
            }
            
            this.apiClient = null;
            this.isConnected = false;
            this.initialized = false;
            
            // Clear caches
            this.cache.userIds.clear();
            this.cache.paints.clear();
            this.cache.emotes = { data: null, lastUpdated: 0 };
            
            logger.info('TwitchService cleaned up');
        } catch (error) {
            logger.error('Error cleaning up TwitchService:', error);
        }
    }

    getStatus() {
        return {
            initialized: this.initialized,
            chatConnected: this.isConnected,
            eventSubConnected: !!(this.eventSubClient),
            hasServices: !!(this.gameService && this.leaderboardService && this.skinService)
        };
    }

    setSocketHandler(socketHandler) {
        // This method is kept for compatibility with the server setup
        // but TwitchService doesn't directly use WebSocket in this implementation
    }

    async shutdown() {
        await this.cleanup();
    }

    async reconnect() {
        try {
            await this.cleanup();
            await this.initialize();
            logger.info('TwitchService reconnected successfully');
        } catch (error) {
            logger.error('Failed to reconnect TwitchService:', error);
        }
    }
}

// Create singleton instance
const twitchService = new TwitchService();

module.exports = twitchService;