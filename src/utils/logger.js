const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.logLevels = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3
        };
        
        // Ensure logs directory exists
        this.logsDir = path.join(__dirname, '../../logs');
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
        
        this.maxFileSize = 10 * 1024 * 1024; // 10MB max log file size
        this.errorLogPath = path.join(this.logsDir, 'error.log');
        this.combinedLogPath = path.join(this.logsDir, 'combined.log');

        // Create log file streams
        this.errorStream = fs.createWriteStream(this.errorLogPath, { flags: 'a' });
        this.combinedStream = fs.createWriteStream(this.combinedLogPath, { flags: 'a' });

        // Reopen streams on SIGHUP (for external logrotate)
        process.on('SIGHUP', () => this.reopenStreams());
    }

    rotateIfNeeded(filePath, stream, streamName) {
        try {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.size >= this.maxFileSize) {
                    stream.end();
                    const rotatedPath = filePath + '.1';
                    if (fs.existsSync(rotatedPath)) {
                        fs.unlinkSync(rotatedPath);
                    }
                    fs.renameSync(filePath, rotatedPath);
                    const newStream = fs.createWriteStream(filePath, { flags: 'a' });
                    if (streamName === 'error') {
                        this.errorStream = newStream;
                    } else {
                        this.combinedStream = newStream;
                    }
                    return streamName === 'error' ? this.errorStream : this.combinedStream;
                }
            }
        } catch (err) {
            // Rotation failed, continue with current stream
        }
        return stream;
    }

    reopenStreams() {
        try {
            this.errorStream.end();
            this.combinedStream.end();
            this.errorStream = fs.createWriteStream(this.errorLogPath, { flags: 'a' });
            this.combinedStream = fs.createWriteStream(this.combinedLogPath, { flags: 'a' });
        } catch (err) {
            // Best effort
        }
    }

    formatMessage(level, message, meta = {}) {
        const timestamp = new Date().toISOString();
        const metaString = Object.keys(meta).length > 0 ? 
            JSON.stringify(meta) : '';
        
        return `[${timestamp}] ${level.toUpperCase()}: ${message} ${metaString}`.trim();
    }

    formatConsoleMessage(level, message, meta = {}) {
        const colors = {
            error: '\x1b[31m', // Red
            warn: '\x1b[33m',  // Yellow
            info: '\x1b[36m',  // Cyan
            debug: '\x1b[90m'  // Gray
        };
        
        const reset = '\x1b[0m';
        const color = colors[level] || '';
        
        const timestamp = new Date().toLocaleTimeString();
        const prefix = `${color}[${timestamp}] ${level.toUpperCase()}:${reset}`;
        
        if (Object.keys(meta).length > 0) {
            return `${prefix} ${message} ${JSON.stringify(meta, null, 2)}`;
        }
        
        return `${prefix} ${message}`;
    }

    shouldLog(level) {
        return this.logLevels[level] <= this.logLevels[this.logLevel];
    }

    log(level, message, meta = {}) {
        if (!this.shouldLog(level)) return;

        const formattedMessage = this.formatMessage(level, message, meta);
        const consoleMessage = this.formatConsoleMessage(level, message, meta);

        // Always log to console
        console.log(consoleMessage);

        // Rotate if needed, then write to combined file
        const combinedStream = this.rotateIfNeeded(this.combinedLogPath, this.combinedStream, 'combined');
        combinedStream.write(formattedMessage + '\n');

        // Log errors to error file as well
        if (level === 'error') {
            const errorStream = this.rotateIfNeeded(this.errorLogPath, this.errorStream, 'error');
            errorStream.write(formattedMessage + '\n');
        }
    }

    error(message, meta = {}) {
        // Handle Error objects
        if (message instanceof Error) {
            meta = meta || {};
            meta.stack = message.stack;
            message = message.message;
        }
        this.log('error', message, meta);
    }

    warn(message, meta = {}) {
        this.log('warn', message, meta || {});
    }

    info(message, meta = {}) {
        this.log('info', message, meta || {});
    }

    debug(message, meta = {}) {
        this.log('debug', message, meta || {});
    }

    // Game-specific logging methods
    gameEvent(event, data = {}) {
        this.info(`GAME_EVENT: ${event}`, data);
    }

    twitchEvent(event, data = {}) {
        this.info(`TWITCH_EVENT: ${event}`, data);
    }

    userAction(action, user, data = {}) {
        this.info(`USER_ACTION: ${action}`, { user, ...data });
    }

    performance(operation, duration, data = {}) {
        this.debug(`PERFORMANCE: ${operation} took ${duration}ms`, data);
    }

    close() {
        if (this.errorStream) {
            this.errorStream.end();
        }
        if (this.combinedStream) {
            this.combinedStream.end();
        }
    }
}

// Create singleton instance
const logger = new Logger();

// Handle process exit to close streams
process.on('exit', () => {
    logger.close();
});

module.exports = logger; 