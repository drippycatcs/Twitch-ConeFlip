const DatabaseService = require('./databaseService');
const logger = require('../utils/logger');

class XPService {
    constructor() {
        // XP Configuration - base values for each action
        this.XP_VALUES = {
            coneflip_win: 70,
            coneflip_loss: 20,
            duel_win: 70,
            duel_loss: 20,
            streak_3_bonus: 70,
            streak_5_bonus: 100
        };

        // XP for unboxing skins by tier (lowest to highest rarity)
        this.UNBOX_XP = {
            'mil-spec': 50,
            'restricted': 150,
            'classified': 300,
            'covert': 500,
            'gold': 500
        };

        // Level scaling: f(x) = 100 + x^1.6 (polynomial growth)
        this.BASE_XP_REQUIREMENT = 100;
    }

    /**
     * Calculate XP needed to go from level to level+1
     * Formula: 100 + level^1.6
     * @param {number} level - Current level
     * @returns {number} XP needed for next level
     */
    calculateXPForLevel(level) {
        return Math.floor(100 + Math.pow(level, 1.6));
    }

    /**
     * Calculate total XP needed to reach a specific level from level 1
     * @param {number} targetLevel - Target level
     * @returns {number} Total XP needed
     */
    calculateTotalXPForLevel(targetLevel) {
        let totalXP = 0;
        for (let lvl = 1; lvl < targetLevel; lvl++) {
            totalXP += this.calculateXPForLevel(lvl);
        }
        return totalXP;
    }

    /**
     * Calculate level and progress from total XP
     * @param {number} totalXP - Total accumulated XP
     * @returns {Object} Level info including level, progress, and XP to next level
     */
    calculateLevelFromXP(totalXP) {
        let level = 1;
        let xpRemaining = totalXP;

        while (xpRemaining >= this.calculateXPForLevel(level)) {
            xpRemaining -= this.calculateXPForLevel(level);
            level++;
        }

        const xpToNextLevel = this.calculateXPForLevel(level);
        const progressPercent = Math.floor((xpRemaining / xpToNextLevel) * 100);

        return {
            level,
            currentLevelXP: xpRemaining,
            xpToNextLevel,
            progressPercent,
            totalXP
        };
    }

    /**
     * Calculate XP to award based on event type and streak
     * Streak bonuses are ADDITIVE to base XP
     * @param {string} eventType - Type of event (coneflip_win, duel_loss, etc.)
     * @param {number} currentStreak - Current win streak (after this win)
     * @returns {Object} XP breakdown with base and bonus
     */
    calculateXPAward(eventType, currentStreak = 0) {
        const baseXP = this.XP_VALUES[eventType] || 0;
        let streakBonus = 0;

        // Add streak bonus for wins only
        if (eventType === 'coneflip_win' || eventType === 'duel_win') {
            if (currentStreak >= 5) {
                streakBonus = this.XP_VALUES.streak_5_bonus;
            } else if (currentStreak >= 3) {
                streakBonus = this.XP_VALUES.streak_3_bonus;
            }
        }

        return {
            baseXP,
            streakBonus,
            totalXP: baseXP + streakBonus
        };
    }

    /**
     * Award XP to a player and check for level up
     * @param {string} playerName - Player's username
     * @param {string} eventType - Type of event
     * @param {number} currentStreak - Current win streak
     * @returns {Object} Result with XP awarded, level info, and level up status
     */
    async awardXP(playerName, eventType, currentStreak = 0) {
        try {
            const xpCalc = this.calculateXPAward(eventType, currentStreak);
            const xpAwarded = xpCalc.totalXP;

            if (xpAwarded === 0) {
                logger.warn(`No XP value configured for event type: ${eventType}`);
                return null;
            }

            // Get current player data
            const player = await DatabaseService.get(
                'SELECT xp, level FROM leaderboard WHERE LOWER(name) = LOWER(?)',
                [playerName]
            );

            if (!player) {
                logger.warn(`Player ${playerName} not found for XP award`);
                return null;
            }

            const currentXP = player.xp || 0;
            const previousLevel = player.level || 1;
            const newTotalXP = currentXP + xpAwarded;
            const levelInfo = this.calculateLevelFromXP(newTotalXP);
            const leveledUp = levelInfo.level > previousLevel;
            const levelsGained = levelInfo.level - previousLevel;

            // Update database
            if (leveledUp) {
                await DatabaseService.run(
                    `UPDATE leaderboard
                     SET xp = ?, level = ?
                     WHERE LOWER(name) = LOWER(?)`,
                    [newTotalXP, levelInfo.level, playerName]
                );
                logger.info(`${playerName} leveled up! ${previousLevel} -> ${levelInfo.level}`);
            } else {
                await DatabaseService.run(
                    'UPDATE leaderboard SET xp = ?, level = ? WHERE LOWER(name) = LOWER(?)',
                    [newTotalXP, levelInfo.level, playerName]
                );
            }

            logger.info(`XP awarded: ${playerName} +${xpAwarded} XP (${eventType}, streak: ${currentStreak})`);

            return {
                playerName,
                xpAwarded,
                baseXP: xpCalc.baseXP,
                streakBonus: xpCalc.streakBonus,
                eventType,
                totalXP: newTotalXP,
                level: levelInfo.level,
                previousLevel,
                leveledUp,
                levelsGained,
                currentLevelXP: levelInfo.currentLevelXP,
                xpToNextLevel: levelInfo.xpToNextLevel,
                progressPercent: levelInfo.progressPercent
            };
        } catch (error) {
            logger.error(`Failed to award XP to ${playerName}:`, error);
            throw error;
        }
    }

    /**
     * Award XP for unboxing a skin based on its tier
     * @param {string} playerName - Player's username
     * @param {string} tier - Skin tier (mil-spec, restricted, classified, covert, gold)
     * @returns {Object} Result with XP awarded and level info
     */
    async awardUnboxXP(playerName, tier) {
        try {
            const xpAwarded = this.UNBOX_XP[tier] || this.UNBOX_XP['mil-spec'];

            // Get current player data
            const player = await DatabaseService.get(
                'SELECT xp, level FROM leaderboard WHERE LOWER(name) = LOWER(?)',
                [playerName]
            );

            if (!player) {
                logger.warn(`Player ${playerName} not found for unbox XP award`);
                return null;
            }

            const currentXP = player.xp || 0;
            const previousLevel = player.level || 1;
            const newTotalXP = currentXP + xpAwarded;
            const levelInfo = this.calculateLevelFromXP(newTotalXP);
            const leveledUp = levelInfo.level > previousLevel;

            // Update database
            await DatabaseService.run(
                'UPDATE leaderboard SET xp = ?, level = ? WHERE LOWER(name) = LOWER(?)',
                [newTotalXP, levelInfo.level, playerName]
            );

            if (leveledUp) {
                logger.info(`${playerName} leveled up from unbox! ${previousLevel} -> ${levelInfo.level}`);
            }

            logger.info(`Unbox XP awarded: ${playerName} +${xpAwarded} XP (${tier} tier)`);

            return {
                playerName,
                xpAwarded,
                tier,
                totalXP: newTotalXP,
                level: levelInfo.level,
                previousLevel,
                leveledUp,
                currentLevelXP: levelInfo.currentLevelXP,
                xpToNextLevel: levelInfo.xpToNextLevel,
                progressPercent: levelInfo.progressPercent
            };
        } catch (error) {
            logger.error(`Failed to award unbox XP to ${playerName}:`, error);
            throw error;
        }
    }

    /**
     * Get player's XP and level info
     * @param {string} playerName - Player's username
     * @returns {Object} Player's level info
     */
    async getPlayerXPInfo(playerName) {
        try {
            const player = await DatabaseService.get(
                'SELECT xp, level FROM leaderboard WHERE LOWER(name) = LOWER(?)',
                [playerName]
            );

            if (!player) {
                return {
                    level: 1,
                    xp: 0,
                    currentLevelXP: 0,
                    progressPercent: 0,
                    xpToNextLevel: this.BASE_XP_REQUIREMENT,
                    totalXP: 0
                };
            }

            const totalXP = player.xp || 0;
            const levelInfo = this.calculateLevelFromXP(totalXP);

            return levelInfo;
        } catch (error) {
            logger.error(`Failed to get XP info for ${playerName}:`, error);
            throw error;
        }
    }

    /**
     * Recalculate and fix level for a player based on their XP
     * Useful for migration or fixing inconsistencies
     * @param {string} playerName - Player's username
     * @returns {Object} Updated level info
     */
    async recalculatePlayerLevel(playerName) {
        try {
            const player = await DatabaseService.get(
                'SELECT xp FROM leaderboard WHERE LOWER(name) = LOWER(?)',
                [playerName]
            );

            if (!player) {
                return null;
            }

            const levelInfo = this.calculateLevelFromXP(player.xp || 0);

            await DatabaseService.run(
                'UPDATE leaderboard SET level = ? WHERE LOWER(name) = LOWER(?)',
                [levelInfo.level, playerName]
            );

            logger.info(`Recalculated level for ${playerName}: Level ${levelInfo.level}`);
            return levelInfo;
        } catch (error) {
            logger.error(`Failed to recalculate level for ${playerName}:`, error);
            throw error;
        }
    }

    /**
     * Bulk recalculate levels for all players
     * Used during migration
     */
    async recalculateAllLevels() {
        try {
            const players = await DatabaseService.all(
                'SELECT name, xp FROM leaderboard WHERE xp > 0'
            );

            let updated = 0;
            for (const player of players) {
                const levelInfo = this.calculateLevelFromXP(player.xp);
                await DatabaseService.run(
                    'UPDATE leaderboard SET level = ? WHERE LOWER(name) = LOWER(?)',
                    [levelInfo.level, player.name]
                );
                updated++;
            }

            logger.info(`Recalculated levels for ${updated} players`);
            return { updated };
        } catch (error) {
            logger.error('Failed to recalculate all levels:', error);
            throw error;
        }
    }

    /**
     * Get XP configuration values (for API/debugging)
     */
    getXPConfig() {
        return {
            xpValues: this.XP_VALUES,
            levelScaling: this.LEVEL_SCALING,
            baseXPRequirement: this.BASE_XP_REQUIREMENT,
            sampleLevels: {
                'Level 1->2': this.calculateXPForLevel(1),
                'Level 2->3': this.calculateXPForLevel(2),
                'Level 3->4': this.calculateXPForLevel(3),
                'Level 5->6': this.calculateXPForLevel(5),
                'Level 10->11': this.calculateXPForLevel(10),
                'Level 20->21': this.calculateXPForLevel(20),
                'Level 50->51': this.calculateXPForLevel(50)
            }
        };
    }
}

module.exports = new XPService();
