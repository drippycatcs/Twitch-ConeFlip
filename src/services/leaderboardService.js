const DatabaseService = require('./databaseService');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

class LeaderboardService {
    constructor() {
        this.cache = {
            leaderboard: null,
            lastUpdated: 0,
            stats: null,
            statsLastUpdated: 0
        };
        this.cacheDuration = 30000; // 30 seconds
    }

    async initialize() {
        // Just log that leaderboard service is ready
        logger.info('LeaderboardService initialized');
    }

    async getLeaderboard(page = 1, limit = 50, sortBy = 'points') {
        try {
            // Determine ordering based on sortBy parameter
            let orderClause;
            if (sortBy === 'level') {
                orderClause = 'ORDER BY level DESC, xp DESC, name ASC';
            } else {
                orderClause = 'ORDER BY points DESC, wins DESC, winrate DESC, name ASC';
            }

            // Use subquery to preserve ranks across pagination
            const offset = (page - 1) * limit;
            const query = `
                SELECT * FROM (
                    SELECT
                        ROW_NUMBER() OVER (${orderClause}) as rank,
                        name,
                        twitchid,
                        points,
                        wins,
                        fails,
                        duel_wins,
                        duel_losses,
                        coneflip_wins,
                        coneflip_losses,
                        current_streak,
                        highest_streak,
                        total_games,
                        winrate,
                        xp,
                        level,
                        last_played,
                        created_at
                    FROM leaderboard
                    WHERE total_games > 0 OR points > 0
                    ${orderClause}
                ) ranked
                LIMIT ? OFFSET ?
            `;

            const results = await DatabaseService.all(query, [limit, offset]);

            // Get total count for pagination info
            const countQuery = `SELECT COUNT(*) as total FROM leaderboard WHERE total_games > 0 OR points > 0`;
            const countResult = await DatabaseService.get(countQuery);
            const total = countResult.total;

            logger.debug(`Leaderboard fetched: ${results.length} players for page ${page} (sorted by ${sortBy})`);

            return {
                data: results,
                pagination: {
                    page,
                    limit,
                    total: total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: (page * limit) < total,
                    hasPrev: page > 1
                },
                sortBy
            };
        } catch (error) {
            logger.error('Failed to get leaderboard:', error);
            throw error;
        }
    }

    paginateResults(results, page, limit) {
        // Ensure results is always an array
        if (!Array.isArray(results)) {
            results = [];
        }
        
        const offset = (page - 1) * limit;
        const paginatedResults = results.slice(offset, offset + limit);
        

        
        return {
            data: paginatedResults,
            pagination: {
                page,
                limit,
                total: results.length,
                totalPages: Math.ceil(results.length / limit),
                hasNext: offset + limit < results.length,
                hasPrev: page > 1
            }
        };
    }

    async getPlayer(name) {
        name = name.toLowerCase();
        try {
            // First try to find by name
            let player = await DatabaseService.get('SELECT * FROM leaderboard WHERE name = ?', [name]);
            
            // Note: Removed Twitch ID lookup to avoid circular dependency

            if (!player) {
                return {
                    hasPlayed: false,
                    name: name,
                    message: `${name} has never played ConeFlip`
                };
            }

            // Get rank - POINTS FIRST, then wins, then winrate as tiebreaker
            const rankResult = await DatabaseService.get(`
                SELECT COUNT(*) + 1 as rank 
                FROM leaderboard 
                WHERE (points > ? OR (points = ? AND wins > ?) OR 
                      (points = ? AND wins = ? AND winrate > ?) OR
                      (points = ? AND wins = ? AND winrate = ? AND name < ?))
                AND (total_games > 0 OR points > 0)
            `, [player.points, player.points, player.wins,
                player.points, player.wins, player.winrate,
                player.points, player.wins, player.winrate, player.name]);

            // Calculate XP progress info
            const XPService = require('./xpService');
            const xpInfo = XPService.calculateLevelFromXP(player.xp || 0);

            return {
                hasPlayed: true,
                name: player.name,
                twitchId: player.twitchid,
                points: player.points,
                wins: player.wins,
                fails: player.fails,
                duelWins: player.duel_wins,
                duelLosses: player.duel_losses,
                coneflipWins: player.coneflip_wins,
                coneflipLosses: player.coneflip_losses,
                currentStreak: player.current_streak,
                highestStreak: player.highest_streak,
                totalGames: player.total_games,
                winrate: player.winrate,
                rank: rankResult.rank,
                lastPlayed: player.last_played,
                createdAt: player.created_at,
                // XP and Level data
                xp: player.xp || 0,
                level: player.level || 1,
                currentLevelXP: xpInfo.currentLevelXP,
                xpToNextLevel: xpInfo.xpToNextLevel,
                progressPercent: xpInfo.progressPercent
            };
        } catch (error) {
            logger.error(`Failed to get player ${name}:`, error);
            throw error;
        }
    }

    async addPlayer(name, twitchId = null) {
        name = name.toLowerCase();
        try {
            // If we have a Twitch ID, check if it already exists in the database
            if (twitchId) {
                const existingByTwitchId = await DatabaseService.get('SELECT * FROM leaderboard WHERE twitchid = ?', [twitchId]);
                if (existingByTwitchId) {
                    // Twitch ID exists - update the username (usernames can change, Twitch IDs don't)
                    if (existingByTwitchId.name !== name) {
                        await DatabaseService.run('UPDATE leaderboard SET name = ? WHERE twitchid = ?', [name, twitchId]);
                        logger.info(`Updated username for existing Twitch ID: ${existingByTwitchId.name} -> ${name} (ID: ${twitchId})`);
                    }
                    return existingByTwitchId;
                }
            }
            
            // Check if player already exists by name
            const existingByName = await DatabaseService.get('SELECT * FROM leaderboard WHERE name = ?', [name]);
            if (existingByName) {
                // Update twitchid if we have one and the player doesn't have one
                if (twitchId && (!existingByName.twitchid || existingByName.twitchid === '')) {
                    await DatabaseService.run('UPDATE leaderboard SET twitchid = ? WHERE name = ?', [twitchId, name]);
                    logger.info(`Updated twitchid for existing player: ${name} -> ${twitchId}`);
                }
                logger.debug(`Player ${name} already exists in leaderboard`);
                return existingByName;
            }

            // Note: Removed Twitch ID lookup to avoid circular dependency

            // Insert new player
            const result = await DatabaseService.run(`
                INSERT INTO leaderboard (name, twitchid, wins, fails, winrate) 
                VALUES (?, ?, 0, 0, 0.0)
            `, [name, twitchId]);
            
            logger.info(`Added new player to leaderboard: ${name} with twitchid: ${twitchId || 'none'}`);
            
            // Clear cache
            this.clearCache();
            
            return this.getPlayer(name);
        } catch (error) {
            logger.error(`Failed to add player ${name}:`, error);
            throw error;
        }
    }

    async updatePlayer(name, isWin, gameType = 'coneflip') {
        name = name.toLowerCase();
        try {
            // Get current player data
            const player = await this.getPlayer(name);
            if (!player.hasPlayed) {
                // Add player if they don't exist
                await this.addPlayer(name);
            }

            let pointsChange = 0;
            let updateQuery = '';
            let updateParams = [name];

            if (gameType === 'duel') {
                // Duel: winner +1 point, loser -1 point (but can't go below 0)
                if (isWin) {
                    pointsChange = 1;
                    updateQuery = `
                        UPDATE leaderboard 
                        SET duel_wins = duel_wins + 1,
                            points = points + 1,
                            current_streak = current_streak + 1,
                            highest_streak = MAX(highest_streak, current_streak + 1),
                            last_played = CURRENT_TIMESTAMP
                        WHERE name = ?
                    `;
                } else {
                    pointsChange = -1;
                    updateQuery = `
                        UPDATE leaderboard 
                        SET duel_losses = duel_losses + 1,
                            points = MAX(0, points - 1),
                            current_streak = 0,
                            last_played = CURRENT_TIMESTAMP
                        WHERE name = ?
                    `;
                }
            } else {
                // Regular coneflip: winner +1 point, loser +0 points
                if (isWin) {
                    pointsChange = 1;
                    updateQuery = `
                        UPDATE leaderboard 
                        SET coneflip_wins = coneflip_wins + 1,
                            points = points + 1,
                            current_streak = current_streak + 1,
                            highest_streak = MAX(highest_streak, current_streak + 1),
                            last_played = CURRENT_TIMESTAMP
                        WHERE name = ?
                    `;
                } else {
                    pointsChange = 0;
                    updateQuery = `
                        UPDATE leaderboard 
                        SET coneflip_losses = coneflip_losses + 1,
                            current_streak = 0,
                            last_played = CURRENT_TIMESTAMP
                        WHERE name = ?
                    `;
                }
            }

            const result = await DatabaseService.run(updateQuery, updateParams);
            
            if (result.changes === 0) {
                throw new Error(`Failed to update player ${name}: no rows affected`);
            }

            const action = isWin ? 'win' : 'loss';
            logger.userAction(`${gameType}_${action}`, name, { pointsChange });
            
            // Clear cache
            this.clearCache();
            
            // Get updated player data and update global streak record
            const updatedPlayer = await this.getPlayer(name);
            await this.updateGlobalStreakRecord(updatedPlayer);

            return updatedPlayer;
        } catch (error) {
            logger.error(`Failed to update player ${name}:`, error);
            throw error;
        }
    }

    async updatePlayerPoints(playerName, pointsChange) {
        try {
            // Add the player if they don't exist
            await this.addPlayer(playerName);
            
            let updateQuery;
            if (pointsChange > 0) {
                // Positive points: add to points and streak
                updateQuery = `
                    UPDATE leaderboard 
                    SET points = points + ?,
                        current_streak = current_streak + 1,
                        highest_streak = MAX(highest_streak, current_streak + 1),
                        last_played = CURRENT_TIMESTAMP
                    WHERE name = ?
                `;
            } else {
                // Negative points: subtract from points (but don't go below 0), reset streak
                updateQuery = `
                    UPDATE leaderboard 
                    SET points = MAX(0, points + ?),
                        current_streak = 0,
                        last_played = CURRENT_TIMESTAMP
                    WHERE name = ?
                `;
            }
            
            await DatabaseService.run(updateQuery, [pointsChange, playerName]);
            
            // Get updated player data
            const player = await this.getPlayer(playerName);
            
            // Check and update global highest streak record
            await this.updateGlobalStreakRecord(player);
            
            // Clear cache since data changed
            this.clearCache();
            
            const action = pointsChange > 0 ? 'received bonus' : 'lost';
            logger.userAction(`Player ${playerName} ${action} ${Math.abs(pointsChange)} points`, { 
                player: playerName, 
                pointsChange,
                newTotal: player.points
            });
            
            return player;
        } catch (error) {
            logger.error(`Failed to update points for ${playerName}:`, error);
            throw error;
        }
    }

    async updateGlobalStreakRecord(player) {
        try {
            if (!player || !player.highestStreak) return;
            const record = await DatabaseService.get(`SELECT value FROM records WHERE type = 'highest_streak'`);
            if (!record || player.highestStreak > record.value) {
                await DatabaseService.run(`
                    INSERT INTO records (type, value, player, achieved_at)
                    VALUES ('highest_streak', ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(type) DO UPDATE SET value=excluded.value, player=excluded.player, achieved_at=excluded.achieved_at
                `, [player.highestStreak, player.name]);
            }
        } catch (error) {
            logger.error('Failed to update global streak record:', error);
        }
    }

    async getStats() {
        try {
            const now = Date.now();
            
            // Return cached stats if still valid
            if (this.cache.stats && 
                (now - this.cache.statsLastUpdated) < this.cacheDuration) {
                return this.cache.stats;
            }

            const statsQuery = await DatabaseService.get(`
                SELECT 
                    COUNT(*) as playerCount,
                    COALESCE(SUM(points), 0) as totalPoints,
                    COALESCE(SUM(wins), 0) as totalWins,
                    COALESCE(SUM(fails), 0) as totalFails,
                    COALESCE(SUM(duel_wins), 0) as totalDuelWins,
                    COALESCE(SUM(duel_losses), 0) as totalDuelLosses,
                    COALESCE(SUM(coneflip_wins), 0) as totalConeflipWins,
                    COALESCE(SUM(coneflip_losses), 0) as totalConeflipLosses,
                    COALESCE(SUM(total_games), 0) as totalGamesPlayed,
                    COALESCE(AVG(winrate), 0) as averageWinRate,
                    COALESCE(MAX(points), 0) as highestPoints,
                    COALESCE(MAX(wins), 0) as highestWins,
                    COALESCE(MAX(winrate), 0) as highestWinRate,
                    COALESCE(SUM(xp), 0) as totalXP
                FROM leaderboard
                WHERE total_games > 0 OR points > 0
            `);

            // Fetch global highest streak record
            const streakRecord = await DatabaseService.get(`SELECT value, player, achieved_at FROM records WHERE type = 'highest_streak'`);

            const topPlayerQuery = await DatabaseService.get(`
                SELECT name, points, wins, winrate, total_games, duel_wins, duel_losses, coneflip_wins, coneflip_losses
                FROM leaderboard 
                WHERE total_games > 0 OR points > 0
                ORDER BY points DESC, wins DESC, winrate DESC 
                LIMIT 1
            `);

            const recentActivityQuery = await DatabaseService.get(`
                SELECT COUNT(*) as recentGames
                FROM leaderboard 
                WHERE last_played > datetime('now', '-24 hours')
            `);

            const stats = {
                ...statsQuery,
                averageWinRate: Math.round(statsQuery.averageWinRate * 100) / 100,
                highestGlobalStreak: streakRecord ? streakRecord.value : 0,
                highestGlobalStreakPlayer: streakRecord ? streakRecord.player : null,
                highestGlobalStreakAt: streakRecord ? streakRecord.achieved_at : null,
                topPlayer: topPlayerQuery,
                recentGames: recentActivityQuery.recentGames
            };

            // Update cache
            this.cache.stats = stats;
            this.cache.statsLastUpdated = now;

            return stats;
        } catch (error) {
            logger.error('Failed to get leaderboard stats:', error);
            throw error;
        }
    }

    async getTopPlayers(limit = 10) {
        try {
            const query = `
                SELECT
                    ROW_NUMBER() OVER (ORDER BY points DESC, wins DESC, winrate DESC, name ASC) as rank,
                    name,
                    points,
                    wins,
                    fails,
                    duel_wins,
                    duel_losses,
                    coneflip_wins,
                    coneflip_losses,
                    current_streak,
                    highest_streak,
                    total_games,
                    winrate,
                    xp,
                    level
                FROM leaderboard
                WHERE total_games > 0 OR points > 0
                ORDER BY points DESC, wins DESC, winrate DESC, name ASC
                LIMIT ?
            `;

            return await DatabaseService.all(query, [limit]);
        } catch (error) {
            logger.error('Failed to get top players:', error);
            throw error;
        }
    }

    async getTopPlayerByLevel() {
        try {
            const query = `
                SELECT name, level, xp
                FROM leaderboard
                WHERE total_games > 0 OR points > 0
                ORDER BY level DESC, xp DESC, name ASC
                LIMIT 1
            `;
            const rows = await DatabaseService.all(query, []);
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            logger.error('Failed to get top player by level:', error);
            return null;
        }
    }

    async searchPlayers(searchTerm, limit = 20) {
        searchTerm = searchTerm.toLowerCase();
        try {
            const query = `
                SELECT
                    ROW_NUMBER() OVER (ORDER BY points DESC, wins DESC, winrate DESC, name ASC) as rank,
                    name,
                    points,
                    wins,
                    fails,
                    duel_wins,
                    duel_losses,
                    coneflip_wins,
                    coneflip_losses,
                    current_streak,
                    highest_streak,
                    total_games,
                    winrate,
                    xp,
                    level,
                    last_played
                FROM leaderboard
                WHERE name LIKE ?
                ORDER BY points DESC, wins DESC, winrate DESC, name ASC
                LIMIT ?
            `;

            return await DatabaseService.all(query, [`%${searchTerm}%`, limit]);
        } catch (error) {
            logger.error(`Failed to search players with term "${searchTerm}":`, error);
            throw error;
        }
    }

    async resetPlayer(name) {
        try {
            const result = await DatabaseService.run(`
                UPDATE leaderboard
                SET wins = 0, fails = 0, winrate = 0.0
                WHERE name = ?
            `, [name]);

            if (result.changes === 0) {
                throw new Error(`Player ${name} not found`);
            }

            logger.info(`Reset stats for player: ${name}`);

            // Clear cache
            this.clearCache();

            return this.getPlayer(name);
        } catch (error) {
            logger.error(`Failed to reset player ${name}:`, error);
            throw error;
        }
    }

    async resetAllPlayers() {
        try {
            // Reset all stats but keep player records and their skins intact
            const result = await DatabaseService.run(`
                UPDATE leaderboard
                SET points = 0,
                    wins = 0,
                    fails = 0,
                    duel_wins = 0,
                    duel_losses = 0,
                    coneflip_wins = 0,
                    coneflip_losses = 0,
                    current_streak = 0,
                    highest_streak = 0,
                    winrate = 0.0,
                    xp = 0,
                    level = 1,
                    last_played = CURRENT_TIMESTAMP
            `);

            // Also reset the global streak record
            await DatabaseService.run(`
                DELETE FROM records WHERE type = 'highest_streak'
            `);

            logger.info(`NUCLEAR RESET: All player stats have been obliterated! ${result.changes} players affected.`);

            // Log reset to data/resets.json
            try {
                const resetsPath = path.join(__dirname, '../../data/resets.json');
                let resets = [];
                if (fs.existsSync(resetsPath)) {
                    resets = JSON.parse(fs.readFileSync(resetsPath, 'utf8'));
                }
                resets.push({
                    date: new Date().toISOString(),
                    playersAffected: result.changes
                });
                fs.writeFileSync(resetsPath, JSON.stringify(resets, null, 2));
            } catch (logError) {
                logger.error('Failed to log reset to resets.json:', logError.message);
            }

            // Clear cache
            this.clearCache();

            return {
                success: true,
                message: 'All player scores have been nuked!',
                playersAffected: result.changes
            };
        } catch (error) {
            logger.error('Failed to reset all players:', error);
            throw error;
        }
    }

    async deletePlayer(name) {
        try {
            const result = await DatabaseService.run('DELETE FROM leaderboard WHERE name = ?', [name]);

            if (result.changes === 0) {
                throw new Error(`Player ${name} not found`);
            }

            logger.info(`Deleted player from leaderboard: ${name}`);

            // Clear cache
            this.clearCache();

            return { success: true, message: `Player ${name} deleted successfully` };
        } catch (error) {
            logger.error(`Failed to delete player ${name}:`, error);
            throw error;
        }
    }

    async editPlayerStats(name, stats) {
        name = name.toLowerCase();
        try {
            // Verify player exists
            const player = await this.getPlayer(name);
            if (!player.hasPlayed) {
                throw new Error(`Player ${name} not found`);
            }

            // Build update query dynamically based on provided stats
            const allowedFields = [
                'points', 'wins', 'fails', 'duel_wins', 'duel_losses',
                'coneflip_wins', 'coneflip_losses', 'current_streak',
                'highest_streak', 'xp', 'level'
            ];

            const updates = [];
            const values = [];

            for (const field of allowedFields) {
                if (stats[field] !== undefined && stats[field] !== null) {
                    const value = parseInt(stats[field]);
                    if (!isNaN(value) && value >= 0) {
                        updates.push(`${field} = ?`);
                        values.push(value);
                    }
                }
            }

            if (updates.length === 0) {
                return { success: false, message: 'No valid stats provided to update' };
            }

            // Calculate winrate if wins or fails changed
            if (stats.wins !== undefined || stats.fails !== undefined) {
                const newWins = stats.wins !== undefined ? parseInt(stats.wins) : player.wins;
                const newFails = stats.fails !== undefined ? parseInt(stats.fails) : player.fails;
                const totalGames = newWins + newFails;
                const winrate = totalGames > 0 ? (newWins / totalGames) * 100 : 0;
                updates.push('winrate = ?');
                values.push(winrate);
            }

            // Add last_played timestamp
            updates.push('last_played = CURRENT_TIMESTAMP');

            // Add player name to values for WHERE clause
            values.push(name);

            const query = `UPDATE leaderboard SET ${updates.join(', ')} WHERE name = ?`;
            const result = await DatabaseService.run(query, values);

            if (result.changes === 0) {
                throw new Error(`Failed to update player ${name}`);
            }

            logger.info(`Updated stats for player ${name}:`, stats);

            // Clear cache
            this.clearCache();

            return { success: true, message: `Stats updated for ${name}`, data: await this.getPlayer(name) };
        } catch (error) {
            logger.error(`Failed to edit stats for player ${name}:`, error);
            throw error;
        }
    }

    getPlayerStats(name) {
        // Just wrap getPlayer for compatibility
        return this.getPlayer(name);
    }

    clearCache() {
        this.cache.leaderboard = null;
        this.cache.lastUpdated = 0;
        this.cache.stats = null;
        this.cache.statsLastUpdated = 0;
        logger.debug('Leaderboard cache cleared');
    }

    // Format leaderboard message for chat
    formatPlayerStats(playerData) {
        if (!playerData.hasPlayed) {
            return playerData.message;
        }

        const duelStats = `${playerData.duelWins}W/${playerData.duelLosses}L`;
        const coneflipStats = `${playerData.coneflipWins}W/${playerData.coneflipLosses}L`;
        const streakInfo = playerData.currentStreak > 0 ? `${playerData.currentStreak} win streak` : 'no streak';
        
        return `${playerData.name} cone stats: #${playerData.rank} (${playerData.points} pts | Total: ${playerData.wins}W/${playerData.fails}L | Duels: ${duelStats} | Coneflips: ${coneflipStats} | Current: ${streakInfo} | Best: ${playerData.highestStreak} | WR: ${playerData.winrate.toFixed(2)}%)`;
    }

    formatLeaderboardStats(stats) {
        return `${stats.totalGamesPlayed} cones have been flipped by ${stats.playerCount} players with an average winrate of ${stats.averageWinRate.toFixed(2)}%!`;
    }
}

// Create singleton instance
const leaderboardService = new LeaderboardService();

module.exports = leaderboardService; 