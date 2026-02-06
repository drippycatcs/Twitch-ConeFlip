#!/usr/bin/env node
require('dotenv').config();

// Main server entry point - because someone has to start this mess

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');

const { config, validateEnvironment } = require('./config/environment');
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');
const { requireToken } = require('./middleware/tokenAuth');

// Route imports
const gameRoutes = require('./routes/gameRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const skinsRoutes = require('./routes/skinsRoutes');
const trailRoutes = require('./routes/trailRoutes');
const debugRoutes = require('./routes/debugRoutes');
const setupRoutes = require('./routes/setupRoutes');
const contestRoutes = require('./routes/contestRoutes');
const authRoutes = require('./routes/authRoutes');
const publicRoutes = require('./routes/publicRoutes');

// Service imports
const DatabaseService = require('./services/databaseService');
const ConfigService = require('./services/configService');
const TokenService = require('./services/tokenService');
const SkinService = require('./services/skinService');
const TrailService = require('./services/trailService');
const LeaderboardService = require('./services/leaderboardService');
const TwitchService = require('./services/twitchService');
const GameService = require('./services/gameService');

// WebSocket handler
const SocketHandler = require('./websocket/socketHandler');

// Community directory ping (registers this instance at drippycat.lol/api/community)
const CommunityService = require('./services/communityService');

// Escape HTML entities to prevent XSS in meta tags
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

class Server {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        const corsOrigins = process.env.CORS_ORIGINS
            ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
            : (config.NODE_ENV === 'production' ? [config.BASE_URL] : '*');

        this.io = socketIo(this.server, {
            cors: {
                origin: corsOrigins,
                methods: ["GET", "POST"]
            }
        });
        
        this.socketHandler = null;
        this.isShuttingDown = false;
        this.htmlTemplates = {};
    }

    async initialize() {
        try {
            logger.info('Starting ConeFlip V2 server initialization...');
            
            // Validate environment first
            await validateEnvironment();
            
            // Initialize database
            await DatabaseService.initialize();
            logger.info('✓ Database service initialized');

            // Initialize configuration service
            await ConfigService.initialize();
            logger.info('✓ Configuration service initialized');

            // Initialize token service
            await TokenService.initialize();
            logger.info('✓ Token service initialized');

            // Initialize skin service
            await SkinService.initialize();
            logger.info('✓ Skin service initialized');
            
            // Initialize trail service
            await TrailService.initialize();
            logger.info('✓ Trail service initialized');
            
            // Initialize leaderboard service
            await LeaderboardService.initialize(); 
            logger.info('✓ Leaderboard service initialized');

            // Initialize Twitch service
            await TwitchService.initialize();
            logger.info('✓ Twitch service initialized');
            
            // Initialize game service
            await GameService.initialize();
            logger.info('✓ Game service initialized');

            // Connect services to TwitchService for chat commands
            TwitchService.setServices(GameService, LeaderboardService, SkinService, TrailService);
            logger.info('✓ TwitchService connected to other services');

            // Setup WebSocket handler
            this.socketHandler = new SocketHandler(this.io);
            await this.socketHandler.initialize();
            logger.info('✓ WebSocket handler initialized');

            // Connect services to socket handler
            debugRoutes.setSocketHandler(this.socketHandler);
            GameService.setSocketHandler(this.socketHandler);
            TwitchService.setSocketHandler(this.socketHandler);
            TokenService.setSocketHandler(this.socketHandler);
            SkinService.setSocketHandler(this.socketHandler);
            SkinService.trailService = TrailService;
            TrailService.setSocketHandler(this.socketHandler);

            this.setupMiddleware();
            this.cacheHTMLTemplates();
            this.setupRoutes();
            this.setupErrorHandling();

            logger.info('✓ Server initialization completed successfully');
            
        } catch (error) {
            logger.error('Failed to initialize server:', error);
            process.exit(1);
        }
    }

    async setupDirectories() {
        // Ensure data directories exist
        const fs = require('fs').promises;
        const directories = [
            path.join(__dirname, '../data'),
            path.join(__dirname, '../data/sessions'),
            path.join(__dirname, '../logs'),
            path.join(__dirname, '../uploads')
        ];

        for (const dir of directories) {
            try {
                await fs.mkdir(dir, { recursive: true });
                logger.info(`Directory ensured: ${dir}`);
            } catch (error) {
                logger.error(`Failed to create directory ${dir}:`, error);
            }
        }
    }

    setupMiddleware() {
        // Trust proxy for proper IP detection and HTTPS handling
        this.app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1'));

        // Security headers
        this.app.use(helmet({ contentSecurityPolicy: false }));

        // HTTPS redirect temporarily disabled to fix redirect loop
        // Force HTTPS in production for session security (with better proxy detection)
        if (config.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true') {
            this.app.use((req, res, next) => {
                const proto = req.header('x-forwarded-proto') || 
                             req.header('x-forwarded-protocol') || 
                             req.header('x-url-scheme') ||
                             req.header('x-scheme') ||
                             (req.secure ? 'https' : 'http');
                
                const isHttps = proto === 'https' || req.secure || req.header('x-forwarded-ssl') === 'on';
                
                // Only redirect if definitely not HTTPS and not already redirected
                if (!isHttps && !req.url.includes('redirect_loop_check')) {
                    logger.info(`HTTPS redirect: ${proto} -> https for ${req.url}`);
                    return res.redirect(301, `https://${req.header('host')}${req.url}`);
                }
                next();
            });
        }
        
        // Security and CORS
        const corsOrigins = process.env.CORS_ORIGINS
            ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
            : (config.NODE_ENV === 'production' ? [config.BASE_URL] : '*');
        this.app.use(cors({ origin: corsOrigins }));
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
        
        // Session middleware for OAuth authentication
        this.app.use(session({
            store: new FileStore({
                path: path.join(__dirname, '../data/sessions'),
                retries: 0,
                ttl: 86400 // 24 hours in seconds
            }),
            secret: config.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
            cookie: {
                secure: process.env.COOKIE_SECURE === 'true' ? true : (process.env.COOKIE_SECURE === 'false' ? false : 'auto'),
                httpOnly: true,
                maxAge: 24 * 60 * 60 * 1000, // 24 hours
                sameSite: 'lax'
            }
        }));
        
        // Cache control for HTML files - must be BEFORE express.static
        this.app.use((req, res, next) => {
            if (req.url.endsWith('.html') || req.url === '/' || req.url.match(/^\/[^.]*$/)) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
            next();
        });

        // Static files with cache headers (HTML excluded by middleware above)
        const staticOptions = { maxAge: '7d' };
        this.app.use(express.static(path.join(__dirname, '../public'), staticOptions));
        this.app.use('/site', express.static(path.join(__dirname, '../site'), staticOptions));
        this.app.use('/uploads', express.static(path.join(__dirname, '../uploads'), staticOptions));

        // Request logging with better IP detection
        this.app.use((req, res, next) => {
            const realIp = this.getRealIP(req);
            logger.info(`${req.method} ${req.url}`, {
                ip: realIp,
                userAgent: req.get('User-Agent')
            });
            next();
        });
    }

    cacheHTMLTemplates() {
        const fs = require('fs');
        const templateFiles = {
            profile: path.join(__dirname, '../public/profile.html'),
            leaderboardPublic: path.join(__dirname, '../public/leaderboard-public.html'),
            skinsAll: path.join(__dirname, '../public/skins-all.html'),
            trailsAll: path.join(__dirname, '../public/trails-all.html'),
            contest: path.join(__dirname, '../public/contest.html')
        };

        for (const [name, filePath] of Object.entries(templateFiles)) {
            try {
                this.htmlTemplates[name] = fs.readFileSync(filePath, 'utf8');
                logger.info(`Cached HTML template: ${name}`);
            } catch (error) {
                logger.warn(`Failed to cache HTML template ${name}: ${error.message}`);
            }
        }
    }

    setupRoutes() {
        // Authentication routes
        this.app.use('/auth', authRoutes);
        
        // API routes
        this.app.use('/api/game', gameRoutes);
        this.app.use('/api/leaderboard', leaderboardRoutes);
        this.app.use('/api/skins', skinsRoutes);
        this.app.use('/api/trails', trailRoutes);
        this.app.use('/api/debug', debugRoutes);
        this.app.use('/api/setup', setupRoutes);
        this.app.use('/api/contest', contestRoutes);
        this.app.use('/api/public', publicRoutes);

        // Main routes - protected by token authentication
        this.app.get('/', requireToken, (req, res) => {
            res.sendFile(path.join(__dirname, '../public/index.html'));
        });
        
        this.app.get('/leaderboard', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/leaderboard.html'));
        });
        
        this.app.get('/unbox', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/unbox.html'));
        });
        
        this.app.get('/admin', (req, res) => {
            // Check if user is authenticated and is admin
            if (!req.session.user || !req.session.user.id) {
                return res.redirect('/auth/login');
            }
            
            if (!req.session.user.is_admin) {
                return res.status(403).send(`
                    <html>
                        <head><title>ConeFlip - Access Denied</title></head>
                        <body style="font-family: Arial; text-align: center; padding: 50px;">
                            <h1>🚫 Access Denied</h1>
                            <p>You don't have admin access to this panel.</p>
                            <p>Only the streamer and configured admins can access this area.</p>
                            <a href="/" style="color: #3b82f6; text-decoration: none;">← Back to Home</a>
                        </body>
                    </html>
                `);
            }
            
            res.sendFile(path.join(__dirname, '../public/admin.html'));
        });

        this.app.get('/mod', (req, res) => {
            // Check if user is authenticated and is moderator
            if (!req.session.user || !req.session.user.id) {
                return res.redirect('/auth/login');
            }

            // Check moderator status LIVE (not just from session)
            // This allows moderators added after login to access without re-logging
            const AuthService = require('./services/authService');
            const isModerator = AuthService.isModerator(req.session.user);

            // Update session if moderator status changed
            if (isModerator !== req.session.user.is_moderator) {
                req.session.user.is_moderator = isModerator;
                logger.info(`Updated moderator status for ${req.session.user.login}: ${isModerator}`);
            }

            if (!isModerator) {
                return res.status(403).send(`
                    <html>
                        <head><title>ConeFlip - Access Denied</title></head>
                        <body style="font-family: Arial; text-align: center; padding: 50px;">
                            <h1>🚫 Access Denied</h1>
                            <p>You don't have moderator access to this panel.</p>
                            <p>Only moderators can access this area.</p>
                            <a href="/" style="color: #3b82f6; text-decoration: none;">← Back to Home</a>
                        </body>
                    </html>
                `);
            }

            res.sendFile(path.join(__dirname, '../public/mod.html'));
        });

        this.app.get('/skins/submissions', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/skins-submissions.html'));
        });

        // Public profile pages for cone flippers
        this.app.get('/u/', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/profile.html'));
        });
        
        this.app.get('/u/:name', async (req, res) => {
            const playerName = req.params.name;
            
            try {
                // Fetch player data for metadata
                const LeaderboardService = require('./services/leaderboardService');
                const playerData = await LeaderboardService.getPlayer(playerName);
                
                if (playerData && playerData.name) {
                    // Generate dynamic HTML with metadata
                    const html = await this.generateProfileHTML(playerData);
                    res.send(html);
                } else {
                    // Player not found, serve default profile page
                    res.sendFile(path.join(__dirname, '../public/profile.html'));
                }
            } catch (error) {
                logger.error('Error generating profile HTML:', error);
                // Fallback to static file
                res.sendFile(path.join(__dirname, '../public/profile.html'));
            }
        });

        // New public pages without .html extension
        this.app.get('/commands', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/commands.html'));
        });
        
        this.app.get('/leaderboard-public', async (req, res) => {
            try {
                // Fetch top 10 players for metadata
                const LeaderboardService = require('./services/leaderboardService');
                const leaderboardData = await LeaderboardService.getLeaderboard(1, 10);
                
                if (leaderboardData && leaderboardData.data && leaderboardData.data.length > 0) {
                    // Generate dynamic HTML with top 10 data
                    const html = this.generateLeaderboardHTML(leaderboardData.data);
                    res.send(html);
                } else {
                    // No data available, serve default leaderboard page
                    res.sendFile(path.join(__dirname, '../public/leaderboard-public.html'));
                }
            } catch (error) {
                logger.error('Error generating leaderboard HTML:', error);
                // Fallback to static file
                res.sendFile(path.join(__dirname, '../public/leaderboard-public.html'));
            }
        });
        
        this.app.get('/skins', async (req, res) => {
            try {
                // Get skin statistics for metadata
                const SkinService = require('./services/skinService');
                const skinStats = SkinService.getSkinStats();
                
                if (skinStats) {
                    // Generate dynamic HTML with skin stats
                    const html = this.generateSkinsHTML(skinStats);
                    res.send(html);
                } else {
                    // No stats available, serve default skins page
                    res.sendFile(path.join(__dirname, '../public/skins-all.html'));
                }
            } catch (error) {
                logger.error('Error generating skins HTML:', error);
                // Fallback to static file
                res.sendFile(path.join(__dirname, '../public/skins-all.html'));
            }
        });
        
        this.app.get('/trails', async (req, res) => {
            try {
                // Get trail statistics for metadata
                const TrailService = require('./services/trailService');
                const trailStats = await TrailService.getTrailStats();
                
                if (trailStats) {
                    // Generate dynamic HTML with trail stats
                    const html = this.generateTrailsHTML(trailStats);
                    res.send(html);
                } else {
                    // No stats available, serve default trails page
                    res.sendFile(path.join(__dirname, '../public/trails-all.html'));
                }
            } catch (error) {
                logger.error('Error generating trails HTML:', error);
                // Fallback to static file
                res.sendFile(path.join(__dirname, '../public/trails-all.html'));
            }
        });
        
        this.app.get('/contest', async (req, res) => {
            try {
                // Get contest data for metadata
                const fs = require('fs');
                const contestPath = path.join(__dirname, '../public/contest.json');
                
                if (fs.existsSync(contestPath)) {
                    const contestData = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
                    
                    if (contestData) {
                        // Generate dynamic HTML with contest data
                        const html = this.generateContestHTML(contestData);
                        res.send(html);
                    } else {
                        // No contest data, serve default contest page
                        res.sendFile(path.join(__dirname, '../public/contest.html'));
                    }
                } else {
                    // No contest file, serve default contest page
                    res.sendFile(path.join(__dirname, '../public/contest.html'));
                }
            } catch (error) {
                logger.error('Error generating contest HTML:', error);
                // Fallback to static file
                res.sendFile(path.join(__dirname, '../public/contest.html'));
            }
        });
        
        this.app.get('/changelog', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/changelog.html'));
        });
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });
        
        // Legacy 7TV API redirects for backward compatibility
        this.app.get('/api/7tv/paint', (req, res) => {
            const name = req.query.name;
            if (name) {
                res.redirect(301, `/api/skins/paint?name=${encodeURIComponent(name)}`);
            } else {
                res.status(400).json({ error: 'Missing name parameter' });
            }
        });
        
        this.app.get('/api/7tv/emote/:text', (req, res) => {
            res.redirect(301, `/api/skins/emote/${encodeURIComponent(req.params.text)}`);
        });

    }

    async generateProfileHTML(playerData) {
        const winrate = Math.round(playerData.winrate * 100) / 100 || 0;
        const totalGames = (playerData.wins || 0) + (playerData.fails || 0);
        const currentStreak = playerData.current_streak || 0;
        const highestStreak = playerData.highest_streak || 0;
        
        // Create dynamic metadata with better formatting
        const title = escapeHtml(`${playerData.name}'s ConeFlip Stats`);
        const streakText = currentStreak > 0 ? `${currentStreak} Win Streak` : 'No Active Streak';
        const description = escapeHtml(`Rank: #${playerData.rank || 'Unranked'}\nRecord: ${playerData.wins || 0}W - ${playerData.fails || 0}L (${winrate}% WR)\n${streakText}`);

        // Use a static fallback image for OG embeds
        const baseUrl = process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? 'https://coneflip.com' : 'http://localhost:3000');
        const ogImageUrl = `${baseUrl}/logo.png`;
        
        // Use cached HTML template
        const baseHTML = this.htmlTemplates.profile;
        if (!baseHTML) return '';

        // Update meta tags with improved formatting
        const updatedHTML = baseHTML
            .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="description" content=".*?"/, `<meta name="description" content="${description.replace(/\n/g, ' ')}"`)
            .replace(/<meta property="og:title" content=".*?"/, `<meta property="og:title" content="${title}"`)
            .replace(/<meta property="og:description" content=".*?"/, `<meta property="og:description" content="${description}"`)
            .replace(/<meta property="og:image" content=".*?"/, `<meta property="og:image" content="${ogImageUrl}"`)
            .replace(/<meta property="og:image:width" content=".*?"/, `<meta property="og:image:width" content="1200"`)
            .replace(/<meta property="og:image:height" content=".*?"/, `<meta property="og:image:height" content="630"`)
            .replace(/<meta property="twitter:title" content=".*?"/, `<meta property="twitter:title" content="${title}"`)
            .replace(/<meta property="twitter:description" content=".*?"/, `<meta property="twitter:description" content="${description}"`)
            .replace(/<meta property="twitter:image" content=".*?"/, `<meta property="twitter:image" content="${ogImageUrl}"`)
            .replace(/<meta property="twitter:card" content=".*?"/, `<meta property="twitter:card" content="summary_large_image"`);
        
        return updatedHTML;
    }

    generateLeaderboardHTML(leaderboardData) {
        // Use cached HTML template
        const baseHTML = this.htmlTemplates.leaderboardPublic;
        if (!baseHTML) return '';
        
        // Create dynamic metadata for the leaderboard
        const title = '🏆 ConeFlip Leaderboard - Top 100 Players';
        const description = `Check out the top ConeFlip players! View stats, win rates, streaks, and rankings.`;
        
        // Update only specific meta tags
        const updatedHTML = baseHTML
            .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="description" content=".*?"/, `<meta name="description" content="${description}"`)
            .replace(/<meta property="og:title" content=".*?"/, `<meta property="og:title" content="${title}"`)
            .replace(/<meta property="og:description" content=".*?"/, `<meta property="og:description" content="${description}"`)
            .replace(/<meta property="twitter:title" content=".*?"/, `<meta property="twitter:title" content="${title}"`)
            .replace(/<meta property="twitter:description" content=".*?"/, `<meta property="twitter:description" content="${description}"`);
        
        return updatedHTML;
    }

    generateSkinsHTML(skinStats) {
        // Use cached HTML template
        const baseHTML = this.htmlTemplates.skinsAll;
        if (!baseHTML) return '';
        
        // Create dynamic metadata for the skins page
        const title = ' All ConeFlip Skins!';
        const totalSkins = skinStats.totalAvailableSkins || 0;
        const unboxableSkins = skinStats.unboxableSkins || 0;
        const totalUsers = skinStats.userStats?.total_users || 0;
        
        const description = `Explore ${totalSkins} unique ConeFlip skins! ${unboxableSkins} unboxable skins available.`;
        
        // Update only specific meta tags
        const updatedHTML = baseHTML
            .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="description" content=".*?"/, `<meta name="description" content="${description}"`)
            .replace(/<meta name="keywords" content=".*?"/, `<meta name="keywords" content="ConeFlip, skins, cone skins, gaming, collectibles, rare skins, custom designs, animations, ${totalSkins} skins"`)
            .replace(/<meta property="og:title" content=".*?"/, `<meta property="og:title" content="${title}"`)
            .replace(/<meta property="og:description" content=".*?"/, `<meta property="og:description" content="${description}"`)
            .replace(/<meta property="twitter:title" content=".*?"/, `<meta property="twitter:title" content="${title}"`)
            .replace(/<meta property="twitter:description" content=".*?"/, `<meta property="twitter:description" content="${description}"`);
        
        return updatedHTML;
    }

    generateContestHTML(contestData) {
        // Use cached HTML template
        const baseHTML = this.htmlTemplates.contest;
        if (!baseHTML) return '';

        // Create dynamic metadata for the contest page
        const title = escapeHtml(`${contestData.name || 'ConeFlip'} - ${contestData.type || 'Skin'} Contest`);
        const description = escapeHtml(`${contestData.name || 'ConeFlip'} - ${contestData.type || 'Skin'} Contest: ${contestData.description || ''}. ${contestData.prize || ''} prize for the winner!`);
        const startDate = new Date(contestData.start_date).toLocaleDateString();
        const endDate = new Date(contestData.end_date).toLocaleDateString();
        const totalParticipants = contestData.participants || 0;
        const totalSubmissions = contestData.submissions || 0;
        const totalVotes = contestData.votes || 0;

        // Update only specific meta tags
        const updatedHTML = baseHTML
            .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="description" content=".*?"/, `<meta name="description" content="${description}"`)
            .replace(/<meta name="keywords" content=".*?"/, `<meta name="keywords" content="ConeFlip, ${contestData.name}, contest, ${contestData.type}, gaming, skins, leaderboard, collectibles"`)
            .replace(/<meta property="og:title" content=".*?"/, `<meta property="og:title" content="${title}"`)
            .replace(/<meta property="og:description" content=".*?"/, `<meta property="og:description" content="${description}"`)
            .replace(/<meta property="og:url" content=".*?"/, `<meta property="og:url" content="https://coneflip.com/contest/${contestData.id}"`)
            .replace(/<meta property="twitter:title" content=".*?"/, `<meta property="twitter:title" content="${title}"`)
            .replace(/<meta property="twitter:description" content=".*?"/, `<meta property="twitter:description" content="${description}"`)
            .replace(/<meta property="twitter:url" content=".*?"/, `<meta property="twitter:url" content="https://coneflip.com/contest/${contestData.id}"`);

        return updatedHTML;
    }

    generateTrailsHTML(trailStats) {
        // Use cached HTML template
        const baseHTML = this.htmlTemplates.trailsAll;
        if (!baseHTML) return '';

        // Create dynamic metadata for the trails page
        const title = '🏃‍♂️ All ConeFlip Trails - Run Them All!';
        const totalTrails = trailStats.totalAvailableTrails || 0;
        const totalUsers = trailStats.userStats?.total_users || 0;
        const totalRuns = trailStats.totalRuns || 0;
        const totalBestTimes = trailStats.totalBestTimes || 0;

        const description = `Explore ${totalTrails} unique ConeFlip trails! Run them all and compete for the fastest times. Join ${totalUsers} players trying to beat your personal bests.`;

        // Update only specific meta tags
        const updatedHTML = baseHTML
            .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="description" content=".*?"/, `<meta name="description" content="${description}"`)
            .replace(/<meta name="keywords" content=".*?"/, `<meta name="keywords" content="ConeFlip, trails, cone trails, gaming, collectibles, rare trails, custom designs, animations, ${totalTrails} trails"`)
            .replace(/<meta property="og:title" content=".*?"/, `<meta property="og:title" content="${title}"`)
            .replace(/<meta property="og:description" content=".*?"/, `<meta property="og:description" content="${description}"`)
            .replace(/<meta property="twitter:title" content=".*?"/, `<meta property="twitter:title" content="${title}"`)
            .replace(/<meta property="twitter:description" content=".*?"/, `<meta property="twitter:description" content="${description}"`);

        return updatedHTML;
    }

    getRealIP(req) {
        // Get real IP address with fallbacks
        const ip = req.ip || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress ||
                  (req.headers['x-forwarded-for'] && req.headers['x-forwarded-for'].split(',')[0].trim()) ||
                  req.headers['x-real-ip'] ||
                  req.headers['cf-connecting-ip'] ||
                  '127.0.0.1';
        
        // For local development, create unique IPs based on user agent and session
        if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1')) {
            const userAgent = req.get('User-Agent') || '';
            const sessionId = req.get('X-Session-ID') || '';
            
            // Create a simple hash for local development
            let hash = 0;
            const str = userAgent + sessionId + (req.get('Sec-Ch-Ua') || '');
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
            }
            
            // Convert to IPv4-like address for local dev
            const a = Math.abs(hash) % 256;
            const b = Math.abs(hash >> 8) % 256;
            const c = Math.abs(hash >> 16) % 256;
            const d = Math.abs(hash >> 24) % 256;
            
            return `192.168.${c}.${d}`;
        }
        
        return ip;
    }

    setupErrorHandling() {
        this.app.use(errorHandler);
    }

    async start(port = 3000) {
        try {
            await this.initialize();
            
            this.server.listen(port, () => {
                logger.info('🚀 ConeFlip server initialization complete');
                logger.info(`Server running on port ${config.PORT}`);
                logger.info(`Environment: ${config.NODE_ENV}`);
                logger.info(`Admin access: ${config.ADMINS.length > 0 ? config.ADMINS.join(', ') : 'None configured'}`);
                logger.info('=====================================');
                console.log(`🎮 ConeFlip is running on http://localhost:${config.PORT}`);
                console.log(`🎲 Ready for cone flipping action!`);

                // Setup directories after server starts
                this.setupDirectories();
                this.initializeServices();

                // Start community directory heartbeat
                CommunityService.start();
            });

            this.setupGracefulShutdown();
            
        } catch (error) {
            logger.error('Failed to start server:', error);
            process.exit(1);
        }
    }

    async initializeServices() {
        // Additional service initialization if needed
        logger.info('🎯 All services initialized and ready');
    }

    setupGracefulShutdown() {
        const shutdown = async (signal) => {
            if (this.isShuttingDown) {
                logger.warn('Shutdown already in progress, forcing exit...');
                process.exit(1);
                return;
            }
            
            this.isShuttingDown = true;
            logger.info(`Received ${signal}, starting graceful shutdown...`);
            
            try {
                // Close WebSocket connections first
                if (this.socketHandler) {
                    await this.socketHandler.shutdown();
                    logger.info('✓ WebSocket connections closed');
                }
                
                // Close HTTP server
                await new Promise((resolve) => {
                    this.server.close(resolve);
                });
                logger.info('✓ HTTP server closed');
                
                // Shutdown services
                await TwitchService.shutdown();
                logger.info('✓ Twitch service shut down');
                
                CommunityService.stop();
                logger.info('✓ Community ping stopped');

                await DatabaseService.shutdown();
                logger.info('✓ Database connections closed');
                
                logger.info('✓ Graceful shutdown completed');
                process.exit(0);
                
            } catch (error) {
                logger.error('Error during shutdown:', error);
                process.exit(1);
            }
        };

        // Listen for shutdown signals
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception:', error);
            shutdown('uncaughtException');
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
            shutdown('unhandledRejection');
        });
    }
}

// Create and start the server
const server = new Server();
const port = process.env.PORT || 3000;

server.start(port).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});

module.exports = Server;