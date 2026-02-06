const fs = require('fs');
const path = require('path');

// load .env file if it exists
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
}

// load setup.json if it exists
let setupConfig = {};
const setupPath = path.join(__dirname, '../../data/setup.json');
if (fs.existsSync(setupPath)) {
    try {
        const setupData = fs.readFileSync(setupPath, 'utf8');
        setupConfig = JSON.parse(setupData);
    } catch (error) {
        console.warn('Failed to load setup.json:', error.message);
    }
}

const config = {
    // server stuff
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: parseInt(process.env.PORT || '3000'),
    
    // base URL for the application
    BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
    
    // database
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '../../data'),
    
    // twitch config - properly structured for TwitchService
    TWITCH: {
        CHANNEL: setupConfig.TWITCH_CHANNEL || process.env.TWITCH_CHANNEL,
        BOT_NAME: setupConfig.BOT_NAME || process.env.BOT_NAME,
        BOT_ACCESS_TOKEN: setupConfig.BOT_ACCESS_TOKEN || process.env.BOT_ACCESS_TOKEN,
        STREAMER_ACCESS_TOKEN: setupConfig.STREAMER_ACCESS_TOKEN || process.env.STREAMER_ACCESS_TOKEN,
        USER_ID: setupConfig.TWITCH_USER_ID || process.env.TWITCH_USER_ID,
        CLIENT_ID: setupConfig.TWITCH_CLIENT || process.env.TWITCH_CLIENT_ID,
        CLIENT_SECRET: process.env.TWITCH_CLIENT_SECRET,
        
        // OAuth configuration for user authentication
        OAUTH_CLIENT_ID: setupConfig.TWITCH_OAUTH_CLIENT_ID || process.env.TWITCH_OAUTH_CLIENT_ID,
        OAUTH_CLIENT_SECRET: setupConfig.TWITCH_OAUTH_CLIENT_SECRET || process.env.TWITCH_OAUTH_CLIENT_SECRET,
        OAUTH_REDIRECT_URI: setupConfig.TWITCH_OAUTH_REDIRECT_URI || process.env.TWITCH_OAUTH_REDIRECT_URI,
        
        // channel point rewards
        CONE_REWARD: setupConfig.TWITCH_CONE_REWARD || process.env.TWITCH_CONE_REWARD,
        DUEL_REWARD: setupConfig.TWITCH_DUEL_REWARD || process.env.TWITCH_DUEL_REWARD,
        UNBOX_CONE: setupConfig.TWITCH_UNBOX_CONE || process.env.TWITCH_UNBOX_CONE,
        BUY_CONE: setupConfig.TWITCH_BUY_CONE || process.env.TWITCH_BUY_CONE,
        BUY_TRAIL_REWARD: setupConfig.TWITCH_BUY_TRAIL_REWARD || process.env.TWITCH_BUY_TRAIL_REWARD
    },
    
    // 7tv token
    SEVENTV_TOKEN: setupConfig.SEVENTV_TOKEN || process.env.SEVENTV_TOKEN,
    
    // admin configuration
    DEBUG_PASSWORD: process.env.DEBUG_PASSWORD || 'changeme123',
    ADMINS: (setupConfig.ADMINS || process.env.ADMINS || '').split(',').map(admin => admin.trim().toLowerCase()).filter(Boolean),
    MODERATORS: (setupConfig.MODERATORS || process.env.MODERATORS || '').split(',').map(mod => mod.trim().toLowerCase()).filter(Boolean),
    
    // session configuration
    SESSION_SECRET: process.env.SESSION_SECRET || 'coneflip_session_secret_change_in_production',

    // follow reward configuration
    FOLLOW_REWARD: {
        ENABLED: setupConfig.FOLLOW_REWARD_ENABLED === true || setupConfig.FOLLOW_REWARD_ENABLED === 'true',
        CHAT_MESSAGE_ENABLED: setupConfig.FOLLOW_REWARD_CHAT_ENABLED !== false && setupConfig.FOLLOW_REWARD_CHAT_ENABLED !== 'false',
        CHAT_MESSAGE: setupConfig.FOLLOW_REWARD_MESSAGE || '@{user} thanks for following! Enjoy a free coneflip!'
    },

    // Level up chat messages (default: disabled)
    LEVEL_UP_CHAT_ENABLED: setupConfig.LEVEL_UP_CHAT_ENABLED === true || setupConfig.LEVEL_UP_CHAT_ENABLED === 'true',

    // rate limits
    RATE_LIMIT_WINDOW: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '10'),
    
    // file uploads
    MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || '10485760'),
    
    // logging
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    LOG_FILE: process.env.LOG_FILE || path.join(__dirname, '../../logs/app.log')
};

// check for missing stuff
const validateEnvironment = async () => {
    const required = [];
    const optional = [];
    
    // twitch is optional but warn if missing
    if (!config.TWITCH.CHANNEL) {
        optional.push('TWITCH_CHANNEL - twitch integration disabled');
    }
    
    if (!config.TWITCH.BOT_NAME) {
        optional.push('BOT_NAME - twitch bot disabled');
    }
    
    if (!config.TWITCH.BOT_ACCESS_TOKEN) {
        optional.push('BOT_ACCESS_TOKEN - twitch bot disabled');
    }
    
    // Fatal error in production if using default passwords
    if (config.NODE_ENV === 'production') {
        if (config.DEBUG_PASSWORD === 'changeme123') {
            throw new Error('FATAL: Cannot start in production with default DEBUG_PASSWORD. Set a secure DEBUG_PASSWORD environment variable.');
        }
        if (config.SESSION_SECRET === 'coneflip_session_secret_change_in_production') {
            throw new Error('FATAL: Cannot start in production with default SESSION_SECRET. Set a secure SESSION_SECRET environment variable.');
        }
    } else if (config.DEBUG_PASSWORD === 'changeme123') {
        console.warn('WARNING: Using default debug password. Change DEBUG_PASSWORD before deploying.');
    }
    
    // warn about default base URL in production
    if (config.NODE_ENV === 'production' && config.BASE_URL === 'http://localhost:3000') {
        console.warn('⚠️  WARNING: Using default BASE_URL in production! Set BASE_URL environment variable.');
    }
    
    if (required.length > 0) {
        throw new Error(`Missing required environment variables: ${required.join(', ')}`);
    }
    
    if (optional.length > 0) {
        console.log('ℹ️  Optional configuration missing:');
        optional.forEach(msg => console.log(`   - ${msg}`));
    }
    
    // make sure directories exist
    const dirs = [
        path.dirname(config.LOG_FILE),
        config.DB_PATH,
        path.join(__dirname, '../../uploads')
    ];
    
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
};

// reload config from setup.json
const reloadConfig = () => {
    if (fs.existsSync(setupPath)) {
        try {
            const setupData = fs.readFileSync(setupPath, 'utf8');
            const newSetupConfig = JSON.parse(setupData);
            
            // update config with new values
            config.TWITCH.CHANNEL = newSetupConfig.TWITCH_CHANNEL || process.env.TWITCH_CHANNEL;
            config.TWITCH.BOT_NAME = newSetupConfig.BOT_NAME || process.env.BOT_NAME;
            config.TWITCH.BOT_ACCESS_TOKEN = newSetupConfig.BOT_ACCESS_TOKEN || process.env.BOT_ACCESS_TOKEN;
            config.TWITCH.STREAMER_ACCESS_TOKEN = newSetupConfig.STREAMER_ACCESS_TOKEN || process.env.STREAMER_ACCESS_TOKEN;
            config.TWITCH.USER_ID = newSetupConfig.TWITCH_USER_ID || process.env.TWITCH_USER_ID;
            config.TWITCH.CLIENT_ID = newSetupConfig.TWITCH_CLIENT || process.env.TWITCH_CLIENT_ID;
            config.TWITCH.CONE_REWARD = newSetupConfig.TWITCH_CONE_REWARD || process.env.TWITCH_CONE_REWARD;
            config.TWITCH.DUEL_REWARD = newSetupConfig.TWITCH_DUEL_REWARD || process.env.TWITCH_DUEL_REWARD;
            config.TWITCH.UNBOX_CONE = newSetupConfig.TWITCH_UNBOX_CONE || process.env.TWITCH_UNBOX_CONE;
            config.TWITCH.BUY_CONE = newSetupConfig.TWITCH_BUY_CONE || process.env.TWITCH_BUY_CONE;
            config.TWITCH.BUY_TRAIL_REWARD = newSetupConfig.TWITCH_BUY_TRAIL_REWARD || process.env.TWITCH_BUY_TRAIL_REWARD;
            config.SEVENTV_TOKEN = newSetupConfig.SEVENTV_TOKEN || process.env.SEVENTV_TOKEN;
            config.ADMINS = (newSetupConfig.ADMINS || process.env.ADMINS || '').split(',').map(admin => admin.trim().toLowerCase()).filter(Boolean);
            config.MODERATORS = (newSetupConfig.MODERATORS || process.env.MODERATORS || '').split(',').map(mod => mod.trim().toLowerCase()).filter(Boolean);

            // Follow reward config
            config.FOLLOW_REWARD.ENABLED = newSetupConfig.FOLLOW_REWARD_ENABLED === true || newSetupConfig.FOLLOW_REWARD_ENABLED === 'true';
            config.FOLLOW_REWARD.CHAT_MESSAGE_ENABLED = newSetupConfig.FOLLOW_REWARD_CHAT_ENABLED !== false && newSetupConfig.FOLLOW_REWARD_CHAT_ENABLED !== 'false';
            config.FOLLOW_REWARD.CHAT_MESSAGE = newSetupConfig.FOLLOW_REWARD_MESSAGE || '@{user} thanks for following! Enjoy a free coneflip!';

            // Level up chat config
            config.LEVEL_UP_CHAT_ENABLED = newSetupConfig.LEVEL_UP_CHAT_ENABLED === true || newSetupConfig.LEVEL_UP_CHAT_ENABLED === 'true';

            console.log('Configuration reloaded from setup.json');
            return true;
        } catch (error) {
            console.warn('Failed to reload setup.json:', error.message);
            return false;
        }
    }
    return false;
};

module.exports = {
    config,
    validateEnvironment,
    reloadConfig
}; 