## [Release 26/02/2026]

### Added
- **New Unbox Animation** - Completely redesigned unbox overlay with crate opening animation, glassmorphism item cards, diamond pointer, vignette edges, and smooth transitions
- **Unboxer Avatar on Crate** - The crate now shows the unboxer's 7TV avatar (falls back to Twitch profile pic, then placeholder)
- **Tick Sound System** - Scroll ticks with velocity-based playback rate for a satisfying CS:GO-style roll feel
- **Tier Celebrations** - Screen flash and glow pulse effects for Classified, Covert, and Gold unboxes
- **Winner Reveal Animation** - Pop and glow animation when the winning skin is revealed
- **New Unbox Sounds** - Dedicated tick, start, and per-tier reveal sounds
### Changed
- Unbox overlay now uses Chakra Petch and Rajdhani fonts
- Unbox roll duration increased to 8 seconds with more filler items (40 before, 5 after)
- Sound volume now syncs with the admin panel volume setting (live updates via socket)
- Item cards now display cone names below the image

---

## [Release 09/02/2026]

### Added
- **Buy Cone Reward** - Use the Buy Cone channel point redeem to purchase a specific cone skin! Supports fuzzy matching so typos and partial names work. If no match is found, you'll get a link to browse all available cones

### Changed
- **Tier Rework** - Gold tier is now exclusively for trail unboxes. Updated tier odds: 56.5% Mil-Spec, 27.5% Restricted, 10.5% Classified, 3.5% Covert, 2% Gold (trails)
- Unbox animation is now 2 seconds longer
- Unbox chat message is delayed by 3 additional seconds

### Fixed
- Fixed cone submissions showing "submitted by undefined"
- Fixed uploads/submissions directory not being created automatically
- Fixed skins page caching preventing new skins from appearing
- Fixed Buy Cone allowing purchase of non-unboxable skins (gold, default, special)
- Fixed Buy Cone allowing infinite purchases from a single redeem

---

## [Release 01/02/2026]

### Added
- **Skin Shuffle** - Enable shuffle to randomly pick a skin from your inventory each time you cone flip or duel. Toggle it with `!coneshuffle` in chat or from the toggle on your profile page

---

## [Release 29/01/2026]

### Added
- **Trail Unbox** - You can now unbox a random trail from the cone unbox! Trails are Gold tier (2.4% chance) and give you a trail you don't already own
- **Free coneflip on follow** - New followers automatically receive a free coneflip

### Changed
- Redesigned duel winner popup with a cinematic split-wipe bar animation
- Duel cones now stay visible for 1 second after the winner is determined before despawning

### Removed
- Removed !drippycat command

---

## [Release 06/01/2026]

### Added - XP & Level System
Players now earn XP and level up by playing the game!

#### How XP Works
| Action | XP Earned |
|--------|-----------|
| Coneflip Win | +70 XP |
| Coneflip Loss | +20 XP |
| Duel Win | +70 XP |
| Duel Loss | +20 XP |
| 3+ Win Streak Bonus | +70 XP |
| 5+ Win Streak Bonus | +100 XP |
| Unbox (by tier) | +50-500 XP |

#### Unbox XP by Tier
| Tier | XP |
|------|-----|
| Mil-Spec (Blue) | +50 XP |
| Restricted (Purple) | +150 XP |
| Classified (Pink) | +300 XP |
| Covert (Red) | +500 XP |
| Gold | +500 XP |

#### Level Progression
Each level requires slightly more XP (formula: 100 + level^1.6):
- Level 2: 101 XP
- Level 5: 418 XP
- Level 10: 1,030 XP
- Level 20: 2,761 XP
- Level 30: 5,436 XP

#### Features
- XP popup appears near your cone when you earn XP
- Level displayed on your profile with a progress bar
- Leaderboard can be sorted by Level (toggle on public leaderboard)
- Chat announcement when you reach a new Cone Level

### Fixed - Stuck Cone Cleanup
- Cones that remain idle for more than 15 seconds are now automatically removed when there are more than 10 cones on the field
- This prevents buildup of stuck or abandoned cones during busy sessions

---

## [Release 29/07/2025]

### Added
- Dynamic OG images for profiles


### Fixed
- 7TV Not loading
- Chat message not showing score
- General fixes

## [Release 25/07/2025]

### BIG UPDATE 

#### New point system
- In order to balance the duels I introduced a point system rather then relying on wins / losses.
- !All player stats have been reset. (You keep your skins tho.)

<br>
Heres how the points work:


| Type  | Points |
| ------------- |:-------------:|
| Regular Win   | +1   |
|  Regular Loss     | +0     |
| Duel Win      | +1   |
| Duel Loss     | -1   |
| Regular Upside down Win      | +5   |
| Duel Upside down Win      | +10   |
| Duel Upside down Loss      | -10   |

#### New Streak system

- Individuel winstreak tracking
- Global highest winstreak tracking
<br>

![screenshot](https://i.imgur.com/vXDqlOF.png)

<br>

#### Trails
<br>

![screenshot](https://i.imgur.com/72f3EPS.gif)
<br>
- Buy a trail using the point redeem simply enter the trail name to buy!
- Either set the trail in your inventory or use !settrail <name>
- Check out all trails here [Click here](/trails).
- If you want to make a custom trail you can find and example [here](/trails/xporb.json).

## [Release 24/07/2025]

### Changed
- Several UI and visual imrpovements

### Added
- Hamburger menu on mobile
- Twitch OAuth integration (YOU CAN NOW VOTE AND SELECT A SKIN VIA YOUR PROFILE!)

## [Release 21/07/2025]

### Added
- Changelog system with dedicated public page
- Duel chat announcements

### Fixed
- Usernames being inconsistent
- Skins sometimes not loading
- Cache busting
- Winrates being longer then 2 decimals in profiles
- Aistyra gold cone
- Jellybean cone 