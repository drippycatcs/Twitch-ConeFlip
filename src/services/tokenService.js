const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class TokenService {
    constructor() {
        this.activeTokens = new Map(); // token -> { socketId, createdAt, lastActivity }
        this.socketTokens = new Map(); // socketId -> token
        this.currentToken = null;
        this.tokenExpiryTime = 24 * 60 * 60 * 1000; // 24 hours (but we won't auto-expire unless manually revoked)
        this.tokenFilePath = path.join(process.cwd(), 'data', 'auth_token.json');
    }

    generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    saveTokenToDisk() {
        try {
            // Ensure data directory exists
            const dataDir = path.dirname(this.tokenFilePath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            const tokenData = {
                token: this.currentToken,
                createdAt: new Date().toISOString(),
                version: 1
            };

            fs.writeFileSync(this.tokenFilePath, JSON.stringify(tokenData, null, 2));
            logger.info('Token saved to disk');
        } catch (error) {
            logger.error('Failed to save token to disk:', error);
        }
    }

    loadTokenFromDisk() {
        try {
            if (!fs.existsSync(this.tokenFilePath)) {
                logger.info('No existing token file found, generating new token');
                return null;
            }

            const data = fs.readFileSync(this.tokenFilePath, 'utf8');
            const tokenData = JSON.parse(data);

            if (tokenData.token && typeof tokenData.token === 'string') {
                logger.info('Loaded existing token from disk');
                return tokenData.token;
            }
        } catch (error) {
            logger.error('Failed to load token from disk:', error);
        }
        return null;
    }

    validateToken(token) {
        const isValid = this.activeTokens.has(token);
        logger.debug(`Token validation: ${token.substring(0, 8)}... -> ${isValid}`);
        return isValid;
    }

    isTokenInUse(token) {
        const tokenData = this.activeTokens.get(token);
        return tokenData && tokenData.socketId;
    }

    associateTokenWithSocket(token, socketId, userAgent = null, clientIp = null) {
        logger.info(`🔍 Token validation attempt:`, {
            token: token.substring(0, 8) + '...',
            socketId,
            clientIp: clientIp ? clientIp.substring(0, 10) + '...' : 'unknown',
            currentToken: this.currentToken ? this.currentToken.substring(0, 8) + '...' : 'none',
            activeTokensCount: this.activeTokens.size,
            hasToken: this.activeTokens.has(token)
        });
        
        if (!this.validateToken(token)) {
            logger.warn(`❌ Token validation failed for ${token.substring(0, 8)}...`);
            return { success: false, error: 'Invalid token' };
        }

        const existingTokenData = this.activeTokens.get(token);
        logger.info(`📋 Existing token data:`, existingTokenData);
        
        // Parse browser information from user agent
        const browserInfo = this.parseBrowserInfo(userAgent);

        // If this is the first time using the token, bind it to the IP
        if (!existingTokenData || !existingTokenData.ipAddress) {
            logger.info(`🆕 First use of token, binding to IP: ${clientIp ? clientIp.substring(0, 10) + '...' : 'unknown'}`);
            
            this.activeTokens.set(token, {
                socketId: socketId,
                ipAddress: clientIp,
                createdAt: existingTokenData ? existingTokenData.createdAt : new Date(),
                lastActivity: new Date(),
                browserInfo: browserInfo,
                userAgent: userAgent
            });

            this.socketTokens.set(socketId, token);
            
            logger.info(`✅ Token associated with socket: ${socketId} (${browserInfo.name}) bound to IP: ${clientIp ? clientIp.substring(0, 10) + '...' : 'unknown'}`);
            return { success: true };
        }

        // If token is already bound to a different IP, block access
        if (existingTokenData.ipAddress !== clientIp) {
            logger.warn(`🚫 Token bound to IP ${existingTokenData.ipAddress.substring(0, 10)}..., blocking IP ${clientIp ? clientIp.substring(0, 10) + '...' : 'unknown'}`);
            return { success: false, error: 'Token is locked to a different IP address' };
        }

        // Same IP - allow access and replace any existing socket
        if (existingTokenData.socketId && existingTokenData.socketId !== socketId) {
            logger.info(`🔄 Replacing previous session ${existingTokenData.socketId} with ${socketId} (same IP)`);
            this.socketTokens.delete(existingTokenData.socketId);
        }

        // Update token data with new socket
        this.activeTokens.set(token, {
            socketId: socketId,
            ipAddress: clientIp,
            createdAt: existingTokenData.createdAt,
            lastActivity: new Date(),
            browserInfo: browserInfo,
            userAgent: userAgent
        });

        this.socketTokens.set(socketId, token);
        
        logger.info(`✅ Token associated with socket: ${socketId} (${browserInfo.name}) from authorized IP: ${clientIp ? clientIp.substring(0, 10) + '...' : 'unknown'}`);
        return { success: true };
    }

    parseBrowserInfo(userAgent) {
        if (!userAgent) {
            return { name: 'Unknown', version: 'Unknown', type: 'Unknown' };
        }

        const ua = userAgent.toLowerCase();
        let browser = { name: 'Unknown', version: 'Unknown', type: 'Browser' };

        // Check for OBS Studio
        if (ua.includes('obs')) {
            browser.name = 'OBS Studio';
            browser.type = 'Streaming Software';
            const obsMatch = userAgent.match(/obs[\/\s](\d+[\.\d]*)/i);
            if (obsMatch) browser.version = obsMatch[1];
        }
        // Check for Chrome/Chromium based browsers
        else if (ua.includes('chrome') && !ua.includes('edg')) {
            if (ua.includes('opr')) {
                browser.name = 'Opera';
                const operaMatch = userAgent.match(/opr[\/\s](\d+[\.\d]*)/i);
                if (operaMatch) browser.version = operaMatch[1];
            } else if (ua.includes('brave')) {
                browser.name = 'Brave';
                const braveMatch = userAgent.match(/brave[\/\s](\d+[\.\d]*)/i);
                if (braveMatch) browser.version = braveMatch[1];
            } else {
                browser.name = 'Chrome';
                const chromeMatch = userAgent.match(/chrome[\/\s](\d+[\.\d]*)/i);
                if (chromeMatch) browser.version = chromeMatch[1];
            }
        }
        // Check for Edge
        else if (ua.includes('edg')) {
            browser.name = 'Microsoft Edge';
            const edgeMatch = userAgent.match(/edg[\/\s](\d+[\.\d]*)/i);
            if (edgeMatch) browser.version = edgeMatch[1];
        }
        // Check for Firefox
        else if (ua.includes('firefox')) {
            browser.name = 'Firefox';
            const firefoxMatch = userAgent.match(/firefox[\/\s](\d+[\.\d]*)/i);
            if (firefoxMatch) browser.version = firefoxMatch[1];
        }
        // Check for Safari
        else if (ua.includes('safari') && !ua.includes('chrome')) {
            browser.name = 'Safari';
            const safariMatch = userAgent.match(/version[\/\s](\d+[\.\d]*)/i);
            if (safariMatch) browser.version = safariMatch[1];
        }
        // Check for Internet Explorer
        else if (ua.includes('trident') || ua.includes('msie')) {
            browser.name = 'Internet Explorer';
            const ieMatch = userAgent.match(/(?:msie\s|rv:)(\d+[\.\d]*)/i);
            if (ieMatch) browser.version = ieMatch[1];
        }
        // Check for other streaming software
        else if (ua.includes('streamlabs')) {
            browser.name = 'Streamlabs';
            browser.type = 'Streaming Software';
        }
        else if (ua.includes('xsplit')) {
            browser.name = 'XSplit';
            browser.type = 'Streaming Software';
        }

        return browser;
    }

    disconnectSocket(socketId) {
        const token = this.socketTokens.get(socketId);
        if (token) {
            const tokenData = this.activeTokens.get(token);
            if (tokenData) {
                tokenData.socketId = null;
                this.activeTokens.set(token, tokenData);
            }
            this.socketTokens.delete(socketId);
            logger.info(`Socket disconnected: ${socketId}`);
        }
    }

    // Remove socket from mapping without affecting token status (for when multiple sockets share a token)
    removeSocketMapping(socketId) {
        const token = this.socketTokens.get(socketId);
        if (token) {
            this.socketTokens.delete(socketId);
            logger.info(`Socket mapping removed: ${socketId} (token status preserved)`);
        }
    }

    revokeToken(token) {
        const tokenData = this.activeTokens.get(token);
        if (tokenData && tokenData.socketId) {
            this.socketTokens.delete(tokenData.socketId);
            return tokenData.socketId;
        }
        this.activeTokens.delete(token);
        return null;
    }

    regenerateCurrentToken() {
        // Revoke old token
        this.revokeToken(this.currentToken);
        
        // Generate new token
        this.currentToken = this.generateToken();
        this.activeTokens.set(this.currentToken, {
            socketId: null,
            createdAt: new Date(),
            lastActivity: new Date(),
            browserInfo: null,
            userAgent: null
        });
        
        // Save new token to disk
        this.saveTokenToDisk();
        
        logger.info('Current token regenerated and saved to disk');
        return this.currentToken;
    }

    getCurrentToken() {
        return this.currentToken;
    }

    getTokenInfo(token) {
        return this.activeTokens.get(token);
    }

    updateTokenActivity(token) {
        const tokenData = this.activeTokens.get(token);
        if (tokenData) {
            tokenData.lastActivity = new Date();
            this.activeTokens.set(token, tokenData);
        }
    }

    setSocketHandler(socketHandler) {
        this.socketHandler = socketHandler;
    }

    // Initialize the service
    async initialize() {
        // Try to load existing token from disk
        const savedToken = this.loadTokenFromDisk();
        
        if (savedToken) {
            this.currentToken = savedToken;
            logger.info(`Using existing token from disk: ${savedToken.substring(0, 8)}...`);
        } else {
            // Generate new token if none exists
            this.currentToken = this.generateToken();
            this.saveTokenToDisk();
            logger.info(`Generated new token and saved to disk: ${this.currentToken.substring(0, 8)}...`);
        }

        // Set up the token in active tokens map
        this.activeTokens.set(this.currentToken, {
            socketId: null,
            createdAt: new Date(),
            lastActivity: new Date(),
            browserInfo: null,
            userAgent: null
        });

        logger.info(`TokenService initialized with persistent token. Active tokens: ${this.activeTokens.size}`);
        logger.info(`Current token: ${this.currentToken.substring(0, 8)}...${this.currentToken.substring(-8)}`);
    }
}

// Export singleton instance
module.exports = new TokenService(); 