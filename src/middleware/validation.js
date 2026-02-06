const { config } = require('../config/environment');

// validation error class
class ValidationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ValidationError';
        this.field = field;
        this.statusCode = 400;
    }
}

const validationError = (message, field) => {
    return new ValidationError(message, field);
};

// clean up strings
const sanitizeString = (str, maxLength = 100) => {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, maxLength);
};

// check username
const validateUsername = (username) => {
    if (!username || typeof username !== 'string') {
        throw validationError('Username is required', 'username');
    }

    const sanitized = sanitizeString(username, 25);
    
    if (sanitized.length < 2) {
        throw validationError('Username must be at least 2 characters', 'username');
    }

    if (sanitized.length > 25) {
        throw validationError('Username must be 25 characters or less', 'username');
    }

    // only alphanumeric and underscore
    if (!/^[a-zA-Z0-9_]+$/.test(sanitized)) {
        throw validationError('Username can only contain letters, numbers, and underscores', 'username');
    }

    return sanitized.toLowerCase();
};

// check skin name
const validateSkinName = (skinName) => {
    if (!skinName || typeof skinName !== 'string') {
        throw validationError('Skin name is required', 'skin');
    }

    const sanitized = sanitizeString(skinName, 50);
    
    if (sanitized.length < 1) {
        throw validationError('Skin name cannot be empty', 'skin');
    }

    return sanitized;
};

const validatePassword = (password) => {
    if (!password || typeof password !== 'string') {
        throw validationError('Password is required', 'password');
    }
    
    return password;
};

// check if number is valid
const validateInteger = (value, fieldName, min = null, max = null) => {
    const parsed = parseInt(value);
    
    if (isNaN(parsed)) {
        throw validationError(`${fieldName} must be a valid number`, fieldName);
    }
    
    if (min !== null && parsed < min) {
        throw validationError(`${fieldName} must be at least ${min}`, fieldName);
    }
    
    if (max !== null && parsed > max) {
        throw validationError(`${fieldName} must be at most ${max}`, fieldName);
    }
    
    return parsed;
};

const validateBoolean = (value, fieldName) => {
    if (typeof value === 'boolean') {
        return value;
    }
    
    if (value === 'true' || value === '1') {
        return true;
    }
    
    if (value === 'false' || value === '0') {
        return false;
    }
    
    throw validationError(`${fieldName} must be true or false`, fieldName);
};

// pagination middleware
const validatePagination = (req, res, next) => {
    try {
        const page = req.query.page ? validateInteger(req.query.page, 'page', 1) : 1;
        const limit = req.query.limit ? validateInteger(req.query.limit, 'limit', 1, 100) : 10;
        
        req.validatedData = {
            page,
            limit,
            offset: (page - 1) * limit
        };
        next();
    } catch (error) {
        next(error);
    }
};

// game validations
const validateAddCone = (req, res, next) => {
    try {
        const { name } = req.query;
        
        if (!name) {
            throw validationError('Player name is required', 'name');
        }
        
        req.validatedData = {
            name: validateUsername(name)
        };
        next();
    } catch (error) {
        next(error);
    }
};

const validateDuel = (req, res, next) => {
    try {
        const { name, target } = req.query;
        
        if (!name) {
            throw validationError('Player name is required', 'name');
        }
        
        if (!target) {
            throw validationError('Target player is required', 'target');
        }
        
        const validatedName = validateUsername(name);
        const validatedTarget = validateUsername(target);
        
        if (validatedName === validatedTarget) {
            throw validationError('Cannot duel yourself', 'target');
        }
        
        req.validatedData = {
            name: validatedName,
            target: validatedTarget
        };
        next();
    } catch (error) {
        next(error);
    }
};

const validateSetSkin = (req, res, next) => {
    try {
        const { name, skin } = req.query;
        
        if (!name) {
            throw validationError('Username is required', 'name');
        }
        
        if (!skin) {
            throw validationError('Skin name is required', 'skin');
        }
        
        req.validatedData = {
            name: validateUsername(name),
            skin: validateSkinName(skin)
        };
        next();
    } catch (error) {
        next(error);
    }
};

const validateLeaderboardQuery = (req, res, next) => {
    try {
        const { search, limit } = req.query;
        
        const validatedData = {};
        
        if (search) {
            validatedData.search = sanitizeString(search, 25);
        }
        
        if (limit) {
            validatedData.limit = validateInteger(limit, 'limit', 1, 100);
        } else {
            validatedData.limit = 10;
        }
        
        req.validatedData = validatedData;
        next();
    } catch (error) {
        next(error);
    }
};

// debug auth
const validateDebugAuth = (req, res, next) => {
    try {
        const { password } = req.body;
        
        if (!password) {
            throw validationError('Password is required for debug access', 'password');
        }
        
        req.validatedData = {
            password: validatePassword(password)
        };
        next();
    } catch (error) {
        next(error);
    }
};

const validateDebugAction = (req, res, next) => {
    try {
        const { action, data } = req.body;
        
        if (!action || typeof action !== 'string') {
            throw validationError('Action is required', 'action');
        }
        
        req.validatedData = {
            action: sanitizeString(action, 50),
            data: data || {}
        };
        next();
    } catch (error) {
        next(error);
    }
};

// rate limiting with admin bypass
const createRateLimiter = (windowMs = 15 * 60 * 1000, maxRequests = 300) => {
    const clients = new Map();

    // Periodic cleanup of expired entries every 15 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [clientId, client] of clients) {
            if (now > client.resetTime) {
                clients.delete(clientId);
            }
        }
    }, 15 * 60 * 1000).unref();

    return (req, res, next) => {
        // admin bypass via session only (no password bypass)
        const isSessionAdmin = req.session && req.session.user && req.session.user.is_admin === true;

        if (isSessionAdmin) {
            return next();
        }
        
        const clientId = req.ip;
        const now = Date.now();
        
        if (!clients.has(clientId)) {
            clients.set(clientId, { requests: 1, resetTime: now + windowMs });
            return next();
        }
        
        const client = clients.get(clientId);
        
        if (now > client.resetTime) {
            client.requests = 1;
            client.resetTime = now + windowMs;
            return next();
        }
        
        if (client.requests >= maxRequests) {
            return res.status(429).json({
                status: 'error',
                message: 'Too many requests, please try again later'
            });
        }
        
        client.requests++;
        next();
    };
};

module.exports = {
    validateUsername,
    validateSkinName,
    validatePassword,
    validatePagination,
    sanitizeString,
    validateInteger,
    validateBoolean,
    validateAddCone,
    validateDuel,
    validateSetSkin,
    validateLeaderboardQuery,
    validateDebugAuth,
    validateDebugAction,
    createRateLimiter
}; 