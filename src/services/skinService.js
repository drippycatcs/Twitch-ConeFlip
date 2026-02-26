const DatabaseService = require('./databaseService');
const XPService = require('./xpService');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

class SkinService {
    constructor() {
        this.availableSkins = {};
        this.skinConfig = [];
        this.initialized = false;
        this.socketHandler = null; // Add socket handler reference
        this.seasonalSkin = null; // Currently active seasonal skin (e.g., 'xmas' for Christmas)

        // Fixed tier percentages
        this.tierOdds = {
            'gold': 2,          // 2% for gold (trail unbox ONLY)
            'covert': 3.5,      // 3.5% for red (covert)
            'classified': 10.5, // 10.5% for pink (classified)
            'restricted': 27.5, // 27.5% for purple (restricted)
            'mil-spec': 56.5    // 56.5% for blue (mil-spec)
        };

        this.trailService = null; // Injected later for trail unboxing
    }

    async initialize() {
        try {
            await this.loadSkinConfiguration();
            this.initialized = true;
            logger.info('SkinService initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize SkinService:', error);
            throw error;
        }
    }

    setSocketHandler(socketHandler) {
        this.socketHandler = socketHandler;
        logger.info('SkinService socket handler set');
    }

    async loadSkinConfiguration() {
        try {
            const configPath = path.join(__dirname, '../../public/skins/config.json');
            const configData = await fs.readFile(configPath, 'utf8');
            this.skinConfig = JSON.parse(configData);

            // Build available skins map
            this.availableSkins = {};
            for (const skin of this.skinConfig) {
                this.availableSkins[skin.name] = {
                    name: skin.name,
                    visuals: skin.visuals,
                    canUnbox: skin.canUnbox || false,
                    unboxWeight: skin.unboxWeight || 0,
                    rarity: this.calculateRarity(skin.unboxWeight || 0),
                    effect: this.calculateEffect(skin)
                };
            }

            logger.info(`Loaded ${this.skinConfig.length} skin configurations`);
        } catch (error) {
            logger.error('Failed to load skin configuration:', error);
            throw error;
        }
    }

    calculateRarity(weight) {
        if (weight >= 30) return 'Mil-Spec';
        if (weight >= 15) return 'Restricted';
        if (weight >= 9) return 'Classified';
        if (weight >= 5) return 'Covert';
        return 'legendary';
    }

    calculateEffect(skinData) {
        // Check if it's a holographic skin
        if (skinData.visuals && skinData.visuals.includes('holo')) {
            return 'Holographic';
        }
        
        // Check if it's a classified skin (animated)
        const weight = skinData.unboxWeight || 0;
        if (weight >= 9 && weight < 15) {
            return 'Animated';
        }
        
        // Default effect
        return 'None';
    }

    // Get skins grouped by tier for the new system
    getSkinsByTier() {
        const skinsByTier = {
            'covert': [],
            'classified': [],
            'restricted': [],
            'mil-spec': []
        };

        for (const skin of this.skinConfig) {
            if (!skin.canUnbox) continue;

            const tier = this.getSkinTier(skin);
            if (skinsByTier[tier]) {
                skinsByTier[tier].push(skin);
            }
        }

        return skinsByTier;
    }

    getSkinTier(skin) {
        const weight = skin.unboxWeight || 0;
        if (weight >= 30) return 'mil-spec';
        if (weight >= 15) return 'restricted';
        if (weight >= 9) return 'classified';
        if (weight >= 5) return 'covert';
        return 'gold'; // For now, lowest weights go to gold tier
    }

    async getUserSkins() {
        try {
            const result = await DatabaseService.getAllUserSkins();
            return Array.isArray(result) ? result : [];
        } catch (error) {
            logger.error('Failed to get user skins:', error);
            return [];
        }
    }

    async getUserSkin(name) {
        name = name.toLowerCase();
        try {
            return await DatabaseService.getPlayerSkin(name);
        } catch (error) {
            logger.error(`Failed to get skin for user ${name}:`, error);
            return 'default';
        }
    }

    async setSkin(name, skinName, twitchId = null) {
        name = name.toLowerCase();
        try {
            if (!this.isValidSkin(skinName)) {
                throw new Error(`Invalid skin: ${skinName}`);
            }

            // Normalize skin name to correct case
            const normalizedSkinName = skinName.toLowerCase();
            const correctSkinName = Object.keys(this.availableSkins).find(key => key.toLowerCase() === normalizedSkinName) || skinName;

            await DatabaseService.setPlayerSkin(name, correctSkinName, twitchId);
            logger.info(`Set skin for ${name}: ${correctSkinName}`);

            // Emit socket events to update frontend immediately
            if (this.socketHandler && this.socketHandler.io) {
                const skinConfig = this.availableSkins[correctSkinName];
                if (skinConfig) {
                    // Emit specific user skin update event
                    this.socketHandler.io.emit('userSkinUpdate', {
                        playerName: name,
                        skinName: correctSkinName,
                        skinPath: `/skins/${skinConfig.visuals}`
                    });

                    // Also emit general refresh events to update all UI elements
                    this.socketHandler.io.emit('skinRefresh');
                    this.socketHandler.io.emit('unboxConfigRefresh');

                    logger.debug(`Emitted skin update events for ${name} → ${correctSkinName}`);
                }
            }
            
            return {
                success: true,
                message: `${name} now has the ${correctSkinName} skin!`,
                skin: correctSkinName
            };
        } catch (error) {
            logger.error(`Failed to set skin for ${name}:`, error);
            throw error;
        }
    }

    async setRandomSkin(name, twitchId = null) {
        name = name.toLowerCase();
        try {
            const selectedSkin = this.selectRandomSkinWithTiers();

            // Check if gold tier was rolled (trail unbox)
            if (selectedSkin.tier === 'gold' && this.trailService) {
                return await this._handleTrailUnbox(name, twitchId);
            }

            // Set the skin as active (this will emit socket events)
            const result = await this.setSkin(name, selectedSkin.name, twitchId);

            // Add the skin to inventory
            await this.addSkinToInventory(name, selectedSkin.name, twitchId, 1);

            // Award XP based on skin tier
            let xpResult = null;
            try {
                xpResult = await XPService.awardUnboxXP(name, selectedSkin.tier || 'mil-spec');
                if (xpResult && this.socketHandler) {
                    // Emit XP popup event
                    this.socketHandler.io.emit('xp_popup', {
                        playerName: name,
                        xpAwarded: xpResult.xpAwarded,
                        baseXP: xpResult.xpAwarded,
                        streakBonus: 0,
                        totalXP: xpResult.totalXP,
                        level: xpResult.level,
                        isUnbox: true,
                        tier: selectedSkin.tier
                    });

                    // Check for level up
                    if (xpResult.leveledUp) {
                        this.socketHandler.io.emit('level_up', {
                            playerName: name,
                            newLevel: xpResult.level,
                            previousLevel: xpResult.previousLevel
                        });
                    }
                }
            } catch (xpError) {
                logger.warn(`Failed to award unbox XP to ${name}: ${xpError.message}`);
            }

            // Log the unbox event for debugging
            logger.info(`${name} unboxed ${selectedSkin.name} (${selectedSkin.rarity}, ${selectedSkin.tier}) via Twitch - events emitted`);

            return {
                ...result,
                message: `@${name} unboxed ${selectedSkin.name} skin! (${selectedSkin.rarity} Grade)`,
                rarity: selectedSkin.rarity,
                tier: selectedSkin.tier,
                xpAwarded: xpResult?.xpAwarded || 0
            };
        } catch (error) {
            logger.error(`Failed to set random skin for ${name}:`, error);
            throw error;
        }
    }

    async _handleTrailUnbox(name, twitchId) {
        // Get all available trails (excluding 'default')
        const allTrails = Object.keys(this.trailService.getAvailableTrails()).filter(t => t !== 'default');

        // Get the player's current trail inventory
        const playerInventory = await this.trailService.getPlayerTrailInventory(name, twitchId);
        const ownedTrails = (playerInventory || []).map(item => {
            const trailName = typeof item === 'string' ? item : (item.trail || item.name || item);
            return trailName.toLowerCase();
        });

        // Filter to trails the player doesn't own
        const unownedTrails = allTrails.filter(t => !ownedTrails.includes(t.toLowerCase()));

        if (unownedTrails.length === 0) {
            // Player owns all trails, give a random one anyway
            logger.info(`${name} owns all trails, giving random duplicate`);
            const randomTrail = allTrails[Math.floor(Math.random() * allTrails.length)];
            await this.trailService.giveTrail(name, randomTrail, twitchId);
            await this.trailService.setTrail(name, randomTrail, twitchId);

            return {
                skin: '__trail__',
                isTrailUnbox: true,
                trailName: randomTrail,
                message: `@${name} unboxed a trail: ${randomTrail}! (Gold Grade)`,
                rarity: 'Gold',
                tier: 'gold',
                xpAwarded: 0
            };
        }

        // Pick a random unowned trail
        const randomTrail = unownedTrails[Math.floor(Math.random() * unownedTrails.length)];
        await this.trailService.giveTrail(name, randomTrail, twitchId);
        await this.trailService.setTrail(name, randomTrail, twitchId);

        // Award XP for gold tier unbox
        let xpResult = null;
        try {
            xpResult = await XPService.awardUnboxXP(name, 'gold');
            if (xpResult && this.socketHandler) {
                this.socketHandler.io.emit('xp_popup', {
                    playerName: name,
                    xpAwarded: xpResult.xpAwarded,
                    baseXP: xpResult.xpAwarded,
                    streakBonus: 0,
                    totalXP: xpResult.totalXP,
                    level: xpResult.level,
                    isUnbox: true,
                    tier: 'gold'
                });

                if (xpResult.leveledUp) {
                    this.socketHandler.io.emit('level_up', {
                        playerName: name,
                        newLevel: xpResult.level,
                        previousLevel: xpResult.previousLevel
                    });
                }
            }
        } catch (xpError) {
            logger.warn(`Failed to award trail unbox XP to ${name}: ${xpError.message}`);
        }

        logger.info(`${name} unboxed trail: ${randomTrail} (Gold tier) via Twitch`);

        return {
            skin: '__trail__',
            isTrailUnbox: true,
            trailName: randomTrail,
            message: `@${name} unboxed a trail: ${randomTrail}! (Gold Grade)`,
            rarity: 'Gold',
            tier: 'gold',
            xpAwarded: xpResult?.xpAwarded || 0
        };
    }

    isValidSkin(skinName) {
        // Make case insensitive by checking if any available skin name matches (case insensitive)
        const normalizedSkinName = skinName.toLowerCase();
        return Object.keys(this.availableSkins).some(key => key.toLowerCase() === normalizedSkinName);
    }

    // Find the closest matching skin name (fuzzy match)
    // Returns { exact, match } where exact is true if it's a perfect match
    findClosestSkin(input, { buyableOnly = false } = {}) {
        const normalized = input.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        let allSkins;

        if (buyableOnly) {
            // Only match skins that can be unboxed (excludes gold, default, special skins)
            allSkins = this.skinConfig
                .filter(s => s.canUnbox)
                .map(s => s.name);
        } else {
            allSkins = Object.keys(this.availableSkins);
        }

        // 1. Exact match (case insensitive)
        const exact = allSkins.find(s => s.toLowerCase() === normalized);
        if (exact) return { match: exact, exact: true };

        // 2. Exact match ignoring spaces/underscores
        const compacted = normalized.replace(/[\s_-]/g, '');
        const compactMatch = allSkins.find(s => s.toLowerCase().replace(/[\s_-]/g, '') === compacted);
        if (compactMatch) return { match: compactMatch, exact: true };

        // 3. Input contains a skin name or skin name contains input
        const containsMatch = allSkins.find(s => {
            const sLower = s.toLowerCase();
            return sLower.includes(normalized) || normalized.includes(sLower);
        });
        if (containsMatch) return { match: containsMatch, exact: false };

        // 4. Any word in the input matches part of a skin name
        const words = normalized.split(/\s+/).filter(w => w.length >= 3);
        for (const word of words) {
            const wordMatch = allSkins.find(s => s.toLowerCase().includes(word));
            if (wordMatch) return { match: wordMatch, exact: false };
        }

        return null;
    }

    getSkinsAvailableToUnbox() {
        return this.skinConfig.filter(skin => skin.canUnbox);
    }

    // New tier-based selection system
    selectRandomSkinWithTiers() {
        // Step 1: Roll for tier based on fixed percentages
        const tierRoll = Math.random() * 100;
        let cumulativeOdds = 0;
        let selectedTier = null;

        for (const [tier, percentage] of Object.entries(this.tierOdds)) {
            cumulativeOdds += percentage;
            if (tierRoll <= cumulativeOdds) {
                selectedTier = tier;
                break;
            }
        }

        // Step 2: Get skins in the selected tier
        const skinsByTier = this.getSkinsByTier();
        const tierSkins = skinsByTier[selectedTier] || [];

        if (tierSkins.length === 0) {
            // Gold tier = trail unbox (no skins in gold tier)
            if (selectedTier === 'gold') {
                return { name: '__trail__', tier: 'gold', rarity: 'Gold', isTrailUnbox: true };
            }
            // Fallback to mil-spec tier if selected tier has no skins
            const fallbackSkins = skinsByTier['mil-spec'];
            if (fallbackSkins.length === 0) {
                // Ultimate fallback to any unboxable skin
                const allUnboxable = this.getSkinsAvailableToUnbox();
                return {
                    ...allUnboxable[0],
                    rarity: this.calculateRarity(allUnboxable[0].unboxWeight || 0),
                    tier: 'mil-spec'
                };
            }
            const result = this.selectFromTierSkins(fallbackSkins);
            return { ...result, tier: 'mil-spec' };
        }

        // Step 3: Select specific skin within tier using weights
        const result = this.selectFromTierSkins(tierSkins);
        return { ...result, tier: selectedTier };
    }

    selectFromTierSkins(tierSkins) {
        if (tierSkins.length === 1) {
            return {
                ...tierSkins[0],
                rarity: this.calculateRarity(tierSkins[0].unboxWeight || 0)
            };
        }

        // Use weighted selection within the tier
        const totalWeight = tierSkins.reduce((sum, skin) => sum + (skin.unboxWeight || 0), 0);
        
        if (totalWeight === 0) {
            // If no weights, select randomly
            const randomIndex = Math.floor(Math.random() * tierSkins.length);
            return {
                ...tierSkins[randomIndex],
                rarity: this.calculateRarity(tierSkins[randomIndex].unboxWeight || 0)
            };
        }

        let random = Math.random() * totalWeight;
        
        for (const skin of tierSkins) {
            random -= (skin.unboxWeight || 0);
            if (random <= 0) {
                return {
                    ...skin,
                    rarity: this.calculateRarity(skin.unboxWeight || 0)
                };
            }
        }
        
        // Fallback to last skin in tier
        return {
            ...tierSkins[tierSkins.length - 1],
            rarity: this.calculateRarity(tierSkins[tierSkins.length - 1].unboxWeight || 0)
        };
    }

    // Legacy method - keeping for backward compatibility during transition
    selectRandomSkin(unboxableSkins) {
        return this.selectRandomSkinWithTiers();
    }

    getSkinOdds() {
        const skinsByTier = this.getSkinsByTier();
        const odds = {};

        for (const [tier, tierPercentage] of Object.entries(this.tierOdds)) {
            const tierSkins = skinsByTier[tier] || [];
            
            if (tierSkins.length === 0) continue;

            // Calculate total weight within this tier
            const totalTierWeight = tierSkins.reduce((sum, skin) => sum + (skin.unboxWeight || 0), 0);

            for (const skin of tierSkins) {
                let skinProbability;
                
                if (totalTierWeight === 0) {
                    // If no weights in tier, equal distribution
                    skinProbability = tierPercentage / tierSkins.length;
                } else {
                    // Weight-based distribution within tier
                    const skinWeightRatio = (skin.unboxWeight || 0) / totalTierWeight;
                    skinProbability = tierPercentage * skinWeightRatio;
                }

                odds[skin.name] = {
                    weight: skin.unboxWeight,
                    probability: Math.round(skinProbability * 100) / 100,
                    rarity: this.calculateRarity(skin.unboxWeight || 0),
                    tier: tier,
                    tierOdds: tierPercentage
                };
            }
        }

        return odds;
    }

    getAvailableSkinsMap() {
        const skinsMap = {};
        for (const [name, skin] of Object.entries(this.availableSkins)) {
            skinsMap[name] = `/skins/${skin.visuals}`;
        }
        return skinsMap;
    }

    getAvailableSkinsArray() {
        const skinsArray = [];
        for (const [name, skin] of Object.entries(this.availableSkins)) {
            skinsArray.push({
                name: name,
                url: `/skins/${skin.visuals}`,
                rarity: skin.rarity || 'common',
                effect: skin.effect || 'None'
            });
        }
        return skinsArray;
    }

    async getUserInventory(name) {
        name = name.toLowerCase();
        try {
            const result = await DatabaseService.getPlayerInventory(name);
            const inventory = result || [];

            // Ensure everyone has the default cone
            const hasDefaultCone = inventory.some(item => {
                const skinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                return skinName === 'default';
            });

            if (!hasDefaultCone) {
                // Add default cone to the inventory
                inventory.unshift('default'); // Add at the beginning
                logger.debug(`Added default cone to ${name}'s inventory`);
            }

            // Check if user is #1 on leaderboard and add gold skin dynamically
            try {
                const LeaderboardService = require('./leaderboardService');
                const topPlayers = await LeaderboardService.getTopPlayers(1);
                const isTopPlayer = topPlayers.length > 0 && topPlayers[0].name === name;

                if (isTopPlayer) {
                    const hasGoldSkin = inventory.some(item => {
                        const skinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                        return skinName === 'gold';
                    });

                    if (!hasGoldSkin) {
                        inventory.push('gold');
                        logger.debug(`Dynamically added gold skin to ${name}'s inventory (rank #1)`);
                    }
                }
            } catch (error) {
                logger.debug(`Could not check leaderboard position for ${name}:`, error.message);
            }

            // Check if user is #1 by level/XP and add obsidian skin dynamically
            try {
                const LeaderboardService = require('./leaderboardService');
                const topLevelPlayer = await LeaderboardService.getTopPlayerByLevel();
                const isTopLevelPlayer = topLevelPlayer && topLevelPlayer.name === name;

                if (isTopLevelPlayer) {
                    const hasObsidianSkin = inventory.some(item => {
                        const skinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                        return skinName === 'obsidian';
                    });

                    if (!hasObsidianSkin) {
                        inventory.push('obsidian');
                        logger.debug(`Dynamically added obsidian skin to ${name}'s inventory (highest level player)`);
                    }
                }
            } catch (error) {
                logger.debug(`Could not check level position for ${name}:`, error.message);
            }

            // Check if user is subscribed to Twitch and add subcone dynamically
            try {
                const TwitchService = require('./twitchService');
                const subscriptionTier = await TwitchService.isSubscriber(name);

                if (subscriptionTier > 0) {
                    const hasSubcone = inventory.some(item => {
                        const skinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                        return skinName === 'subcone';
                    });

                    if (!hasSubcone) {
                        inventory.push('subcone');
                        logger.debug(`Dynamically added subcone to ${name}'s inventory (subscribed tier ${subscriptionTier})`);
                    }
                }
            } catch (error) {
                logger.debug(`Could not check subscription status for ${name}:`, error.message);
            }

            // Add seasonal skin dynamically if one is active
            if (this.seasonalSkin && this.isValidSkin(this.seasonalSkin)) {
                const hasSeasonalSkin = inventory.some(item => {
                    const skinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                    return skinName === this.seasonalSkin;
                });

                if (!hasSeasonalSkin) {
                    inventory.push(this.seasonalSkin);
                    logger.debug(`Dynamically added seasonal skin ${this.seasonalSkin} to ${name}'s inventory`);
                }
            }

            return inventory;
        } catch (error) {
            logger.error(`Failed to get inventory for ${name}:`, error);
            // Even on error, ensure default cone is included
            return ['default'];
        }
    }

    // Seasonal skin management methods
    getSeasonalSkin() {
        return this.seasonalSkin;
    }

    async setSeasonalSkin(skinName) {
        if (skinName && !this.isValidSkin(skinName)) {
            throw new Error(`Invalid skin: ${skinName}`);
        }

        const previousSkin = this.seasonalSkin;
        this.seasonalSkin = skinName || null;

        if (this.seasonalSkin) {
            logger.info(`Seasonal skin set to: ${this.seasonalSkin}`);
        } else {
            logger.info(`Seasonal skin cleared (was: ${previousSkin})`);
        }

        // Emit socket events to notify all clients
        if (this.socketHandler && this.socketHandler.io) {
            this.socketHandler.io.emit('seasonalSkinUpdate', {
                seasonalSkin: this.seasonalSkin,
                previousSkin: previousSkin
            });
            this.socketHandler.io.emit('skinRefresh');
        }

        // If unsetting, reset users who have the seasonal skin selected to default
        if (!this.seasonalSkin && previousSkin) {
            await this.resetUsersWithSeasonalSkin(previousSkin);
        }

        return {
            success: true,
            seasonalSkin: this.seasonalSkin,
            previousSkin: previousSkin
        };
    }

    async resetUsersWithSeasonalSkin(skinName) {
        try {
            const db = DatabaseService.getSkinsDb();

            // Find all users who have the seasonal skin selected
            const usersWithSkin = await new Promise((resolve, reject) => {
                db.all('SELECT name, twitchid FROM user_skins WHERE skin = ?', [skinName], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });

            if (usersWithSkin.length === 0) {
                logger.info(`No users found with seasonal skin ${skinName} selected`);
                return { resetCount: 0 };
            }

            // Reset each user to default skin
            for (const user of usersWithSkin) {
                await DatabaseService.setPlayerSkin(user.name, 'default', user.twitchid);
                logger.debug(`Reset ${user.name} from seasonal skin ${skinName} to default`);

                // Emit individual skin update
                if (this.socketHandler && this.socketHandler.io) {
                    const defaultSkinConfig = this.availableSkins['default'];
                    if (defaultSkinConfig) {
                        this.socketHandler.io.emit('userSkinUpdate', {
                            playerName: user.name,
                            skinName: 'default',
                            skinPath: `/skins/${defaultSkinConfig.visuals}`
                        });
                    }
                }
            }

            logger.info(`Reset ${usersWithSkin.length} users from seasonal skin ${skinName} to default`);
            return { resetCount: usersWithSkin.length, users: usersWithSkin.map(u => u.name) };
        } catch (error) {
            logger.error(`Failed to reset users with seasonal skin ${skinName}:`, error);
            throw error;
        }
    }

    async addSkinToInventory(name, skinName, twitchId = null, quantity = 1) {
        name = name.toLowerCase();
        try {
            if (!this.isValidSkin(skinName)) {
                throw new Error(`Invalid skin: ${skinName}`);
            }

            // Normalize skin name to correct case
            const normalizedSkinName = skinName.toLowerCase();
            const correctSkinName = Object.keys(this.availableSkins).find(key => key.toLowerCase() === normalizedSkinName) || skinName;

            await DatabaseService.addSkinToInventory(name, correctSkinName, twitchId, quantity);
            logger.debug(`Added ${quantity} ${correctSkinName} to ${name}'s inventory`);

            
            return { success: true, skin: correctSkinName, quantity };
        } catch (error) {
            logger.error(`Failed to add skin to inventory for ${name}:`, error);
            throw error;
        }
    }

    async getShuffleEnabled(username) {
        username = username.toLowerCase();
        try {
            return await DatabaseService.getPlayerShuffle(username);
        } catch (error) {
            logger.error(`Failed to get shuffle state for ${username}:`, error);
            return false;
        }
    }

    async setShuffleEnabled(username, enabled) {
        username = username.toLowerCase();
        try {
            // Ensure user has a row in user_skins first
            const currentSkin = await DatabaseService.getPlayerSkin(username);
            if (!currentSkin || currentSkin === 'default') {
                // Make sure the row exists
                await DatabaseService.setPlayerSkin(username, currentSkin || 'default');
            }
            await DatabaseService.setPlayerShuffle(username, enabled);
            logger.info(`Shuffle ${enabled ? 'enabled' : 'disabled'} for ${username}`);
            return enabled;
        } catch (error) {
            logger.error(`Failed to set shuffle state for ${username}:`, error);
            throw error;
        }
    }

    async applyShuffleIfEnabled(username) {
        username = username.toLowerCase();
        try {
            const shuffleEnabled = await this.getShuffleEnabled(username);
            if (!shuffleEnabled) return false;

            const inventory = await this.getUserInventory(username);
            if (!inventory || inventory.length === 0) return false;

            // Extract skin names from inventory (handles both string and object formats)
            const skinNames = inventory.map(item => {
                return typeof item === 'string' ? item : (item.skin || item.name || item);
            }).filter(name => name && typeof name === 'string');

            if (skinNames.length === 0) return false;

            // Pick a random skin from inventory
            const randomSkin = skinNames[Math.floor(Math.random() * skinNames.length)];

            // Normalize skin name
            const normalizedSkinName = randomSkin.toLowerCase();
            const correctSkinName = Object.keys(this.availableSkins).find(
                key => key.toLowerCase() === normalizedSkinName
            ) || randomSkin;

            // Silently update the DB only - no socket events.
            // The frontend will fetch this player's skin when it creates
            // the new cone, so existing cones on the field stay untouched.
            await DatabaseService.setPlayerSkin(username, correctSkinName);
            logger.info(`Shuffle: ${username} randomly selected ${correctSkinName}`);
            return true;
        } catch (error) {
            logger.error(`Failed to apply shuffle for ${username}:`, error);
            return false;
        }
    }

    getSkinStats() {
        try {
            const db = DatabaseService.getSkinsDb();
            
            const userStats = db.prepare(`
                SELECT 
                    COUNT(DISTINCT name) as total_users,
                    COUNT(*) as total_skin_assignments
                FROM user_skins
            `).get();

            const skinPopularity = db.prepare(`
                SELECT 
                    skin,
                    COUNT(*) as usage_count,
                    ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM user_skins)), 2) as usage_percentage
                FROM user_skins 
                GROUP BY skin 
                ORDER BY usage_count DESC
            `).all();

            const inventoryStats = db.prepare(`
                SELECT 
                    skin,
                    COUNT(DISTINCT name) as owners,
                    SUM(quantity) as total_owned
                FROM skin_inventory 
                GROUP BY skin 
                ORDER BY total_owned DESC
            `).all();

            return {
                userStats,
                skinPopularity,
                inventoryStats,
                totalAvailableSkins: Object.keys(this.availableSkins).length,
                unboxableSkins: this.getSkinsAvailableToUnbox().length
            };
        } catch (error) {
            logger.error('Failed to get skin stats:', error);
            throw error;
        }
    }

    async migrateSkins() {
        try {
            const db = DatabaseService.getSkinsDb();
            
            // Update any old skin references that might not exist anymore
            const validSkinNames = Object.keys(this.availableSkins);
            const invalidSkins = db.prepare(`
                SELECT DISTINCT skin FROM user_skins 
                WHERE skin NOT IN (${validSkinNames.map(() => '?').join(',')})
            `).all(...validSkinNames);

            if (invalidSkins.length > 0) {
                logger.warn(`Found ${invalidSkins.length} invalid skin references, updating to default`);
                const updateStmt = db.prepare('UPDATE user_skins SET skin = ? WHERE skin = ?');
                
                for (const invalidSkin of invalidSkins) {
                    updateStmt.run('default', invalidSkin.skin);
                    logger.debug(`Updated invalid skin ${invalidSkin.skin} to default`);
                }
            }

            logger.info('Skin migration completed');
        } catch (error) {
            logger.error('Failed to migrate skins:', error);
            throw error;
        }
    }
}

// Create singleton instance
const skinService = new SkinService();

module.exports = skinService; 