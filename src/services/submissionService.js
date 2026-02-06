const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

class SubmissionService {
    constructor() {
        this.submissions = [];
        this.nextId = 1;
        this.submissionsFile = path.join(__dirname, '../../data/submissions.json');
        this.initializeSubmissions();
    }

    async initializeSubmissions() {
        try {
            // Ensure data directory exists
            const dataDir = path.dirname(this.submissionsFile);
            await fs.mkdir(dataDir, { recursive: true });
            
            // Try to load existing submissions
            const data = await fs.readFile(this.submissionsFile, 'utf8');
            const savedData = JSON.parse(data);
            
            this.submissions = savedData.submissions || [];
            this.nextId = savedData.nextId || 1;
            
            logger.info('Loaded submissions from file', {
                count: this.submissions.length,
                nextId: this.nextId
            });
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info('No existing submissions file found, starting fresh');
                await this.saveSubmissions();
            } else {
                logger.error('Failed to load submissions:', error);
            }
        }
    }

    async saveSubmissions() {
        try {
            const data = {
                submissions: this.submissions,
                nextId: this.nextId,
                lastSaved: new Date().toISOString()
            };
            
            await fs.writeFile(this.submissionsFile, JSON.stringify(data, null, 2));
            logger.debug('Submissions saved to file');
        } catch (error) {
            logger.error('Failed to save submissions:', error);
        }
    }

    async addSubmission(submissionData) {
        const submission = {
            id: `sub-${this.nextId++}-${Date.now()}`,
            ...submissionData,
            uploadedAt: new Date().toISOString(),
            status: 'pending'
        };
        
        this.submissions.push(submission);
        await this.saveSubmissions();
        
        logger.info('New skin submission added', {
            id: submission.id,
            name: submission.name,
            author: submission.author,
            contest: submission.contest || false
        });
        
        return submission;
    }

    getSubmissions(status = 'pending') {
        return this.submissions.filter(s => s.status === status);
    }

    getSubmissionById(id) {
        return this.submissions.find(s => s.id === id);
    }

    async updateSubmissionStatus(id, status) {
        const submission = this.getSubmissionById(id);
        if (submission) {
            submission.status = status;
            submission.updatedAt = new Date().toISOString();
            await this.saveSubmissions();
            
            logger.info('Submission status updated', {
                id,
                status,
                name: submission.name
            });
            
            return submission;
        }
        return null;
    }

    async updateSubmissionName(id, newName) {
        const submission = this.getSubmissionById(id);
        if (submission) {
            const oldName = submission.name;
            submission.name = newName;
            submission.updatedAt = new Date().toISOString();
            await this.saveSubmissions();
            
            logger.info('Submission name updated', {
                id,
                oldName,
                newName
            });
            
            return submission;
        }
        return null;
    }

    async deleteSubmission(id) {
        const submissionIndex = this.submissions.findIndex(s => s.id === id);
        if (submissionIndex === -1) {
            return false;
        }

        const submission = this.submissions[submissionIndex];
        
        // Try to delete the file
        try {
            const filePath = path.join(__dirname, '../../uploads/submissions', submission.filename);
            await fs.unlink(filePath);
        } catch (error) {
            logger.warn('Failed to delete submission file', {
                id,
                filename: submission.filename,
                error: error.message
            });
        }

        // Remove from submissions array
        this.submissions.splice(submissionIndex, 1);
        await this.saveSubmissions();
        
        logger.info('Submission deleted', {
            id,
            name: submission.name
        });
        
        return true;
    }

    async approveSubmission(id) {
        const submission = this.getSubmissionById(id);
        if (!submission) {
            return { success: false, message: 'Submission not found' };
        }

        try {
            // Determine skin prefix and extension based on type
            const skinPrefix = submission.isHolo ? 'holo_' : 'cone_';
            
            // Clean the name and remove existing prefix if present
            let cleanName = submission.name.toLowerCase().replace(/[^a-z0-9]/g, '_');
            
            // Remove prefix if it already exists in the name
            if (cleanName.startsWith('cone_')) {
                cleanName = cleanName.substring(5); // Remove 'cone_'
            } else if (cleanName.startsWith('holo_')) {
                cleanName = cleanName.substring(5); // Remove 'holo_'
            }
            
            // Keep original extension
            const originalExt = path.extname(submission.filename);
            const finalExt = originalExt || '.png';
            
            // Final filename with prefix
            const finalFilename = `${skinPrefix}${cleanName}${finalExt}`;
            
            // Move file from submissions to skins directory
            const sourcePath = path.join(__dirname, '../../uploads/submissions', submission.filename);
            const targetPath = path.join(__dirname, '../../public/skins', finalFilename);
            
            await fs.copyFile(sourcePath, targetPath);
            
            // Add to config.json
            await this.addSkinToConfig(cleanName, finalFilename, submission.author);
            
            // Update submission status and store final skin info
            await this.updateSubmissionStatus(id, 'approved');
            submission.finalName = cleanName;
            submission.finalFilename = finalFilename;
            submission.approvedAt = new Date().toISOString();
            await this.saveSubmissions();
            
            // Clean up original file
            await fs.unlink(sourcePath);
            
            logger.info('Submission approved and skin added', {
                id,
                name: submission.name,
                author: submission.author,
                isHolo: submission.isHolo,
                targetPath,
                configUpdated: true
            });
            
            return {
                success: true,
                message: `Submission approved and ${submission.isHolo ? 'holo' : 'cone'} skin added to game`,
                data: {
                    skinName: cleanName,
                    submission
                }
            };
            
        } catch (error) {
            logger.error('Failed to approve submission', {
                id,
                error: error.message
            });
            
            return {
                success: false,
                message: 'Failed to process submission: ' + error.message
            };
        }
    }

    async addSkinToConfig(skinName, filename, author) {
        try {
            const configPath = path.join(__dirname, '../../public/skins/config.json');
            
            // Read current config
            let config = [];
            try {
                const configData = await fs.readFile(configPath, 'utf8');
                config = JSON.parse(configData);
            } catch (error) {
                logger.warn('Config file not found or invalid, creating new one');
            }
            
            // Check if skin already exists
            const existingIndex = config.findIndex(skin => skin.name === skinName);
            
            if (existingIndex !== -1) {
                // Update existing skin
                config[existingIndex] = {
                    ...config[existingIndex],
                    visuals: filename,
                    author: author || config[existingIndex].author
                };
                logger.info(`Updated existing skin in config: ${skinName}`);
            } else {
                // Add new skin to config
                const newSkin = {
                    name: skinName,
                    visuals: filename,
                    canUnbox: false, // Default to non-unboxable for safety
                    unboxWeight: 0,
                    author: author || 'Community'
                };
                
                config.push(newSkin);
                logger.info(`Added new skin to config: ${skinName}`);
            }
            
            // Write updated config
            await fs.writeFile(configPath, JSON.stringify(config, null, 2));
            
            // Reload skin system to pick up the new skin
            const SkinService = require('./skinService');
            await SkinService.loadSkinConfiguration();
            
            logger.info('Config.json updated and skin system reloaded', {
                skinName,
                filename,
                author
            });
            
        } catch (error) {
            logger.error('Failed to update config.json', {
                skinName,
                error: error.message
            });
            throw error;
        }
    }

    async rejectSubmission(id, reason = 'No reason provided') {
        const submission = this.getSubmissionById(id);
        if (!submission) {
            return { success: false, message: 'Submission not found' };
        }

        // Update status to rejected
        await this.updateSubmissionStatus(id, 'rejected');
        submission.rejectionReason = reason;
        await this.saveSubmissions();
        
        // Optionally delete the file after some time
        setTimeout(async () => {
            await this.deleteSubmission(id);
        }, 24 * 60 * 60 * 1000); // Delete after 24 hours
        
        logger.info('Submission rejected', {
            id,
            name: submission.name,
            reason
        });
        
        return {
            success: true,
            message: 'Submission rejected',
            data: submission
        };
    }

    getStats() {
        const stats = {
            total: this.submissions.length,
            pending: this.submissions.filter(s => s.status === 'pending').length,
            approved: this.submissions.filter(s => s.status === 'approved').length,
            rejected: this.submissions.filter(s => s.status === 'rejected').length
        };
        
        return stats;
    }

    checkDuplicateName(name) {
        return this.submissions.some(s => 
            s.name.toLowerCase() === name.toLowerCase() && 
            (s.status === 'pending' || s.status === 'approved')
        );
    }
}

// Export singleton instance
module.exports = new SubmissionService(); 