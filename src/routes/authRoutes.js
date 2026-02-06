const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { config } = require('../config/environment');
const AuthService = require('../services/authService');
const logger = require('../utils/logger');

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (!req.session.user || !req.session.user.id) {
        return res.status(401).json({
            status: 'error',
            message: 'Authentication required'
        });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session.user || !req.session.user.is_admin) {
        return res.status(403).json({
            status: 'error',
            message: 'Admin access required'
        });
    }
    next();
};

const requireModerator = (req, res, next) => {
    if (!req.session.user || !req.session.user.is_moderator) {
        return res.status(403).json({
            status: 'error',
            message: 'Moderator access required'
        });
    }
    next();
};

// Start OAuth flow
router.get('/login', (req, res) => {
    try {
        if (!config.TWITCH.OAUTH_CLIENT_ID || !config.TWITCH.OAUTH_CLIENT_SECRET) {
            return res.status(500).json({
                status: 'error',
                message: 'Twitch OAuth not configured'
            });
        }

        const authUrl = AuthService.generateAuthUrl();
        res.redirect(authUrl);
    } catch (error) {
        logger.error('Error starting OAuth flow:', error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to start authentication'
        });
    }
});

// OAuth callback
router.get('/callback', asyncHandler(async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        logger.warn('OAuth callback error:', error);
        return res.redirect('/?auth_error=access_denied');
    }

    if (!code) {
        logger.warn('OAuth callback missing code parameter');
        return res.redirect('/?auth_error=missing_code');
    }

    try {
        // Exchange code for access token
        const tokenData = await AuthService.exchangeCodeForToken(code);
        
        // Get user information
        const userInfo = await AuthService.getUserInfo(tokenData.access_token);
        
        // Create session
        req.session.user = AuthService.createSessionUser(userInfo, tokenData.access_token);
        
        logger.info(`User authenticated: ${userInfo.login}`, {
            userId: userInfo.id,
            isAdmin: req.session.user.is_admin,
            isModerator: req.session.user.is_moderator
        });

        // Always redirect to home page after login, not admin
        res.redirect('/?auth_success=1');

    } catch (error) {
        logger.error('OAuth callback error:', error);
        res.redirect('/?auth_error=callback_failed');
    }
}));

// Logout
router.post('/logout', asyncHandler(async (req, res) => {
    if (req.session.user && req.session.user.access_token) {
        // Revoke the access token
        await AuthService.revokeToken(req.session.user.access_token);
    }

    // Destroy session
    req.session.destroy((err) => {
        if (err) {
            logger.error('Error destroying session:', err);
            return res.status(500).json({
                status: 'error',
                message: 'Failed to logout'
            });
        }

        res.json({
            status: 'success',
            message: 'Logged out successfully'
        });
    });
}));

// Get current user info
router.get('/user', (req, res) => {
    logger.info('Auth check request', {
        hasSession: !!req.session,
        hasUser: !!req.session?.user,
        userId: req.session?.user?.id,
        isAdmin: req.session?.user?.is_admin,
        sessionId: req.sessionID,
        cookies: req.headers.cookie ? 'present' : 'missing'
    });

    if (req.session.user) {
        // Return user info without access token
        const { access_token, ...safeUser } = req.session.user;
        res.json({
            status: 'success',
            data: safeUser
        });
    } else {
        res.json({
            status: 'success',
            data: null
        });
    }
});

// Check if user has admin access
router.get('/admin-check', requireAuth, (req, res) => {
    res.json({
        status: 'success',
        data: {
            is_admin: req.session.user.is_admin
        }
    });
});

// Check if user has moderator access
router.get('/mod-check', requireAuth, (req, res) => {
    res.json({
        status: 'success',
        data: {
            is_moderator: req.session.user.is_moderator
        }
    });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.requireModerator = requireModerator; 