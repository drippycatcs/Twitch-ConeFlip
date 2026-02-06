const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class ConfigService {
    constructor() {
        this.config = {};
        this.configPath = path.join(process.cwd(), 'data', 'setup.json');
    }

    async initialize() {
        try {
            await this.loadConfig();
            logger.info('Configuration loaded from setup.json');
        } catch (error) {
            logger.warn('No configuration file found, using defaults');
            this.config = {};
        }
    }

    async loadConfig() {
        try {
            const data = await fs.readFile(this.configPath, 'utf8');
            this.config = JSON.parse(data);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Failed to load config:', error);
            }
            throw error;
        }
    }

    async saveConfig(newConfig) {
        try {
            this.config = { ...this.config, ...newConfig };
            await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
            logger.info('Configuration saved to setup.json');
            return true;
        } catch (error) {
            logger.error('Failed to save config:', error);
            throw error;
        }
    }

    get(key, defaultValue = null) {
        return this.config[key] || defaultValue;
    }

    getAll() {
        return { ...this.config };
    }

    set(key, value) {
        this.config[key] = value;
    }
}

module.exports = new ConfigService(); 