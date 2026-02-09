const DatabaseService = require('./databaseService');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

class TrailService {
    constructor() {
        this.availableTrails = {};
        this.trailConfig = [];
        this.initialized = false;
        this.socketHandler = null; // Add socket handler reference
        
        // Fixed tier percentages (same as skins)
        this.tierOdds = {
            'gold': 3.5,        // 3.5% for gold (trail unbox tier)
            'covert': 3.5,      // 3.5% for red (covert)
            'classified': 10.5, // 10.5% for pink (classified)
            'restricted': 27.5, // 27.5% for purple (restricted)
            'mil-spec': 55      // 55% for blue (mil-spec)
        };
    }

    setSocketHandler(socketHandler) {
        this.socketHandler = socketHandler;
        logger.info('TrailService: Socket handler set');
    }

    async initialize() {
        try {
            await this.loadTrailConfig();
            this.initialized = true;
            logger.info('TrailService initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize TrailService:', error);
            throw error;
        }
    }

    async loadTrailConfig() {
        const trailsDir = path.join(__dirname, '../../public/trails');
        
        try {
            // Read all .json files from trails directory
            const files = await fs.readdir(trailsDir);
            const trailFiles = files.filter(file => file.endsWith('.json') && file !== 'config.json');
            
            // Reset available trails
            this.trailConfig = [];
            this.availableTrails = {};
            
            // Load each trail file
            for (const file of trailFiles) {
                try {
                    const filePath = path.join(trailsDir, file);
                    const trailData = await fs.readFile(filePath, 'utf8');
                    const trail = JSON.parse(trailData);
                    
                    if (trail && trail.name) {
                        this.trailConfig.push(trail);
                        this.availableTrails[trail.name] = trail;
                        logger.debug(`Loaded trail: ${trail.name} from ${file}`);
                    }
                } catch (fileError) {
                    logger.warn(`Failed to load trail file ${file}:`, fileError.message);
                }
            }
            
            // Ensure default trail exists
            if (!this.availableTrails.default) {
                const defaultTrail = {
                    name: 'default',
                    displayName: 'No Trail',
                    type: 'none',
                    author: 'system',
                    tier: 'default',
                    description: 'No trail effect',
                    visuals: { type: 'none' }
                };
                this.trailConfig.unshift(defaultTrail);
                this.availableTrails.default = defaultTrail;
            }
            
            logger.info(`Loaded ${this.trailConfig.length} trail configurations from individual files`);
            return this.trailConfig;
        } catch (error) {
            logger.error('Failed to load trail configurations:', error);
            
            // Return default trail as fallback
            this.trailConfig = [{
                name: 'default',
                displayName: 'No Trail',
                type: 'none',
                author: 'system',
                tier: 'default',
                description: 'No trail effect',
                visuals: { type: 'none' }
            }];
            this.availableTrails = { default: this.trailConfig[0] };
            
            return this.trailConfig;
        }
    }

    async refreshTrailConfig() {
        await this.loadTrailConfig();
        if (this.socketHandler && this.socketHandler.io) {
            this.socketHandler.io.emit('trailConfigRefresh');
        }
    }

    getTrailsAvailableToUnbox() {
        return this.trailConfig.filter(trail => trail.canUnbox === true);
    }

    isValidTrail(trailName) {
        return this.availableTrails.hasOwnProperty(trailName);
    }

    getTrailsByTier() {
        const trailsByTier = {
            'gold': [],
            'covert': [],
            'classified': [],
            'restricted': [],
            'mil-spec': []
        };

        for (const trail of this.trailConfig) {
            if (trail.canUnbox && trail.tier) {
                const tier = trail.tier;
                if (trailsByTier[tier]) {
                    trailsByTier[tier].push(trail);
                }
            }
        }

        return trailsByTier;
    }

    selectFromTierTrails(tierTrails) {
        if (tierTrails.length === 0) return null;
        
        // Calculate total weight for this tier
        const totalWeight = tierTrails.reduce((sum, trail) => sum + (trail.unboxWeight || 1), 0);
        const random = Math.random() * totalWeight;
        
        let currentWeight = 0;
        for (const trail of tierTrails) {
            currentWeight += trail.unboxWeight || 1;
            if (random <= currentWeight) {
                return {
                    ...trail,
                    rarity: this.calculateRarity(trail.unboxWeight || 0)
                };
            }
        }
        
        // Fallback to first trail in tier
        return {
            ...tierTrails[0],
            rarity: this.calculateRarity(tierTrails[0].unboxWeight || 0)
        };
    }

    calculateRarity(weight) {
        if (weight >= 30) return 'Mil-Spec';
        if (weight >= 15) return 'Restricted';
        if (weight >= 9) return 'Classified';
        if (weight >= 5) return 'Covert';
        return 'Gold';
    }

    selectRandomTrailWithTiers() {
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

        // Step 2: Get trails in the selected tier
        const trailsByTier = this.getTrailsByTier();
        const tierTrails = trailsByTier[selectedTier] || [];

        if (tierTrails.length === 0) {
            // Fallback to mil-spec tier if selected tier has no trails
            const fallbackTrails = trailsByTier['mil-spec'];
            if (fallbackTrails.length === 0) {
                // Ultimate fallback to any unboxable trail
                const allUnboxable = this.getTrailsAvailableToUnbox();
                return {
                    ...allUnboxable[0],
                    rarity: this.calculateRarity(allUnboxable[0].unboxWeight || 0)
                };
            }
            return this.selectFromTierTrails(fallbackTrails);
        }

        // Step 3: Select specific trail within tier using weights
        return this.selectFromTierTrails(tierTrails);
    }

    async setTrail(name, trailName, twitchId = null) {
        name = name.toLowerCase();
        try {
            if (!this.isValidTrail(trailName)) {
                throw new Error(`Invalid trail: ${trailName}`);
            }

            // Normalize trail name to correct case
            const normalizedTrailName = trailName.toLowerCase();
            const correctTrailName = Object.keys(this.availableTrails).find(key => key.toLowerCase() === normalizedTrailName) || trailName;

            await DatabaseService.setPlayerTrail(name, correctTrailName, twitchId);
            logger.info(`Set trail for ${name}: ${correctTrailName}`);
            
            // Emit socket events to update frontend immediately
            if (this.socketHandler && this.socketHandler.io) {
                const trailConfig = this.availableTrails[correctTrailName];
                if (trailConfig) {
                    // Emit specific user trail update event
                    this.socketHandler.io.emit('userTrailUpdate', {
                        playerName: name,
                        trailName: correctTrailName,
                        trailConfig: trailConfig
                    });
                    
                    // Also emit general refresh events to update all UI elements
                    this.socketHandler.io.emit('trailRefresh');
                    this.socketHandler.io.emit('unboxConfigRefresh');
                    
                    logger.debug(`Emitted trail update events for ${name} → ${correctTrailName}`);
                }
            }
            
            return {
                success: true,
                message: `${name} now has the ${correctTrailName} trail!`,
                trail: correctTrailName
            };
        } catch (error) {
            logger.error(`Failed to set trail for ${name}:`, error);
            throw error;
        }
    }

    async giveTrail(name, trailName, twitchId = null) {
        name = name.toLowerCase();
        try {
            if (!this.isValidTrail(trailName)) {
                throw new Error(`Invalid trail: ${trailName}`);
            }

            const normalizedTrailName = trailName.toLowerCase();
            const correctTrailName = Object.keys(this.availableTrails).find(key => key.toLowerCase() === normalizedTrailName) || trailName;

            await DatabaseService.addTrailToInventory(name, correctTrailName, twitchId);
            logger.info(`Gave trail to ${name}: ${correctTrailName}`);
            
            // Emit socket events
            if (this.socketHandler && this.socketHandler.io) {
                this.socketHandler.io.emit('trailInventoryUpdate', {
                    playerName: name,
                    trailName: correctTrailName
                });
            }
            
            return {
                success: true,
                message: `${name} received the ${correctTrailName} trail!`,
                trail: correctTrailName
            };
        } catch (error) {
            logger.error(`Failed to give trail to ${name}:`, error);
            throw error;
        }
    }

    async getPlayerTrail(name, twitchId = null) {
        try {
            return await DatabaseService.getPlayerTrail(name, twitchId);
        } catch (error) {
            logger.error(`Failed to get trail for ${name}:`, error);
            return 'default';
        }
    }

    async getPlayerTrailInventory(name, twitchId = null) {
        try {
            return await DatabaseService.getPlayerTrailInventory(name, twitchId);
        } catch (error) {
            logger.error(`Failed to get trail inventory for ${name}:`, error);
            return [];
        }
    }

    getAllTrails() {
        return this.trailConfig;
    }

    getAvailableTrails() {
        return this.availableTrails;
    }
}

module.exports = new TrailService(); 