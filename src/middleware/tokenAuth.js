const TokenService = require('../services/tokenService');
const { AuthenticationError } = require('./errorHandler');
const logger = require('../utils/logger');

// Middleware to validate token access to the main game
const requireToken = (req, res, next) => {
    const token = req.query.token;
    
    if (!token) {
        return res.status(401).send(`
            <html>
                <head><title>ConeFlip - Token Required</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>ConeFlip Access</h1>
                    <p>A valid token is required to access the game.</p>
                    <p>Please contact the streamer for access.</p>
                </body>
            </html>
        `);
    }

    // Validate token
    if (!TokenService.validateToken(token)) {
        return res.status(401).send(`
            <html>
                <head><title>ConeFlip - Invalid Token</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>Invalid Token</h1>
                    <p>The provided token is not valid.</p>
                    <p>Please contact the streamer for a new token.</p>
                </body>
            </html>
        `);
    }

    // Check if token is already in use
    if (TokenService.isTokenInUse(token)) {
        return res.status(409).send(`
            <html>
                <head><title>ConeFlip - Session In Use</title></head>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>⚠️ Session Already Active</h1>
                    <p>This token is already being used by another session.</p>
                    <p>Only one person can use a token at a time.</p>
                    <p>Please wait for the other session to end, or contact the streamer.</p>
                    <p>Please contact the streamer.</p>
                </body>
            </html>
        `);
    }

    // Token is valid and not in use - proceed
    req.validToken = token;
    TokenService.updateTokenActivity(token);
    logger.info(`Valid token access: ${token.substring(0, 8)}...`);
    next();
};

// Middleware to check Twitch OAuth for admin routes (replaces password auth)
const requireDebugAuth = (req, res, next) => {
    // Check if user is authenticated via session
    if (!req.session.user || !req.session.user.id) {
        throw new AuthenticationError('Twitch authentication required');
    }

    // Check if user is admin
    if (!req.session.user.is_admin) {
        throw new AuthenticationError('Admin access required');
    }

    logger.info(`Admin access granted to: ${req.session.user.login}`);
    next();
};

// Middleware to check Twitch OAuth for moderator routes (allows admin OR moderator)
const requireModeratorAuth = (req, res, next) => {
    // Check if user is authenticated via session
    if (!req.session.user || !req.session.user.id) {
        throw new AuthenticationError('Twitch authentication required');
    }

    // Check moderator status LIVE (not just from session)
    // This allows moderators added after login to access without re-logging
    const AuthService = require('../services/authService');
    const isModerator = AuthService.isModerator(req.session.user);

    // Update session if moderator status changed
    if (isModerator !== req.session.user.is_moderator) {
        req.session.user.is_moderator = isModerator;
        logger.info(`Updated moderator status for ${req.session.user.login}: ${isModerator}`);
    }

    // Check if user is admin or moderator
    if (!req.session.user.is_admin && !isModerator) {
        throw new AuthenticationError('Moderator access required');
    }

    logger.info(`Moderator access granted to: ${req.session.user.login}`);
    next();
};

module.exports = {
    requireToken,
    requireDebugAuth,
    requireModeratorAuth
}; 