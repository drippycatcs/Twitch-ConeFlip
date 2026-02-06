const axios = require('axios');
const { config } = require('../config/environment');
const logger = require('../utils/logger');

class AuthService {
    constructor() {
        this.twitchApiBase = 'https://api.twitch.tv/helix';
        this.twitchOAuthBase = 'https://id.twitch.tv/oauth2';
    }

    /**
     * Generate Twitch OAuth URL for user authentication
     * @returns {string} OAuth URL
     */
    generateAuthUrl() {
        const params = new URLSearchParams({
            client_id: config.TWITCH.OAUTH_CLIENT_ID,
            redirect_uri: config.TWITCH.OAUTH_REDIRECT_URI,
            response_type: 'code',
            scope: 'user:read:email openid',
        });

        return `${this.twitchOAuthBase}/authorize?${params.toString()}`;
    }

    /**
     * Exchange OAuth code for access token
     * @param {string} code - OAuth authorization code
     * @returns {Promise<Object>} Token response
     */
    async exchangeCodeForToken(code) {
        try {
            const response = await axios.post(`${this.twitchOAuthBase}/token`, {
                client_id: config.TWITCH.OAUTH_CLIENT_ID,
                client_secret: config.TWITCH.OAUTH_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: config.TWITCH.OAUTH_REDIRECT_URI
            });

            return response.data;
        } catch (error) {
            logger.error('Failed to exchange OAuth code for token:', error.response?.data || error.message);
            throw new Error('Failed to authenticate with Twitch');
        }
    }

    /**
     * Get user information from Twitch API
     * @param {string} accessToken - User's access token
     * @returns {Promise<Object>} User information
     */
    async getUserInfo(accessToken) {
        try {
            const response = await axios.get(`${this.twitchApiBase}/users`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Client-ID': config.TWITCH.OAUTH_CLIENT_ID
                }
            });

            if (response.data.data && response.data.data.length > 0) {
                const user = response.data.data[0];
                return {
                    id: user.id,
                    login: user.login.toLowerCase(),
                    display_name: user.display_name,
                    profile_image_url: user.profile_image_url,
                    email: user.email
                };
            }

            throw new Error('No user data returned from Twitch API');
        } catch (error) {
            logger.error('Failed to get user info from Twitch:', error.response?.data || error.message);
            throw new Error('Failed to get user information');
        }
    }

    /**
     * Validate and refresh access token if needed
     * @param {string} accessToken - User's access token
     * @returns {Promise<Object>} Validation response
     */
    async validateToken(accessToken) {
        try {
            const response = await axios.get(`${this.twitchOAuthBase}/validate`, {
                headers: {
                    'Authorization': `OAuth ${accessToken}`
                }
            });

            return response.data;
        } catch (error) {
            logger.debug('Token validation failed:', error.response?.data || error.message);
            return null;
        }
    }

    /**
     * Check if user is admin (streamer or in ADMINS list)
     * @param {Object} user - User object with login property
     * @returns {boolean} True if user is admin
     */
    isAdmin(user) {
        if (!user || !user.login) return false;

        const username = user.login.toLowerCase();

        // Check if user is the streamer (channel owner)
        const streamerChannel = config.TWITCH.CHANNEL?.replace('#', '').toLowerCase();
        if (streamerChannel && username === streamerChannel) {
            return true;
        }

        // Check if user is in ADMINS list
        return config.ADMINS.includes(username);
    }

    /**
     * Check if user is moderator (admin, streamer, or in MODERATORS list)
     * @param {Object} user - User object with login property
     * @returns {boolean} True if user is moderator
     */
    isModerator(user) {
        if (!user || !user.login) return false;

        // Admins are automatically moderators
        if (this.isAdmin(user)) return true;

        const username = user.login.toLowerCase();

        // Check if user is in MODERATORS list
        return config.MODERATORS.includes(username);
    }

    /**
     * Create user session data
     * @param {Object} user - User object from Twitch
     * @param {string} accessToken - User's access token
     * @returns {Object} Session user data
     */
    createSessionUser(user, accessToken) {
        return {
            id: user.id,
            login: user.login,
            display_name: user.display_name,
            profile_image_url: user.profile_image_url,
            email: user.email,
            is_admin: this.isAdmin(user),
            is_moderator: this.isModerator(user),
            access_token: accessToken,
            authenticated_at: new Date().toISOString()
        };
    }

    /**
     * Revoke access token
     * @param {string} accessToken - Token to revoke
     */
    async revokeToken(accessToken) {
        try {
            await axios.post(`${this.twitchOAuthBase}/revoke`, {
                client_id: config.TWITCH.OAUTH_CLIENT_ID,
                token: accessToken
            });
            logger.info('Access token revoked successfully');
        } catch (error) {
            logger.error('Failed to revoke access token:', error.response?.data || error.message);
        }
    }
}

module.exports = new AuthService(); 