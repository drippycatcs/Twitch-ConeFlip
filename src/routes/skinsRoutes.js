const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireDebugAuth, requireModeratorAuth } = require('../middleware/tokenAuth');
const { validateSetSkin, validateAddCone, createRateLimiter } = require('../middleware/validation');
const SkinService = require('../services/skinService');
const TwitchService = require('../services/twitchService');
const SubmissionService = require('../services/submissionService');
const { config } = require('../config/environment');
const logger = require('../utils/logger');

// Rate limiting
const skinsRateLimit = createRateLimiter(60 * 1000, 60); // 60 requests per minute
const submissionRateLimit = createRateLimiter(60 * 60 * 1000, 5); // 5 submissions per hour

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/submissions');
        fsSync.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `submission-${uniqueId}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|webp/;
        const mimetype = allowedTypes.test(file.mimetype);
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only PNG and WebP files are allowed'));
        }
    }
});

// Error handler for multer
const handleMulterError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
    if (error.message === 'Only image files are allowed') {
        return res.status(400).json({
            status: 'error',
            message: 'Only image files are allowed'
        });
    }
    next(error);
};

// Get all user skins
router.get('/users', asyncHandler(async (req, res) => {
    try {
        const userSkins = await SkinService.getUserSkins();
        res.json(Array.isArray(userSkins) ? userSkins : []);
    } catch (error) {
        logger.error('Error fetching user skins:', error);
        res.json([]);
    }
}));

// Get available skins
router.get('/available', asyncHandler(async (req, res) => {
    try {
        const availableSkins = SkinService.getAvailableSkinsMap();
        res.json(availableSkins);
    } catch (error) {
        logger.error('Error fetching available skins:', error);
        res.json({});
    }
}));

// Get skin odds for unboxing
router.get('/odds', asyncHandler(async (req, res) => {
    const odds = SkinService.getSkinOdds();
    res.json({
        status: 'success',
        data: odds
    });
}));

// Get current seasonal skin (public endpoint)
router.get('/seasonal', asyncHandler(async (req, res) => {
    const seasonalSkin = SkinService.getSeasonalSkin();
    res.json({
        seasonalSkin: seasonalSkin,
        isActive: !!seasonalSkin
    });
}));

// Set/give a skin to a user - MODERATORS CAN ACCESS
router.get('/give',
    requireModeratorAuth,
    skinsRateLimit,
    validateSetSkin,
    asyncHandler(async (req, res) => {
        const { name, skin } = req.validatedData;
        
        // Get Twitch ID if possible
        const twitchId = await TwitchService.getTwitchId(name);
        
        // Set the current skin
        const result = await SkinService.setSkin(name, skin, twitchId);
        
        // Also add the skin to their inventory if they don't have it
        await SkinService.addSkinToInventory(name, skin, twitchId, 1);
        
        // Import GameService to trigger skin refresh
        const GameService = require('../services/gameService');
        await GameService.refreshSkins();
        
        logger.userAction('skin_given', name, { skin });
        
        res.json({
            status: 'success',
            ...result
        });
    })
);

// Get user's current skin and inventory
router.get('/user/:name', asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase().trim();

    // Get current skin, inventory, and shuffle state in parallel
    const [skin, inventory, shuffle] = await Promise.all([
        SkinService.getUserSkin(name),
        SkinService.getUserInventory(name),
        SkinService.getShuffleEnabled(name)
    ]);

    res.json({
        status: 'success',
        data: {
            name,
            skin,
            inventory,
            shuffle
        }
    });
}));

// Get user's inventory
router.get('/inventory/:name', asyncHandler(async (req, res) => {
    const name = req.params.name.toLowerCase().trim();
    const inventory = await SkinService.getUserInventory(name);
    
    res.json({
        status: 'success',
        data: inventory
    });
}));

// Get skin statistics
router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await SkinService.getSkinStats();
    res.json({
        status: 'success',
        data: stats
    });
}));

// Unbox a random skin (for admin use) - ADMIN ONLY
router.get('/unbox/:name',
    requireDebugAuth,
    skinsRateLimit,
    asyncHandler(async (req, res) => {
        const name = req.params.name.toLowerCase().trim();
        
        // Get Twitch ID if possible
        const twitchId = await TwitchService.getTwitchId(name);
        
        const result = await SkinService.setRandomSkin(name, twitchId);
        
        // Import GameService to trigger skin refresh
        const GameService = require('../services/gameService');
        await GameService.refreshSkins();
        
        logger.userAction('skin_unboxed', name, { 
            skin: result.skin,
            rarity: result.rarity 
        });
        
        res.json({
            status: 'success',
            ...result
        });
    })
);

// Check 7TV paint for user - supports both /:name and ?name= formats for compatibility
router.get('/paint/:name?', asyncHandler(async (req, res) => {
    // Support both URL parameter and query parameter for backward compatibility
    const name = (req.params.name || req.query.name || '').toLowerCase().trim();
    
    if (!name) {
        return res.json({
            status: 'error',
            message: 'Name parameter is required'
        });
    }
    
    try {
        const paintData = await TwitchService.getUser7TVPaint(name);
        
        if (paintData) {
            // Check if the username doesn't match (different case sensitivity)
            if (paintData.username && paintData.username.toLowerCase() !== name) {
                return res.json({ 
                    message: 'No active paint set.', 
                    username: paintData.username 
                });
            }
            
            // Return paint data directly like the old API
            res.json(paintData);
        } else {
            res.json({ message: 'No active paint set.' });
        }
    } catch (error) {
        logger.error(`Error fetching paint for ${name}:`, error);
        res.json({ message: 'Paint service unavailable.' });
    }
}));

// Check if text is an emote
router.get('/emote/:text', asyncHandler(async (req, res) => {
    const text = req.params.text.trim();
    
    try {
        const emoteData = await TwitchService.isEmote(text);
        res.json({
            status: 'success',
            data: emoteData
        });
    } catch (error) {
        res.json({
            status: 'success',
            data: { isEmote: false, url: null }
        });
    }
}));

// Download template skin
router.get('/template', asyncHandler(async (req, res) => {
    const templatePath = path.join(__dirname, '../../public/skins/cone_default.png');
    
    try {
        await fs.access(templatePath);
        res.download(templatePath, 'cone_template.png');
    } catch (error) {
        res.status(404).json({
            status: 'error',
            message: 'Template file not found'
        });
    }
}));

// Submit a new skin
router.post('/submit',
    submissionRateLimit,
    upload.single('skinFile'),
    asyncHandler(async (req, res) => {
        const { skinName, authorName } = req.body;
        
        if (!req.file) {
            return res.status(400).json({
                status: 'error',
                message: 'No file uploaded'
            });
        }
        
        if (!skinName || !authorName) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name and author name are required'
            });
        }

        // Length and character validation
        if (skinName.length > 50) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name must be 50 characters or less'
            });
        }
        if (authorName.length > 25) {
            return res.status(400).json({
                status: 'error',
                message: 'Author name must be 25 characters or less'
            });
        }
        if (!/^[a-zA-Z0-9_ -]+$/.test(skinName)) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name can only contain letters, numbers, spaces, hyphens, and underscores'
            });
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(authorName)) {
            return res.status(400).json({
                status: 'error',
                message: 'Author name can only contain letters, numbers, hyphens, and underscores'
            });
        }

        // Check if skin name already exists
        if (SubmissionService.checkDuplicateName(skinName)) {
            return res.status(400).json({
                status: 'error',
                message: 'A skin with this name already exists in the submission queue'
            });
        }
        
        // Create submission entry
        const submission = await SubmissionService.addSubmission({
            name: skinName.trim(),
            author: authorName.trim(),
            filename: req.file.filename,
            originalName: req.file.originalname,
            isHolo: req.body.isHolo === 'true' || req.body.isHolo === true,
            contest: req.body.isContest === 'true' || req.body.isContest === true
        });
        
        logger.info('New skin submission received', {
            id: submission.id,
            name: submission.name,
            author: submission.author,
            filename: submission.filename
        });
        
        // Notify the streamer about the new submission
        try {
            if (TwitchService.sendChatMessage) {
                const modUrl = config.BASE_URL ? `${config.BASE_URL}/mod` : '/mod';
                const notificationMessage = `Alarm ${submission.author} submitted a new cone "${submission.name}" - approve or reject in ${modUrl}`;

                await TwitchService.sendChatMessage(notificationMessage);

                logger.info('Streamer notified about new skin submission', {
                    skinName: submission.name,
                    author: submission.author,
                    message: notificationMessage
                });
            }
        } catch (error) {
            // Don't fail the submission if notification fails
            logger.warn('Failed to notify streamer about skin submission:', error);
        }
        
        res.json({
            status: 'success',
            message: 'Skin submitted successfully! It will be reviewed by admins.',
            data: {
                id: submission.id,
                name: submission.name
            }
        });
    })
);

// Get submission preview (for admin panel)
router.get('/submissions/preview/:id', asyncHandler(async (req, res) => {
    const submissionId = req.params.id;
    const submission = SubmissionService.getSubmissionById(submissionId);
    
    if (!submission) {
        return res.status(404).json({
            status: 'error',
            message: 'Submission not found'
        });
    }
    
    const filePath = path.join(__dirname, '../../uploads/submissions', submission.filename);
    
    try {
        await fs.access(filePath);
        res.sendFile(filePath);
    } catch (error) {
        res.status(404).json({
            status: 'error',
            message: 'Submission file not found'
        });
    }
}));

// Gift skin to user (admin function) - This is a duplicate route and should be removed
// The main /give route above handles both cases

// Toggle shuffle for authenticated user (from profile)
router.post('/shuffle',
    asyncHandler(async (req, res) => {
        if (!req.session.user || !req.session.user.id) {
            return res.status(401).json({
                status: 'error',
                message: 'Authentication required'
            });
        }

        try {
            const username = req.session.user.login;
            const currentState = await SkinService.getShuffleEnabled(username);
            const newState = !currentState;
            await SkinService.setShuffleEnabled(username, newState);

            logger.info(`User ${username} toggled shuffle: ${newState}`);

            res.json({
                status: 'success',
                shuffle: newState,
                message: `Skin shuffle ${newState ? 'enabled' : 'disabled'}!`
            });
        } catch (error) {
            logger.error('Error toggling shuffle:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to toggle shuffle'
            });
        }
    })
);

// Select skin for authenticated user (from profile)
router.post('/select',
    asyncHandler(async (req, res) => {
        const { skinName } = req.body;
        
        // Check if user is authenticated
        if (!req.session.user || !req.session.user.id) {
            return res.status(401).json({
                status: 'error',
                message: 'Authentication required'
            });
        }
        
        if (!skinName) {
            return res.status(400).json({
                status: 'error',
                message: 'Skin name is required'
            });
        }
        
        try {
            const username = req.session.user.login;
            const twitchId = req.session.user.id;
            
            // Check if user owns this skin
            const userInventory = await SkinService.getUserInventory(username);
            const hasSkin = userInventory && userInventory.some(item => {
                const itemSkinName = typeof item === 'string' ? item : (item.skin || item.name || item);
                return itemSkinName && itemSkinName.toLowerCase() === skinName.toLowerCase();
            });
            
            if (!hasSkin && skinName.toLowerCase() !== 'default') {
                return res.status(403).json({
                    status: 'error',
                    message: `You don't own the "${skinName}" skin`
                });
            }
            
            // Set the skin
            const result = await SkinService.setSkin(username, skinName, twitchId);
            
            logger.info(`User ${username} selected skin: ${skinName}`);
            
            res.json({
                status: 'success',
                message: `Skin changed to "${skinName}"!`,
                skin: skinName
            });
        } catch (error) {
            logger.error('Error selecting skin:', error);
            res.status(500).json({
                status: 'error',
                message: 'Failed to select skin'
            });
        }
    })
);

module.exports = router; 