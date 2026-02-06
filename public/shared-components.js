// Shared components for ConeFlip V2 pages
class SharedComponents {
    constructor() {
        this.announcement = null;
        this.contest = null;
        this.isMobileMenuOpen = false;
        this.user = null; // Current authenticated user
        this.init();
    }

    async init() {
        this.initializeTheme();
        await this.checkAuthStatus(); // Check authentication first
        await this.loadAnnouncement();
        await this.loadContest();
        this.createAnnouncementBar();
        this.createNavigation();
        this.createFooter();
        this.setupWebSocket();
        this.setupMobileNavigation();
    }

    async checkAuthStatus() {
        try {
            const response = await fetch('/auth/user', {
                credentials: 'include'
            });
            const result = await response.json();
            
            if (result.status === 'success' && result.data) {
                this.user = result.data;
            } else {
                this.user = null;
            }
        } catch (error) {
            console.error('Error checking auth status:', error);
            this.user = null;
        }
    }

    async login() {
        window.location.href = '/auth/login';
    }

    async logout() {
        try {
            const response = await fetch('/auth/logout', {
                method: 'POST',
                credentials: 'include'
            });
            
            if (response.ok) {
                this.user = null;
                this.updateNavigation();
                
                // Show success message if we're on a page that supports it
                if (typeof showNotification === 'function') {
                    showNotification('Successfully logged out!', 'success');
                }
                
                // Redirect to home page if on profile
                if (window.location.pathname.startsWith('/u/')) {
                    window.location.href = '/';
                }
            } else {
                console.error('Logout failed');
            }
        } catch (error) {
            console.error('Logout error:', error);
        }
    }

    initializeTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    }

    async loadAnnouncement() {
        try {
            const response = await fetch('/api/debug/announcement/public');
            const result = await response.json();
            this.announcement = result.data || { enabled: false, content: "" };
        } catch (error) {
            console.error('Error loading announcement:', error);
            this.announcement = { enabled: false, content: "" };
        }
    }

    async loadContest() {
        try {
            const response = await fetch('/api/debug/contest/public');
            const result = await response.json();
            this.contest = result.data || { enabled: false, prize: "", description: "" };
        } catch (error) {
            console.error('Error loading contest:', error);
            this.contest = { enabled: false, prize: "", description: "" };
        }
    }

    createAnnouncementBar() {
        // Remove existing announcement bar if it exists
        const existingBar = document.getElementById('announcement-bar');
        if (existingBar) {
            existingBar.remove();
        }

        if (!this.announcement.enabled || !this.announcement.content.trim()) {
            return;
        }

        const announcementBar = document.createElement('div');
        announcementBar.id = 'announcement-bar';
        announcementBar.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: rgba(59, 130, 246, 0.1);
            backdrop-filter: blur(10px);
            color: var(--text-primary, #1f2937);
            padding: 8px 20px;
            text-align: center;
            font-size: 0.85rem;
            font-weight: 500;
            z-index: 1000;
            border-bottom: 1px solid rgba(59, 130, 246, 0.2);
        `;
        announcementBar.innerHTML = this.announcement.content;

        // Add announcement bar to the page
        document.body.insertBefore(announcementBar, document.body.firstChild);

        // Don't add padding yet - will be calculated after navigation is created
    }

    createNavigation() {
        // Check if navigation already exists
        if (document.getElementById('shared-navigation')) {
            return;
        }

        const navigation = document.createElement('div');
        navigation.id = 'shared-navigation';
        
        // Calculate announcement bar height if it exists
        const existingAnnouncementBar = document.getElementById('announcement-bar');
        const currentAnnouncementHeight = existingAnnouncementBar ? existingAnnouncementBar.offsetHeight : 0;
        
        navigation.style.cssText = `
            position: fixed;
            top: ${currentAnnouncementHeight}px;
            left: 0;
            right: 0;
            background: var(--card-bg, rgba(255, 255, 255, 0.95));
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--card-border, rgba(0, 0, 0, 0.1));
            padding: 12px 20px;
            z-index: 999;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 15px;
            transition: all 0.3s ease;
        `;

        const leftSection = document.createElement('div');
        leftSection.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 2px;
        `;

        const title = document.createElement('div');
        title.style.cssText = `
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--text-primary, #1f2937);
        `;
        title.innerHTML = '<a href="/" style="text-decoration: none; color: inherit;">ConeFlip V2</a>';

        const author = document.createElement('div');
        author.style.cssText = `
            font-size: 0.8rem;
            color: var(--text-secondary, #6b7280);
            font-weight: 500;
        `;
        author.innerHTML = 'By <a href="https://x.com/drippycatcs" target="_blank" style="color: var(--text-link, #3b82f6); text-decoration: none;">@drippycatcs</a>';

        // Live status badge
        const liveStatusBadge = document.createElement('span');
        liveStatusBadge.id = 'streamer-live-badge';
        liveStatusBadge.style.cssText = `
            display: none;
            align-items: center;
            gap: 5px;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.65rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-left: 8px;
            vertical-align: middle;
        `;

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center;';
        titleRow.appendChild(title);
        titleRow.appendChild(liveStatusBadge);

        leftSection.appendChild(titleRow);
        leftSection.appendChild(author);

        // Fetch streamer live status
        fetch('/api/public/info')
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                const isLive = !!data.isLive;
                const channel = data.channel || 'Streamer';
                liveStatusBadge.style.display = 'inline-flex';
                if (isLive) {
                    liveStatusBadge.style.background = 'rgba(239, 68, 68, 0.15)';
                    liveStatusBadge.style.color = '#ef4444';
                    liveStatusBadge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#ef4444;animation:livePulse 1.5s ease-in-out infinite;"></span>' + channel + ' is LIVE';
                } else {
                    liveStatusBadge.style.background = 'var(--input-bg, rgba(0,0,0,0.05))';
                    liveStatusBadge.style.color = 'var(--text-secondary, #6b7280)';
                    liveStatusBadge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--text-secondary,#6b7280);opacity:0.5;"></span>' + channel + ' is Offline';
                }
            })
            .catch(() => {});

        // Inject livePulse keyframes
        if (!document.getElementById('live-pulse-style')) {
            const pulseStyle = document.createElement('style');
            pulseStyle.id = 'live-pulse-style';
            pulseStyle.textContent = '@keyframes livePulse { 0%, 100% { opacity:1; box-shadow: 0 0 0 0 rgba(239,68,68,0.6); } 50% { opacity:0.8; box-shadow: 0 0 0 4px rgba(239,68,68,0); } }';
            document.head.appendChild(pulseStyle);
        }

        const rightSection = document.createElement('div');
        rightSection.id = 'nav-right-section';
        rightSection.style.cssText = `
            display: flex;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
    
        `;

        // Create hamburger menu button (initially hidden)
        const hamburgerButton = document.createElement('button');
        hamburgerButton.id = 'hamburger-menu-btn';
        hamburgerButton.setAttribute('aria-label', 'Toggle navigation menu');
        hamburgerButton.style.cssText = `
            display: none;
            background: none;
            border: none;
            cursor: pointer;
            padding: 8px;
            border-radius: 6px;
            transition: all 0.2s ease;
            color: var(--text-primary, #1f2937);
            font-size: 1.2rem;
            min-width: 40px;
            min-height: 40px;
            align-items: center;
            justify-content: center;
        `;
        hamburgerButton.innerHTML = '☰';
        
        hamburgerButton.addEventListener('click', () => {
            this.toggleMobileMenu();
        });

        hamburgerButton.addEventListener('mouseenter', () => {
            hamburgerButton.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
        });

        hamburgerButton.addEventListener('mouseleave', () => {
            hamburgerButton.style.background = 'none';
        });

        const navLinks = document.createElement('div');
        navLinks.id = 'nav-links';
        navLinks.style.cssText = `
            display: flex;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
        `;

        const links = [
            { href: '/skins', text: 'Skins' },
            { href: '/trails', text: 'Trails' },
            { href: '/skins/submissions', text: 'Submit Skins' },
            { href: '/leaderboard-public', text: 'Leaderboard' },
            { href: '/u/', text: 'Profiles' },
            { href: '/commands', text: 'Commands' },
            { href: '/changelog', text: 'Changelog' }
        ];

        // Add contest link if contests are enabled
        if (this.contest && this.contest.enabled) {
            links.splice(2, 0, { href: '/contest', text: 'Contest' });
        }

        links.forEach(link => {
            const navLink = document.createElement('a');
            navLink.href = link.href;
            navLink.textContent = link.text;
            navLink.style.cssText = `
                text-decoration: none;
                color: var(--text-secondary, #6b7280);
                font-weight: 500;
                font-size: 0.9rem;
                padding: 8px 12px;
                border-radius: 8px;
                transition: all 0.2s ease;
                background: transparent;
                border: 1px solid transparent;
                white-space: nowrap;
            `;

            // Highlight current page
            if (window.location.pathname === link.href || 
                (link.href === '/u/' && window.location.pathname.startsWith('/u/')) ||
                (link.href === '/skins' && window.location.pathname === '/') ||
                (link.href === '/skins/submissions' && window.location.pathname === '/skins-submissions.html') ||
                (link.href === '/trails' && window.location.pathname === '/trails') ||
                (link.href === '/changelog' && window.location.pathname === '/changelog.html')) {
                navLink.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.1))';
                navLink.style.color = 'var(--text-primary, #1f2937)';
                navLink.style.borderColor = 'var(--card-border, rgba(59, 130, 246, 0.2))';
            }

            navLink.addEventListener('mouseenter', () => {
                if (!navLink.style.background.includes('rgba(59, 130, 246')) {
                    navLink.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
                    navLink.style.color = 'var(--text-primary, #1f2937)';
                }
            });

            navLink.addEventListener('mouseleave', () => {
                if (!navLink.style.background.includes('rgba(59, 130, 246')) {
                    navLink.style.background = 'transparent';
                    navLink.style.color = 'var(--text-secondary, #6b7280)';
                }
            });

            // Close mobile menu when link is clicked
            navLink.addEventListener('click', () => {
                if (this.isMobileMenuOpen) {
                    this.toggleMobileMenu();
                }
            });

            navLinks.appendChild(navLink);
        });

        // Create theme toggle button
        const themeToggle = document.createElement('button');
        themeToggle.id = 'shared-theme-toggle';
        themeToggle.style.cssText = `
            background: var(--input-bg, rgba(0, 0, 0, 0.05));
            border: 1px solid var(--input-border, rgba(0, 0, 0, 0.1));
            border-radius: 6px;
            padding: 6px 10px;
            cursor: pointer;
            transition: all 0.2s ease;
            color: var(--text-primary, #1f2937);
            font-size: 0.85rem;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        `;
        
        // Set initial theme state
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        themeToggle.innerHTML = currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
        
        themeToggle.addEventListener('click', () => {
            this.toggleTheme();
        });

        themeToggle.addEventListener('mouseenter', () => {
            themeToggle.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.1))';
            themeToggle.style.borderColor = 'var(--card-border, rgba(59, 130, 246, 0.2))';
        });

        themeToggle.addEventListener('mouseleave', () => {
            themeToggle.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
            themeToggle.style.borderColor = 'var(--input-border, rgba(0, 0, 0, 0.1))';
        });

        // Create authentication buttons
        const authContainer = this.createAuthButtons();

        // Create admin button if user is admin
        const adminButton = this.createAdminButton();
        // Create mod button if user is moderator (but not admin)
        const modButton = this.createModButton();

        // Create Ko-fi donate link
        const kofiLink = document.createElement('a');
        kofiLink.href = 'https://ko-fi.com/drippycat';
        kofiLink.target = '_blank';
        kofiLink.rel = 'noopener';
        kofiLink.title = 'Support on Ko-fi';
        kofiLink.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.782 3.468-.963 1.904.82 1.832 3.011.723 4.311zm6.173.478c-.928.116-1.682.028-1.682.028V7.284h1.77s1.971.551 1.971 2.638c0 1.913-.985 2.667-2.059 3.015z"/></svg>`;
        kofiLink.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 6px;
            color: var(--text-tertiary, #6b7280);
            transition: color 0.2s ease;
            text-decoration: none;
        `;
        kofiLink.addEventListener('mouseenter', () => {
            kofiLink.style.color = '#ff5f5f';
        });
        kofiLink.addEventListener('mouseleave', () => {
            kofiLink.style.color = 'var(--text-tertiary, #6b7280)';
        });

        rightSection.appendChild(navLinks);
        if (adminButton) rightSection.appendChild(adminButton);
        if (modButton) rightSection.appendChild(modButton);
        rightSection.appendChild(authContainer);
        rightSection.appendChild(kofiLink);
        rightSection.appendChild(themeToggle);
        rightSection.appendChild(hamburgerButton);

        navigation.appendChild(leftSection);
        navigation.appendChild(rightSection);

        // Create mobile navigation overlay
        const mobileNavOverlay = document.createElement('div');
        mobileNavOverlay.id = 'mobile-nav-overlay';
        mobileNavOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 998;
            display: none;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        
        mobileNavOverlay.addEventListener('click', () => {
            this.toggleMobileMenu();
        });

        // Create mobile navigation menu
        const mobileNavMenu = document.createElement('div');
        mobileNavMenu.id = 'mobile-nav-menu';
        mobileNavMenu.style.cssText = `
            position: fixed;
            top: 0;
            right: -300px;
            width: 280px;
            height: 100vh;
            background: var(--card-bg, rgba(255, 255, 255, 0.95));
            backdrop-filter: blur(10px);
            border-left: 1px solid var(--card-border, rgba(0, 0, 0, 0.1));
            z-index: 999;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
            transition: right 0.3s ease;
            box-shadow: -5px 0 20px rgba(0, 0, 0, 0.1);
            overflow-y: auto;
            z-index: 1001;
        `;

        // Add mobile menu header
        const mobileMenuHeader = document.createElement('div');
        mobileMenuHeader.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--card-border, rgba(0, 0, 0, 0.1));
        `;

        const mobileMenuTitle = document.createElement('div');
        mobileMenuTitle.style.cssText = `
            font-size: 1.1rem;
            font-weight: 600;
            color: var(--text-primary, #1f2937);
        `;
        mobileMenuTitle.textContent = 'Navigation';

        const mobileMenuClose = document.createElement('button');
        mobileMenuClose.style.cssText = `
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            color: var(--text-primary, #1f2937);
            padding: 5px;
            border-radius: 4px;
            transition: background 0.2s ease;
        `;
        mobileMenuClose.innerHTML = '×';
        mobileMenuClose.setAttribute('aria-label', 'Close navigation menu');
        mobileMenuClose.addEventListener('click', () => {
            this.toggleMobileMenu();
        });

        mobileMenuClose.addEventListener('mouseenter', () => {
            mobileMenuClose.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
        });

        mobileMenuClose.addEventListener('mouseleave', () => {
            mobileMenuClose.style.background = 'none';
        });

        mobileMenuHeader.appendChild(mobileMenuTitle);
        mobileMenuHeader.appendChild(mobileMenuClose);
        mobileNavMenu.appendChild(mobileMenuHeader);

        // Add navigation links to mobile menu
        links.forEach(link => {
            const mobileNavLink = document.createElement('a');
            mobileNavLink.href = link.href;
            mobileNavLink.textContent = link.text;
            mobileNavLink.style.cssText = `
                text-decoration: none;
                color: var(--text-secondary, #6b7280);
                font-weight: 500;
                font-size: 1rem;
                padding: 12px 16px;
                border-radius: 8px;
                transition: all 0.2s ease;
                background: transparent;
                border: 1px solid transparent;
                display: block;
            `;

            // Highlight current page
            if (window.location.pathname === link.href || 
                (link.href === '/u/' && window.location.pathname.startsWith('/u/')) ||
                (link.href === '/skins' && window.location.pathname === '/') ||
                (link.href === '/skins/submissions' && window.location.pathname === '/skins-submissions.html') ||
                (link.href === '/changelog' && window.location.pathname === '/changelog.html')) {
                mobileNavLink.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.1))';
                mobileNavLink.style.color = 'var(--text-primary, #1f2937)';
                mobileNavLink.style.borderColor = 'var(--card-border, rgba(59, 130, 246, 0.2))';
            }

            mobileNavLink.addEventListener('click', () => {
                this.toggleMobileMenu();
            });

            mobileNavLink.addEventListener('mouseenter', () => {
                if (!mobileNavLink.style.background.includes('rgba(59, 130, 246')) {
                    mobileNavLink.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
                    mobileNavLink.style.color = 'var(--text-primary, #1f2937)';
                }
            });

            mobileNavLink.addEventListener('mouseleave', () => {
                if (!mobileNavLink.style.background.includes('rgba(59, 130, 246')) {
                    mobileNavLink.style.background = 'transparent';
                    mobileNavLink.style.color = 'var(--text-secondary, #6b7280)';
                }
            });

            mobileNavMenu.appendChild(mobileNavLink);
        });

        // Add theme toggle to mobile menu
        const mobileThemeToggle = document.createElement('button');
        mobileThemeToggle.id = 'mobile-theme-toggle';
        mobileThemeToggle.innerHTML = currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
        mobileThemeToggle.style.cssText = `
            background: var(--input-bg, rgba(0, 0, 0, 0.05));
            border: 1px solid var(--input-border, rgba(0, 0, 0, 0.1));
            border-radius: 8px;
            padding: 12px 16px;
            cursor: pointer;
            transition: all 0.2s ease;
            color: var(--text-primary, #1f2937);
            font-size: 1rem;
            font-weight: 500;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-top: auto;
        `;
        
        mobileThemeToggle.addEventListener('click', () => {
            this.toggleTheme();
        });

        mobileThemeToggle.addEventListener('mouseenter', () => {
            mobileThemeToggle.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.1))';
            mobileThemeToggle.style.borderColor = 'var(--card-border, rgba(59, 130, 246, 0.2))';
        });

        mobileThemeToggle.addEventListener('mouseleave', () => {
            mobileThemeToggle.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
            mobileThemeToggle.style.borderColor = 'var(--input-border, rgba(0, 0, 0, 0.1))';
        });

        mobileNavMenu.appendChild(mobileThemeToggle);

        // Insert navigation after announcement bar or at the top
        if (existingAnnouncementBar) {
            existingAnnouncementBar.insertAdjacentElement('afterend', navigation);
        } else {
            document.body.insertBefore(navigation, document.body.firstChild);
        }

        // Add mobile navigation elements to body
        document.body.appendChild(mobileNavOverlay);
        document.body.appendChild(mobileNavMenu);

        // Adjust body padding for navigation
        const navHeight = navigation.offsetHeight;
        document.body.style.paddingTop = (currentAnnouncementHeight + navHeight + 20) + 'px';
    }

    createFooter() {
        const footer = document.createElement('footer');
        footer.style.cssText = 'text-align: center; padding: 24px 20px 16px; color: var(--text-tertiary, #6b7280); font-size: 0.75rem;';
        const link = document.createElement('a');
        link.href = 'https://ko-fi.com/drippycat';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'donate on Ko-fi';
        link.style.cssText = 'color: var(--text-tertiary, #6b7280); text-decoration: underline;';
        footer.append('ConeFlip is free to use. If you\'d like to help cover server costs, ', link, '.');
        document.body.appendChild(footer);
    }

    setupWebSocket() {
        try {
            const socket = io();
            
            socket.on('announcementUpdate', (data) => {
                console.log('Announcement updated:', data);
                this.announcement = data;
                this.updateAnnouncementBar();
            });

            socket.on('connect', () => {
                console.log('Connected to WebSocket for shared components');
            });

        } catch (error) {
            console.warn('WebSocket not available for shared components');
        }
    }

    updateAnnouncementBar() {
        // Remove current announcement bar
        const existingBar = document.getElementById('announcement-bar');
        if (existingBar) {
            existingBar.remove();
        }

        // Create new announcement bar
        this.createAnnouncementBar();

        // Update navigation position
        const navigation = document.getElementById('shared-navigation');
        const updatedAnnouncementBar = document.getElementById('announcement-bar');
        const updatedAnnouncementHeight = updatedAnnouncementBar ? updatedAnnouncementBar.offsetHeight : 0;
        
        if (navigation) {
            navigation.style.top = updatedAnnouncementHeight + 'px';
        }

        // Update body padding
        const navHeight = navigation ? navigation.offsetHeight : 0;
        document.body.style.paddingTop = (updatedAnnouncementHeight + navHeight + 20) + 'px';
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        // Update both theme toggle buttons
        const themeToggle = document.getElementById('shared-theme-toggle');
        const mobileThemeToggle = document.getElementById('mobile-theme-toggle');
        const newThemeText = newTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
        
        if (themeToggle) {
            themeToggle.innerHTML = newThemeText;
        }
        if (mobileThemeToggle) {
            mobileThemeToggle.innerHTML = newThemeText;
        }
    }

    toggleMobileMenu() {
        this.isMobileMenuOpen = !this.isMobileMenuOpen;
        const overlay = document.getElementById('mobile-nav-overlay');
        const menu = document.getElementById('mobile-nav-menu');
        const hamburgerBtn = document.getElementById('hamburger-menu-btn');

        if (this.isMobileMenuOpen) {
            // Open menu
            overlay.style.display = 'block';
            setTimeout(() => {
                overlay.style.opacity = '1';
                menu.style.right = '0';
            }, 10);
            hamburgerBtn.innerHTML = '×';
            hamburgerBtn.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
        } else {
            // Close menu
            overlay.style.opacity = '0';
            menu.style.right = '-300px';
            setTimeout(() => {
                overlay.style.display = 'none';
            }, 300);
            hamburgerBtn.innerHTML = '☰';
            hamburgerBtn.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        }
    }

    // Mobile responsive navigation
    setupMobileNavigation() {
        const mediaQuery = window.matchMedia('(max-width: 768px)');
        
        const handleMobileView = (e) => {
            const navigation = document.getElementById('shared-navigation');
            const rightSection = document.getElementById('nav-right-section');
            const navLinks = document.getElementById('nav-links');
            const themeToggle = document.getElementById('shared-theme-toggle');
            const hamburgerBtn = document.getElementById('hamburger-menu-btn');
            const mobileThemeToggle = document.getElementById('mobile-theme-toggle');
            
            if (e.matches) {
                // Mobile view - show hamburger, hide nav links
                if (navigation) {
                    navigation.style.flexDirection = 'row';
                    navigation.style.alignItems = 'center';
                    navigation.style.padding = '12px 20px';
                    navigation.style.gap = '15px';
                }
                if (navLinks) {
                    navLinks.style.display = 'none';
                }
                if (themeToggle) {
                    themeToggle.style.display = 'none';
                }
                if (hamburgerBtn) {
                    hamburgerBtn.style.display = 'flex';
                }
                
                // Update mobile theme toggle to match current theme
                if (mobileThemeToggle) {
                    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
                    mobileThemeToggle.innerHTML = currentTheme === 'dark' ? '☀️ Light' : '🌙 Dark';
                }
            } else {
                // Desktop view - hide hamburger, show nav links
                if (navigation) {
                    navigation.style.flexDirection = 'row';
                    navigation.style.alignItems = 'center';
                    navigation.style.padding = '12px 20px';
                    navigation.style.gap = '15px';
                }
                if (navLinks) {
                    navLinks.style.display = 'flex';
                }
                if (themeToggle) {
                    themeToggle.style.display = 'flex';
                }
                if (hamburgerBtn) {
                    hamburgerBtn.style.display = 'none';
                }
                
                // Close mobile menu if it's open
                if (this.isMobileMenuOpen) {
                    this.toggleMobileMenu();
                }
            }
        };

        mediaQuery.addListener(handleMobileView);
        handleMobileView(mediaQuery);
        
        // Handle window resize to close mobile menu
        window.addEventListener('resize', () => {
            if (window.innerWidth > 768 && this.isMobileMenuOpen) {
                this.toggleMobileMenu();
            }
        });

        // Handle keyboard events for mobile menu
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isMobileMenuOpen) {
                this.toggleMobileMenu();
            }
        });
    }

    createAuthButtons() {
        const authContainer = document.createElement('div');
        authContainer.id = 'auth-container';
        authContainer.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
        `;

        if (this.user) {
            // User is logged in - show profile link and logout button
            const profileLink = document.createElement('a');
            profileLink.href = `/u/${this.user.login}`;
            profileLink.style.cssText = `
                text-decoration: none;
                color: var(--text-secondary, #6b7280);
                font-weight: 500;
                font-size: 0.9rem;
                padding: 6px 10px;
                border-radius: 6px;
                transition: all 0.2s ease;
                background: transparent;
                border: 1px solid transparent;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: 6px;
            `;
            
            profileLink.innerHTML = `
                <img src="${this.user.profile_image_url}" alt="Profile" style="width: 20px; height: 20px; border-radius: 50%;" />
                ${this.user.display_name}
            `;

            profileLink.addEventListener('mouseenter', () => {
                profileLink.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
                profileLink.style.color = 'var(--text-primary, #1f2937)';
            });

            profileLink.addEventListener('mouseleave', () => {
                profileLink.style.background = 'transparent';
                profileLink.style.color = 'var(--text-secondary, #6b7280)';
            });

            const logoutButton = document.createElement('button');
            logoutButton.textContent = 'Logout';
            logoutButton.style.cssText = `
                background: var(--input-bg, rgba(0, 0, 0, 0.05));
                border: 1px solid var(--input-border, rgba(0, 0, 0, 0.1));
                border-radius: 6px;
                padding: 6px 10px;
                cursor: pointer;
                transition: all 0.2s ease;
                color: var(--text-primary, #1f2937);
                font-size: 0.85rem;
                font-weight: 500;
                white-space: nowrap;
            `;

            logoutButton.addEventListener('click', () => {
                this.logout();
            });

            logoutButton.addEventListener('mouseenter', () => {
                logoutButton.style.background = 'var(--status-bg, rgba(220, 38, 38, 0.1))';
                logoutButton.style.borderColor = 'var(--card-border, rgba(220, 38, 38, 0.2))';
                logoutButton.style.color = '#dc2626';
            });

            logoutButton.addEventListener('mouseleave', () => {
                logoutButton.style.background = 'var(--input-bg, rgba(0, 0, 0, 0.05))';
                logoutButton.style.borderColor = 'var(--input-border, rgba(0, 0, 0, 0.1))';
                logoutButton.style.color = 'var(--text-primary, #1f2937)';
            });

            authContainer.appendChild(profileLink);
            authContainer.appendChild(logoutButton);
        } else {
            // User is not logged in - show login button
            const loginButton = document.createElement('button');
            loginButton.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 6px;">
                    <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
                </svg>
                Login
            `;
            loginButton.style.cssText = `
                background: #9146ff;
                border: 1px solid #9146ff;
                border-radius: 6px;
                padding: 6px 12px;
                cursor: pointer;
                transition: all 0.2s ease;
                color: white;
                font-size: 0.85rem;
                font-weight: 500;
                white-space: nowrap;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            loginButton.addEventListener('click', () => {
                this.login();
            });

            loginButton.addEventListener('mouseenter', () => {
                loginButton.style.background = '#7c3aed';
                loginButton.style.borderColor = '#7c3aed';
                loginButton.style.transform = 'translateY(-1px)';
            });

            loginButton.addEventListener('mouseleave', () => {
                loginButton.style.background = '#9146ff';
                loginButton.style.borderColor = '#9146ff';
                loginButton.style.transform = 'translateY(0)';
            });

            authContainer.appendChild(loginButton);
        }

        return authContainer;
    }

    createAdminButton() {
        if (!this.user || !this.user.is_admin) {
            return null;
        }

        const adminButton = document.createElement('a');
        adminButton.href = '/admin';
        adminButton.id = 'admin-button';
        adminButton.textContent = 'Admin';
        adminButton.style.cssText = `
            text-decoration: none;
            color: var(--text-secondary, #6b7280);
            font-weight: 500;
            font-size: 0.9rem;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.2s ease;
            background: var(--status-bg, rgba(239, 68, 68, 0.1));
            border: 1px solid var(--card-border, rgba(239, 68, 68, 0.2));
            white-space: nowrap;
        `;

        adminButton.addEventListener('mouseenter', () => {
            adminButton.style.background = 'var(--status-bg, rgba(239, 68, 68, 0.2))';
            adminButton.style.color = '#ef4444';
        });

        adminButton.addEventListener('mouseleave', () => {
            adminButton.style.background = 'var(--status-bg, rgba(239, 68, 68, 0.1))';
            adminButton.style.color = 'var(--text-secondary, #6b7280)';
        });

        return adminButton;
    }

    createModButton() {
        // Show mod button for moderators who are NOT admins (admins have the admin button)
        if (!this.user || !this.user.is_moderator || this.user.is_admin) {
            return null;
        }

        const modButton = document.createElement('a');
        modButton.href = '/mod';
        modButton.id = 'mod-button';
        modButton.textContent = 'Mod Panel';
        modButton.style.cssText = `
            text-decoration: none;
            color: var(--text-secondary, #6b7280);
            font-weight: 500;
            font-size: 0.9rem;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.2s ease;
            background: var(--status-bg, rgba(59, 130, 246, 0.1));
            border: 1px solid var(--card-border, rgba(59, 130, 246, 0.2));
            white-space: nowrap;
        `;

        modButton.addEventListener('mouseenter', () => {
            modButton.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.2))';
            modButton.style.color = '#3b82f6';
        });

        modButton.addEventListener('mouseleave', () => {
            modButton.style.background = 'var(--status-bg, rgba(59, 130, 246, 0.1))';
            modButton.style.color = 'var(--text-secondary, #6b7280)';
        });

        return modButton;
    }

    updateNavigation() {
        const authContainer = document.getElementById('auth-container');
        const adminButton = document.getElementById('admin-button');
        
        if (authContainer) {
            const newAuthContainer = this.createAuthButtons();
            authContainer.parentNode.replaceChild(newAuthContainer, authContainer);
        }

        // Handle admin button
        const newAdminButton = this.createAdminButton();
        if (adminButton && !newAdminButton) {
            // Remove admin button if user is no longer admin
            adminButton.remove();
        } else if (!adminButton && newAdminButton) {
            // Add admin button if user became admin
            const rightSection = document.getElementById('nav-right-section');
            const authContainer = document.getElementById('auth-container');
            rightSection.insertBefore(newAdminButton, authContainer);
        }
    }
}

// Initialize shared components when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.sharedComponents = new SharedComponents();
    
    // Setup mobile responsiveness after a short delay
    setTimeout(() => {
        if (window.sharedComponents) {
            window.sharedComponents.setupMobileNavigation();
        }
    }, 100);
});

// Global function to refresh announcement (can be called from any page)
window.refreshAnnouncement = function() {
    if (window.sharedComponents) {
        window.sharedComponents.loadAnnouncement().then(() => {
            window.sharedComponents.updateAnnouncementBar();
        });
    }
}; 