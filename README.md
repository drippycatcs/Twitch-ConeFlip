# ConeFlip

A Twitch-integrated cone flipping game with channel points, skins, duels, leaderboards, and more.

## Features

- **Cone Flip** - Viewers flip cones using channel point redemptions
- **Duels** - Challenge other viewers to cone flip duels
- **Skin System** - Unbox and collect cone skins with rarity tiers
- **Leaderboard** - Track wins, losses, and winrates
- **Trail System** - Customizable particle trails for cones
- **XP & Levels** - Earn XP from playing and level up
- **OBS Overlay** - Browser source overlay for stream display
- **Admin Panel** - Manage skins, rewards, and game settings
- **Twitch Auth** - Login with Twitch for profile and inventory management

## Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- A Twitch account (Affiliate or Partner for channel point rewards)
- A [Twitch Developer Application](https://dev.twitch.tv/console/apps)

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd coneflip
npm install
```

### 2. Start the server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

The server will start at `http://localhost:3000` by default.

### 3. Configure via Admin Panel

Navigate to `/admin` to set up your Twitch credentials and game settings through the admin panel. You'll need to log in with your Twitch account (the channel owner is automatically assigned as admin).

## OBS Setup

Add a **Browser Source** in OBS with the URL:

```
http://localhost:3000/?token=YOUR_TOKEN
```

The main overlay (`/`) is protected by a token to prevent unauthorized access. You can generate a token from the admin panel under the token settings. The token ensures only your OBS instance can display the game overlay — without a valid token, the page won't load.

Set the browser source width/height to match your stream resolution (e.g. 1920x1080) and make sure "Shutdown source when not visible" is **unchecked** so the game stays connected.

## Pages

| Route | Description |
|-------|-------------|
| `/?token=XXX` | Main game overlay (OBS browser source, token required) |
| `/admin` | Admin panel (Twitch login required, owner only) |
| `/mod` | Moderator panel (Twitch login required) |
| `/leaderboard` | Leaderboard (internal) |
| `/leaderboard-public` | Public leaderboard with shareable link |
| `/u/:name` | Public player profile (e.g. `/u/duduck`) |
| `/skins` | Browse all available skins |
| `/trails` | Browse all available trails |
| `/commands` | Chat commands reference |
| `/unbox` | Unboxing animation page |
| `/contest` | Community contests |
| `/changelog` | Version changelog |
| `/skins/submissions` | Community skin submissions |
| `/health` | Server health check endpoint |

## Project Structure

```
├── src/
│   ├── server.js              # Express server entry point
│   ├── config/
│   │   └── environment.js     # Environment configuration
│   ├── middleware/
│   │   ├── errorHandler.js    # Error handling middleware
│   │   ├── tokenAuth.js       # Token authentication
│   │   └── validation.js      # Request validation
│   ├── routes/
│   │   ├── authRoutes.js      # Twitch OAuth routes
│   │   ├── gameRoutes.js      # Game API routes
│   │   ├── leaderboardRoutes.js
│   │   ├── skinsRoutes.js     # Skin management routes
│   │   ├── trailRoutes.js     # Trail management routes
│   │   ├── publicRoutes.js    # Public API routes
│   │   ├── setupRoutes.js     # Initial setup routes
│   │   ├── contestRoutes.js   # Contest routes
│   │   └── debugRoutes.js     # Debug/admin routes
│   ├── services/
│   │   ├── databaseService.js # SQLite database layer
│   │   ├── gameService.js     # Game logic
│   │   ├── skinService.js     # Skin management
│   │   ├── trailService.js    # Trail management
│   │   ├── leaderboardService.js
│   │   ├── twitchService.js   # Twitch API integration
│   │   ├── authService.js     # Authentication logic
│   │   ├── configService.js   # Runtime configuration
│   │   ├── tokenService.js    # OBS token management
│   │   ├── xpService.js       # XP & leveling system
│   │   ├── communityService.js # Community directory ping
│   │   └── submissionService.js # Skin submissions
│   ├── utils/
│   │   └── logger.js          # Logging utility
│   └── websocket/
│       └── socketHandler.js   # Socket.IO real-time events
├── public/                    # Static frontend files
│   ├── skins/                 # Cone skin images & config
│   └── trails/                # Trail configs & assets
├── data/                      # Runtime data (gitignored)
├── nodemon.json               # Dev auto-reload config
└── package.json
```

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Install dependencies** and start the dev server:
   ```bash
   npm install
   npm run dev
   ```
5. **Make your changes** — try to keep PRs focused on a single feature or fix
6. **Test** your changes locally to make sure nothing breaks
7. **Commit** with a clear message describing what you changed
8. **Push** to your fork and open a **Pull Request**

### Guidelines

- Follow the existing code style and patterns
- Keep changes minimal and focused
- Don't include unrelated changes in your PR
- If adding a new skin or trail, follow the existing format in `public/skins/config.json` and `public/trails/`
- For new features, consider if it needs an admin panel toggle

### Reporting Issues

Found a bug or have a feature idea? Open an issue on GitHub with:
- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Your Node.js version and OS

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
