-- Migration: Add XP and Level columns to leaderboard
-- Run this on production database before deploying the XP feature
-- Level scaling: f(x) = 100 + x^1.6 (polynomial growth)

-- Add the new columns for XP and Level (skip if already exist)
ALTER TABLE leaderboard ADD COLUMN xp INTEGER DEFAULT 0;
ALTER TABLE leaderboard ADD COLUMN level INTEGER DEFAULT 1;

-- Calculate XP based on existing game stats
UPDATE leaderboard SET xp =
    (COALESCE(coneflip_wins, 0) * 70) +
    (COALESCE(coneflip_losses, 0) * 20) +
    (COALESCE(duel_wins, 0) * 70) +
    (COALESCE(duel_losses, 0) * 20);

-- Calculate levels based on XP (formula: 100 + level^1.6)
UPDATE leaderboard SET level = CASE
    WHEN xp >= 9794 THEN 41
    WHEN xp >= 9329 THEN 40
    WHEN xp >= 8878 THEN 39
    WHEN xp >= 8441 THEN 38
    WHEN xp >= 8019 THEN 37
    WHEN xp >= 7610 THEN 36
    WHEN xp >= 7215 THEN 35
    WHEN xp >= 6833 THEN 34
    WHEN xp >= 6465 THEN 33
    WHEN xp >= 6109 THEN 32
    WHEN xp >= 5766 THEN 31
    WHEN xp >= 5436 THEN 30
    WHEN xp >= 5118 THEN 29
    WHEN xp >= 4812 THEN 28
    WHEN xp >= 4517 THEN 27
    WHEN xp >= 4234 THEN 26
    WHEN xp >= 3962 THEN 25
    WHEN xp >= 3701 THEN 24
    WHEN xp >= 3451 THEN 23
    WHEN xp >= 3211 THEN 22
    WHEN xp >= 2981 THEN 21
    WHEN xp >= 2761 THEN 20
    WHEN xp >= 2550 THEN 19
    WHEN xp >= 2349 THEN 18
    WHEN xp >= 2156 THEN 17
    WHEN xp >= 1972 THEN 16
    WHEN xp >= 1796 THEN 15
    WHEN xp >= 1628 THEN 14
    WHEN xp >= 1468 THEN 13
    WHEN xp >= 1315 THEN 12
    WHEN xp >= 1169 THEN 11
    WHEN xp >= 1030 THEN 10
    WHEN xp >= 897 THEN 9
    WHEN xp >= 770 THEN 8
    WHEN xp >= 648 THEN 7
    WHEN xp >= 531 THEN 6
    WHEN xp >= 418 THEN 5
    WHEN xp >= 309 THEN 4
    WHEN xp >= 204 THEN 3
    WHEN xp >= 101 THEN 2
    ELSE 1
END;
