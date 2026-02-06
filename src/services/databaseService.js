const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class DatabaseService {
    constructor() {
        this.leaderboardDb = null;
        this.skinsDb = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            logger.info('Initializing database service...');
            
            // Check if data directory exists
            const dataDir = path.join(process.cwd(), 'data');
            logger.info(`Checking data directory: ${dataDir}`);
            
            if (!fs.existsSync(dataDir)) {
                logger.info('Creating data directory...');
                fs.mkdirSync(dataDir, { recursive: true });
            } else {
                logger.info('Data directory exists');
            }

            // Initialize leaderboard database
            await this.initializeLeaderboardDb();
            
            // Initialize skins database  
            await this.initializeSkinsDb();
            
            this.initialized = true;
            logger.info('Database service initialized successfully');
            
        } catch (error) {
            logger.error('Failed to initialize database service:', error);
            throw error;
        }
    }

    async initializeLeaderboardDb() {
        return new Promise((resolve, reject) => {
            const dbPath = path.join(process.cwd(), 'data', 'leaderboard.db');
            logger.info(`Creating leaderboard database at: ${dbPath}`);
            
            this.leaderboardDb = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    logger.error('Failed to create leaderboard database:', err);
                    reject(err);
                    return;
                }
                
                logger.info('Setting database pragmas...');
                this.leaderboardDb.serialize(() => {
                    // Set pragmas for performance
                    const pragmas = [
                        'PRAGMA journal_mode = WAL',
                        'PRAGMA synchronous = NORMAL', 
                        'PRAGMA cache_size = 10000',
                        'PRAGMA temp_store = MEMORY'
                    ];
                    
                    pragmas.forEach(pragma => {
                        logger.info(pragma);
                        this.leaderboardDb.run(pragma);
                    });

                    logger.info('Creating leaderboard tables...');
                    const createTableSQL = `
                        CREATE TABLE IF NOT EXISTS leaderboard (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL UNIQUE,
                            twitchid TEXT UNIQUE,
                            points INTEGER DEFAULT 0 CHECK (points >= 0),
                            wins INTEGER DEFAULT 0,
                            fails INTEGER DEFAULT 0,
                            duel_wins INTEGER DEFAULT 0,
                            duel_losses INTEGER DEFAULT 0,
                            coneflip_wins INTEGER DEFAULT 0,
                            coneflip_losses INTEGER DEFAULT 0,
                            current_streak INTEGER DEFAULT 0,
                            highest_streak INTEGER DEFAULT 0,
                            xp INTEGER DEFAULT 0,
                            level INTEGER DEFAULT 1,
                            winrate REAL DEFAULT 0.0,
                            total_games INTEGER GENERATED ALWAYS AS (wins + fails) STORED,
                            total_duels INTEGER GENERATED ALWAYS AS (duel_wins + duel_losses) STORED,
                            total_coneflips INTEGER GENERATED ALWAYS AS (coneflip_wins + coneflip_losses) STORED,
                            last_played DATETIME DEFAULT CURRENT_TIMESTAMP,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        );
                    `;
                    logger.info(createTableSQL);
                    this.leaderboardDb.run(createTableSQL);

                    logger.info('Creating leaderboard indexes...');
                    const indexes = [
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_name ON leaderboard(name);',
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_twitchid ON leaderboard(twitchid);',
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_points ON leaderboard(points DESC);',
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_winrate ON leaderboard(winrate DESC);',
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_wins ON leaderboard(wins DESC);',
                        'CREATE INDEX IF NOT EXISTS idx_leaderboard_level ON leaderboard(level DESC, xp DESC);'
                    ];
                    
                    indexes.forEach(index => {
                        logger.info(index);
                        this.leaderboardDb.run(index);
                    });

                    // Add missing columns if they don't exist (migration safety)
                    logger.info('Checking for missing streak columns...');
                    this.leaderboardDb.run('ALTER TABLE leaderboard ADD COLUMN current_streak INTEGER DEFAULT 0', (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            logger.warn('Warning adding current_streak column:', err.message);
                        } else if (!err) {
                            logger.info('Added current_streak column');
                        }
                    });
                    
                    this.leaderboardDb.run('ALTER TABLE leaderboard ADD COLUMN highest_streak INTEGER DEFAULT 0', (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            logger.warn('Warning adding highest_streak column:', err.message);
                        } else if (!err) {
                            logger.info('Added highest_streak column');
                        }
                    });

                    // Initialize streak values for existing players
                    this.leaderboardDb.run(`
                        UPDATE leaderboard
                        SET highest_streak = wins
                        WHERE highest_streak = 0 AND wins > 0
                    `);

                    // Add XP and Level columns if they don't exist (migration safety)
                    logger.info('Checking for XP/Level columns...');
                    this.leaderboardDb.run('ALTER TABLE leaderboard ADD COLUMN xp INTEGER DEFAULT 0', (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            logger.warn('Warning adding xp column:', err.message);
                        } else if (!err) {
                            logger.info('Added xp column');
                        }
                    });

                    this.leaderboardDb.run('ALTER TABLE leaderboard ADD COLUMN level INTEGER DEFAULT 1', (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            logger.warn('Warning adding level column:', err.message);
                        } else if (!err) {
                            logger.info('Added level column');
                        }
                    });

                    // Initialize XP for existing players based on their game history
                    // Formula: coneflip_wins*50 + coneflip_losses*20 + duel_wins*100 + duel_losses*20
                    this.leaderboardDb.run(`
                        UPDATE leaderboard
                        SET xp = (coneflip_wins * 50) + (coneflip_losses * 20) + (duel_wins * 100) + (duel_losses * 20)
                        WHERE xp = 0 AND (wins > 0 OR fails > 0)
                    `, (err) => {
                        if (err) {
                            logger.warn('Warning initializing XP for existing players:', err.message);
                        } else {
                            logger.info('Initialized XP for existing players');
                        }
                    });

                    // Calculate and set levels for existing players based on their XP
                    // Level formula: XP needed = 100 * 1.3^(level-1)
                    // We need to calculate this in JS after fetching, but set level=1 for now
                    // The XP service will recalculate on first access

                    logger.info('Creating leaderboard triggers...');
                    const triggerSQL = `
                        CREATE TRIGGER IF NOT EXISTS update_leaderboard_stats
                        AFTER UPDATE OF wins, fails, duel_wins, duel_losses, coneflip_wins, coneflip_losses ON leaderboard
                        BEGIN
                            UPDATE leaderboard
                            SET
                                wins = NEW.duel_wins + NEW.coneflip_wins,
                                fails = NEW.duel_losses + NEW.coneflip_losses,
                                winrate = CASE
                                    WHEN (NEW.wins + NEW.fails) = 0 THEN 0.0
                                    ELSE ROUND((NEW.wins * 100.0) / (NEW.wins + NEW.fails), 2)
                                END,
                                updated_at = CURRENT_TIMESTAMP,
                                last_played = CURRENT_TIMESTAMP
                            WHERE id = NEW.id;
                        END;
                    `;
                    logger.info(triggerSQL);
                    this.leaderboardDb.run(triggerSQL);

                    logger.info('Creating records table...');
                    const createRecordsTableSQL = `
                        CREATE TABLE IF NOT EXISTS records (
                            type TEXT PRIMARY KEY,
                            value INTEGER NOT NULL,
                            player TEXT,
                            achieved_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        );
                    `;
                    logger.info(createRecordsTableSQL);
                    this.leaderboardDb.run(createRecordsTableSQL);

                    logger.info('Leaderboard database initialized successfully');
                    resolve();
                });
            });
        });
    }

    async initializeSkinsDb() {
        return new Promise((resolve, reject) => {
            const dbPath = path.join(process.cwd(), 'data', 'skins.db');
            logger.info(`Creating skins database at: ${dbPath}`);
            
            this.skinsDb = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    logger.error('Failed to create skins database:', err);
                    reject(err);
                    return;
                }
                
                logger.info('Setting skins database pragmas...');
                this.skinsDb.serialize(() => {
                    // Set pragmas for performance
                    const pragmas = [
                        'PRAGMA journal_mode = WAL',
                        'PRAGMA synchronous = NORMAL',
                        'PRAGMA cache_size = 10000', 
                        'PRAGMA temp_store = MEMORY'
                    ];
                    
                    pragmas.forEach(pragma => {
                        logger.info(pragma);
                        this.skinsDb.run(pragma);
                    });

                    logger.info('Creating skins tables...');
                    const tables = [
                        `CREATE TABLE IF NOT EXISTS user_skins (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL UNIQUE,
                            twitchid TEXT,
                            skin TEXT NOT NULL DEFAULT 'default',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        );`,
                        `CREATE TABLE IF NOT EXISTS skin_inventory (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL,
                            twitchid TEXT,
                            skin TEXT NOT NULL,
                            quantity INTEGER DEFAULT 1,
                            obtained_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(name, skin)
                        );`,
                        `CREATE TABLE IF NOT EXISTS contest_votes (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            submission_id TEXT NOT NULL,
                            ip_address TEXT,
                            twitch_user_id TEXT,
                            twitch_username TEXT,
                            voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(submission_id, ip_address),
                            UNIQUE(submission_id, twitch_user_id)
                        );`,
                        `CREATE TABLE IF NOT EXISTS user_trails (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL UNIQUE,
                            twitchid TEXT,
                            trail TEXT NOT NULL DEFAULT 'default',
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                        );`,
                        `CREATE TABLE IF NOT EXISTS trail_inventory (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            name TEXT NOT NULL,
                            twitchid TEXT,
                            trail TEXT NOT NULL,
                            quantity INTEGER DEFAULT 1,
                            obtained_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            UNIQUE(name, trail)
                        );`
                    ];
                    
                    tables.forEach(table => {
                        logger.info(table);
                        this.skinsDb.run(table);
                    });

                    logger.info('Creating skins indexes...');
                    const indexes = [
                        'CREATE INDEX IF NOT EXISTS idx_user_skins_name ON user_skins(name);',
                        'CREATE INDEX IF NOT EXISTS idx_user_skins_twitchid ON user_skins(twitchid);',
                        'CREATE INDEX IF NOT EXISTS idx_skin_inventory_name ON skin_inventory(name);',
                        'CREATE INDEX IF NOT EXISTS idx_skin_inventory_skin ON skin_inventory(skin);',
                        'CREATE INDEX IF NOT EXISTS idx_contest_votes_submission ON contest_votes(submission_id);',
                        'CREATE INDEX IF NOT EXISTS idx_contest_votes_ip ON contest_votes(ip_address);',
                        'CREATE INDEX IF NOT EXISTS idx_user_trails_name ON user_trails(name);',
                        'CREATE INDEX IF NOT EXISTS idx_user_trails_twitchid ON user_trails(twitchid);',
                        'CREATE INDEX IF NOT EXISTS idx_trail_inventory_name ON trail_inventory(name);',
                        'CREATE INDEX IF NOT EXISTS idx_trail_inventory_trail ON trail_inventory(trail);'
                    ];
                    
                    indexes.forEach(index => {
                        logger.info(index);
                        this.skinsDb.run(index);
                    });

                    logger.info('Creating skins triggers...');
                    const triggerSQL = `
                        CREATE TRIGGER IF NOT EXISTS update_user_skins_timestamp
                        AFTER UPDATE ON user_skins
                        BEGIN
                            UPDATE user_skins SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                        END;
                    `;
                    logger.info(triggerSQL);
                    this.skinsDb.run(triggerSQL);

                    // Add shuffle column if it doesn't exist (migration safety)
                    this.skinsDb.run('ALTER TABLE user_skins ADD COLUMN shuffle INTEGER DEFAULT 0', (err) => {
                        if (err && !err.message.includes('duplicate column name')) {
                            logger.warn('Warning adding shuffle column:', err.message);
                        } else if (!err) {
                            logger.info('Added shuffle column to user_skins');
                        }
                    });

                    logger.info('Skins database initialized successfully');
                    resolve();
                });
            });
        });
    }

    // Database getter methods (for compatibility)
    getLeaderboardDb() {
        if (!this.initialized || !this.leaderboardDb) {
            throw new Error('Leaderboard database not initialized');
        }
        return this.leaderboardDb;
    }

    getSkinsDb() {
        if (!this.initialized || !this.skinsDb) {
            throw new Error('Skins database not initialized');
        }
        return this.skinsDb;
    }

    // Async wrapper methods for compatibility with new code
    async get(query, params = []) {
        return new Promise((resolve, reject) => {
            this.leaderboardDb.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    async all(query, params = []) {
        return new Promise((resolve, reject) => {
            this.leaderboardDb.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async run(query, params = []) {
        return new Promise((resolve, reject) => {
            this.leaderboardDb.run(query, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    // Skin-specific async methods
    async getPlayerSkin(username) {
        return new Promise((resolve, reject) => {
            this.skinsDb.get('SELECT skin FROM user_skins WHERE name = ?', [username], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.skin : 'default');
            });
        });
    }

    async setPlayerSkin(username, skinName, twitchId = null) {
        return new Promise((resolve, reject) => {
            this.skinsDb.run(
                `INSERT INTO user_skins (name, twitchid, skin) VALUES (?, ?, ?)
                 ON CONFLICT(name) DO UPDATE SET skin = excluded.skin, twitchid = COALESCE(excluded.twitchid, twitchid)`,
                [username, twitchId, skinName],
                function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                }
            );
        });
    }

    async getPlayerShuffle(username) {
        return new Promise((resolve, reject) => {
            this.skinsDb.get('SELECT shuffle FROM user_skins WHERE name = ?', [username], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.shuffle === 1 : false);
            });
        });
    }

    async setPlayerShuffle(username, enabled) {
        return new Promise((resolve, reject) => {
            this.skinsDb.run(
                `UPDATE user_skins SET shuffle = ? WHERE name = ?`,
                [enabled ? 1 : 0, username],
                function(err) {
                    if (err) reject(err);
                    else resolve({ changes: this.changes });
                }
            );
        });
    }

    async getPlayerInventory(username) {
        return new Promise((resolve, reject) => {
            this.skinsDb.all(
                'SELECT skin, quantity, obtained_at FROM skin_inventory WHERE name = ? ORDER BY obtained_at DESC',
                [username],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getAllUserSkins() {
        return new Promise((resolve, reject) => {
            this.skinsDb.all('SELECT name, skin FROM user_skins ORDER BY name', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    async addSkinToInventory(username, skinName, twitchId = null, quantity = 1) {
        return new Promise((resolve, reject) => {
            // Use INSERT OR REPLACE to handle duplicates properly
            this.skinsDb.run(
                `INSERT INTO skin_inventory (name, twitchid, skin, quantity) 
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(name, skin) DO UPDATE SET 
                 quantity = quantity + excluded.quantity,
                 obtained_at = CURRENT_TIMESTAMP`,
                [username, twitchId, skinName, quantity],
                function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                }
            );
        });
    }

    // Trail-specific async methods
    async getPlayerTrail(username) {
        return new Promise((resolve, reject) => {
            this.skinsDb.get('SELECT trail FROM user_trails WHERE name = ?', [username], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.trail : 'default');
            });
        });
    }

    async setPlayerTrail(username, trailName, twitchId = null) {
        return new Promise((resolve, reject) => {
            this.skinsDb.run(
                `INSERT OR REPLACE INTO user_trails (name, twitchid, trail) VALUES (?, ?, ?)`,
                [username, twitchId, trailName],
                function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                }
            );
        });
    }

    async getPlayerTrailInventory(username) {
        return new Promise((resolve, reject) => {
            this.skinsDb.all(
                'SELECT trail, quantity, obtained_at FROM trail_inventory WHERE name = ? ORDER BY obtained_at DESC',
                [username],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getAllUserTrails() {
        return new Promise((resolve, reject) => {
            this.skinsDb.all('SELECT name, trail FROM user_trails ORDER BY name', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    async addTrailToInventory(username, trailName, twitchId = null, quantity = 1) {
        return new Promise((resolve, reject) => {
            // Use INSERT OR REPLACE to handle duplicates properly
            this.skinsDb.run(
                `INSERT INTO trail_inventory (name, twitchid, trail, quantity) 
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(name, trail) DO UPDATE SET 
                 quantity = quantity + excluded.quantity,
                 obtained_at = CURRENT_TIMESTAMP`,
                [username, twitchId, trailName, quantity],
                function(err) {
                    if (err) reject(err);
                    else resolve({ lastID: this.lastID, changes: this.changes });
                }
            );
        });
    }

    // Contest voting methods
    async addContestVote(submissionId, ipAddress, twitchUserId = null, twitchUsername = null) {
        return new Promise((resolve, reject) => {
            const query = 'INSERT INTO contest_votes (submission_id, ip_address, twitch_user_id, twitch_username) VALUES (?, ?, ?, ?)';
            const params = [submissionId, ipAddress, twitchUserId, twitchUsername];
            
            this.skinsDb.run(query, params, function(err) {
                if (err) {
                    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        if (twitchUserId) {
                            reject(new Error('Twitch user has already voted for this submission'));
                        } else {
                            reject(new Error('IP address has already voted for this submission'));
                        }
                    } else {
                        reject(err);
                    }
                } else {
                    resolve({ lastID: this.lastID, changes: this.changes });
                }
            });
        });
    }

    async getContestVoteCount(submissionId) {
        return new Promise((resolve, reject) => {
            this.skinsDb.get(
                'SELECT COUNT(*) as count FROM contest_votes WHERE submission_id = ?',
                [submissionId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? row.count : 0);
                }
            );
        });
    }

    async hasUserVoted(submissionId, ipAddress, twitchUserId = null) {
        return new Promise((resolve, reject) => {
            let query, params;
            
            // Check Twitch user first if available
            if (twitchUserId) {
                query = 'SELECT id FROM contest_votes WHERE submission_id = ? AND twitch_user_id = ?';
                params = [submissionId, twitchUserId];
            } else {
                query = 'SELECT id FROM contest_votes WHERE submission_id = ? AND ip_address = ?';
                params = [submissionId, ipAddress];
            }
            
            this.skinsDb.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(!!row);
            });
        });
    }

    async getAllContestVotes() {
        return new Promise((resolve, reject) => {
            this.skinsDb.all(
                `SELECT submission_id, COUNT(*) as vote_count 
                 FROM contest_votes 
                 GROUP BY submission_id 
                 ORDER BY vote_count DESC`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async removeContestVote(submissionId, ipAddress, twitchUserId = null) {
        return new Promise((resolve, reject) => {
            let query, params;
            
            // Remove by Twitch user ID if available
            if (twitchUserId) {
                query = 'DELETE FROM contest_votes WHERE submission_id = ? AND twitch_user_id = ?';
                params = [submissionId, twitchUserId];
            } else {
                query = 'DELETE FROM contest_votes WHERE submission_id = ? AND ip_address = ?';
                params = [submissionId, ipAddress];
            }
            
            this.skinsDb.run(query, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ changes: this.changes });
                }
            });
        });
    }

    async getUserVotes(ipAddress, twitchUserId = null) {
        return new Promise((resolve, reject) => {
            let query, params;
            
            // Get votes by Twitch user ID if available
            if (twitchUserId) {
                query = 'SELECT submission_id, voted_at FROM contest_votes WHERE twitch_user_id = ?';
                params = [twitchUserId];
            } else {
                query = 'SELECT submission_id, voted_at FROM contest_votes WHERE ip_address = ?';
                params = [ipAddress];
            }
            
            this.skinsDb.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    healthCheck() {
        try {
            return {
                status: 'healthy',
                leaderboard: {
                    connected: !!this.leaderboardDb,
                    initialized: this.initialized
                },
                skins: {
                    connected: !!this.skinsDb,
                    initialized: this.initialized
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    async shutdown() {
        try {
            if (this.leaderboardDb) {
                await new Promise((resolve) => {
                    this.leaderboardDb.close(resolve);
                });
            }
            if (this.skinsDb) {
                await new Promise((resolve) => {
                    this.skinsDb.close(resolve);
                });
            }
            logger.info('Database connections closed');
        } catch (error) {
            logger.error('Error shutting down database:', error);
        }
    }
}

module.exports = new DatabaseService();