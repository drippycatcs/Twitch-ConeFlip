const logger = require('../utils/logger');

// Custom error classes
class ValidationError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
        this.field = field;
    }
}

class NotFoundError extends Error {
    constructor(message = 'Resource not found') {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

class AuthenticationError extends Error {
    constructor(message = 'Authentication failed') {
        super(message);
        this.name = 'AuthenticationError';
        this.statusCode = 401;
    }
}

class RateLimitError extends Error {
    constructor(message = 'Rate limit exceeded') {
        super(message);
        this.name = 'RateLimitError';
        this.statusCode = 429;
    }
}

class DatabaseError extends Error {
    constructor(message = 'Database operation failed') {
        super(message);
        this.name = 'DatabaseError';
        this.statusCode = 500;
    }
}

class TwitchError extends Error {
    constructor(message = 'Twitch API error') {
        super(message);
        this.name = 'TwitchError';
        this.statusCode = 503;
    }
}

// Error response formatters
function sendErrorDev(error, req, res) {
    const errorResponse = {
        error: {
            message: error.message,
            name: error.name,
            statusCode: error.statusCode || 500,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            path: req.originalUrl,
            method: req.method
        }
    };

    if (error.field) {
        errorResponse.error.field = error.field;
    }

    res.status(error.statusCode || 500).json(errorResponse);
}

function sendErrorProd(error, req, res) {
    const statusCode = error.statusCode || 500;
    
    // Only send error details for client errors (4xx)
    if (statusCode >= 400 && statusCode < 500) {
        const errorResponse = {
            error: {
                message: error.message,
                statusCode: statusCode,
                timestamp: new Date().toISOString()
            }
        };

        if (error.field) {
            errorResponse.error.field = error.field;
        }

        res.status(statusCode).json(errorResponse);
    } else {
        // For server errors (5xx), send generic message
        res.status(500).json({
            error: {
                message: 'Internal server error',
                statusCode: 500,
                timestamp: new Date().toISOString()
            }
        });
    }
}

// Main error handler
function errorHandler(error, req, res, next) {
    // Skip if response already sent
    if (res.headersSent) {
        return next(error);
    }

    // Log error
    logger.error(`${req.method} ${req.originalUrl} - ${error.message}`, {
        error: error.name,
        statusCode: error.statusCode || 500,
        stack: error.stack,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        body: req.body,
        params: req.params,
        query: req.query
    });

    // In development: full error details including stack traces (sendErrorDev).
    // In production: only 4xx errors include message; 5xx returns generic "Internal server error" (sendErrorProd).
    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(error, req, res);
    } else {
        sendErrorProd(error, req, res);
    }
}

// 404 handler
function notFoundHandler(req, res, next) {
    const error = new NotFoundError(`Cannot ${req.method} ${req.originalUrl}`);
    next(error);
}

// Async error wrapper
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// Validation helper
function validate(schema) {
    return (req, res, next) => {
        const { error } = schema.validate(req.body);
        if (error) {
            const validationError = new ValidationError(
                error.details[0].message,
                error.details[0].path[0]
            );
            return next(validationError);
        }
        next();
    };
}

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler,
    validate,
    ValidationError,
    NotFoundError,
    AuthenticationError,
    RateLimitError,
    DatabaseError,
    TwitchError
}; 