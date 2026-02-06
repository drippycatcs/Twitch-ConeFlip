const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

// Get real IP address for voting (fallback for unauthenticated users)
function getRealIP(req) {
    const ip = req.ip || 
              req.connection.remoteAddress || 
              req.socket.remoteAddress ||
              (req.headers['x-forwarded-for'] && req.headers['x-forwarded-for'].split(',')[0].trim()) ||
              req.headers['x-real-ip'] ||
              req.headers['cf-connecting-ip'] ||
              '127.0.0.1';
    
    // For local development, create unique IPs based on user agent and session
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1')) {
        const userAgent = req.get('User-Agent') || '';
        const sessionId = req.get('X-Session-ID') || '';
        
        // Create a simple hash for local development
        let hash = 0;
        const str = userAgent + sessionId + (req.get('Sec-Ch-Ua') || '');
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
        }
        
        // Convert to IPv4-like address for local dev
        const c = Math.abs(hash >> 16) % 256;
        const d = Math.abs(hash >> 24) % 256;
        
        return `192.168.${c}.${d}`;
    }
    
    return ip;
}

// Get contest entries (public)
router.get('/entries',
    asyncHandler(async (req, res) => {
        try {
            const submissionService = require('../services/submissionService');
            const allSubmissions = submissionService.submissions || [];
            const contestEntries = allSubmissions.filter(sub => 
                sub.contest === true
            );
            
            res.json({ status: 'success', data: contestEntries });
        } catch (error) {
            logger.error('Error getting contest entries:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get contest entries' });
        }
    })
);

// Get contest vote counts (public)
router.get('/votes',
    asyncHandler(async (req, res) => {
        try {
            const databaseService = require('../services/databaseService');
            const votes = await databaseService.getAllContestVotes();
            res.json({ status: 'success', data: votes });
        } catch (error) {
            logger.error('Error getting contest votes:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get contest votes' });
        }
    })
);

// Submit contest vote (requires Twitch authentication)
router.post('/vote',
    asyncHandler(async (req, res) => {
        try {
            const { submissionId } = req.body;
            
            // Require Twitch authentication for voting
            if (!req.session.user || !req.session.user.id) {
                return res.status(401).json({
                    status: 'error',
                    message: 'You must be logged in with Twitch to vote'
                });
            }
            
            const twitchUserId = req.session.user.id;
            const twitchUsername = req.session.user.login;
            const ipAddress = getRealIP(req); // Still track for backup/logging
            
            if (!submissionId) {
                return res.status(400).json({ status: 'error', message: 'Submission ID is required' });
            }
            
            // Check if contest is enabled
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            let contestEnabled = false;
            if (fs.existsSync(contestPath)) {
                const contest = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
                contestEnabled = contest.enabled;
            }
            
            if (!contestEnabled) {
                return res.status(403).json({ status: 'error', message: 'Contest is not currently active' });
            }
            
            // Verify submission exists and is a contest entry
            const submissionService = require('../services/submissionService');
            const submission = submissionService.getSubmissionById(submissionId);
            
            if (!submission) {
                return res.status(404).json({ status: 'error', message: 'Submission not found' });
            }
            
            if (!submission.contest) {
                return res.status(400).json({ status: 'error', message: 'This submission is not part of the contest' });
            }
            
            const databaseService = require('../services/databaseService');
            
            // Check if user already voted (Twitch user takes precedence over IP)
            const hasVoted = await databaseService.hasUserVoted(submissionId, ipAddress, twitchUserId);
            if (hasVoted) {
                const voteType = twitchUserId ? 'Twitch account' : 'IP address';
                return res.status(409).json({ 
                    status: 'error', 
                    message: `You have already voted for this submission (${voteType})` 
                });
            }
            
            // Add vote with Twitch info if available
            await databaseService.addContestVote(submissionId, ipAddress, twitchUserId, twitchUsername);
            
            const logInfo = twitchUserId ? 
                { submissionId, twitchUserId, twitchUsername } :
                { submissionId, ipAddress: ipAddress.substring(0, 8) + '...' };
            
            logger.info('Contest vote added:', logInfo);
            res.json({ status: 'success', message: 'Vote submitted successfully' });
            
        } catch (error) {
            logger.error('Error submitting contest vote:', error);
            if (error.message.includes('already voted')) {
                res.status(409).json({ status: 'error', message: error.message });
            } else {
                res.status(500).json({ status: 'error', message: 'Failed to submit vote' });
            }
        }
    })
);

// Remove contest vote (unvote) 
router.post('/unvote',
    asyncHandler(async (req, res) => {
        try {
            const { submissionId } = req.body;
            
            // Require Twitch authentication for unvoting
            if (!req.session.user || !req.session.user.id) {
                return res.status(401).json({
                    status: 'error',
                    message: 'You must be logged in with Twitch to unvote'
                });
            }
            
            const twitchUserId = req.session.user.id;
            const twitchUsername = req.session.user.login;
            const ipAddress = getRealIP(req); // Still track for backup/logging
            
            if (!submissionId) {
                return res.status(400).json({ status: 'error', message: 'Submission ID is required' });
            }
            
            // Check if contest is enabled
            const fs = require('fs');
            const path = require('path');
            const contestPath = path.join(process.cwd(), 'public', 'contest.json');
            
            let contestEnabled = false;
            if (fs.existsSync(contestPath)) {
                const contest = JSON.parse(fs.readFileSync(contestPath, 'utf8'));
                contestEnabled = contest.enabled;
            }
            
            if (!contestEnabled) {
                return res.status(403).json({ status: 'error', message: 'Contest is not currently active' });
            }
            
            const databaseService = require('../services/databaseService');
            
            // Check if user has voted (Twitch user takes precedence over IP)
            const hasVoted = await databaseService.hasUserVoted(submissionId, ipAddress, twitchUserId);
            if (!hasVoted) {
                return res.status(404).json({ status: 'error', message: 'You have not voted for this submission' });
            }
            
            // Remove vote
            await databaseService.removeContestVote(submissionId, ipAddress, twitchUserId);
            
            const logInfo = twitchUserId ? 
                { submissionId, twitchUserId, twitchUsername } :
                { submissionId, ipAddress: ipAddress.substring(0, 8) + '...' };
            
            logger.info('Contest vote removed:', logInfo);
            res.json({ status: 'success', message: 'Vote removed successfully' });
            
        } catch (error) {
            logger.error('Error removing contest vote:', error);
            res.status(500).json({ status: 'error', message: 'Failed to remove vote' });
        }
    })
);

// Get user's votes (requires Twitch authentication)
router.get('/user-votes',
    asyncHandler(async (req, res) => {
        try {
            // Require Twitch authentication to see votes
            if (!req.session.user || !req.session.user.id) {
                return res.json({ status: 'success', data: [] });
            }
            
            const twitchUserId = req.session.user.id;
            const ipAddress = getRealIP(req); // Still track for backup/logging
            
            const databaseService = require('../services/databaseService');
            
            const userVotes = await databaseService.getUserVotes(ipAddress, twitchUserId);
            res.json({ status: 'success', data: userVotes });
        } catch (error) {
            logger.error('Error getting user votes:', error);
            res.status(500).json({ status: 'error', message: 'Failed to get user votes' });
        }
    })
);

module.exports = router; 