# league-coach

teaches me league

A personal, post-game League of Legends coach for Windows. It doesn't ask you to set goals: it reads your recent games, decides which single problem is costing you the most, tells you exactly what to do about it, and moves you to the next problem once your games show it's fixed. It's blunt on purpose.

- **Coach**: your next step with evidence from your games, in-game rules and a pass/fail check per game; the full plan (now / next / fixed); a skill profile (farming, laning, survival, fighting, vision) scored against Silver/Gold; trends.
- **Guided review**: press play and it walks through every mistake in a game (what happened, what you were probably thinking, why that was wrong), then rolls into the next unreviewed game. It downloads and opens the game's replay through the League client, jumps the replay to each moment, and can record each moment as a clip that plays inside the app. Linked mp4 recordings (OBS, Outplayed) play inline too.
- **Feedback loop**: XP and levels, a daily streak, daily targets (3 moments, 10 puzzles), level-up and toast feedback.
- **Puzzles**: endless decision puzzles. First the moments right before your own deaths, then generated drills.
- **Mind** (mental game): in champ select a small card shows your record on the champion and matchup, whether you should be queueing at all (stop-loss after losing streaks, tilted last game), and asks you to lock one skill goal and one mental goal. In game a click-through overlay tracks both live, keeps a focus score, shows one-line reminders when they matter (objective about to spawn, gold piling up, CS pace, shutdown on your head), and while you're dead shows what killed you, the fix, a breathing cue and a 1-5 focus check-in (Ctrl+Shift+1-5). When the game ends a two-minute debrief asks about your mood, then adaptive questions built from what happened (a death chain, a missed goal, what set you off) and turns the answers into rules for the next game. The Mind tab tracks goal record, focus over games, a tilt profile from your match history (win rate by game number in a session, after losses, by time of day, with and without death chains) and mood vs results.
- **Champions**: your pool with win rate, gold lead and matchups, and a keep/drop verdict for each.
- **Best role**: compares your roles and recommends one.

The live overlay reads only League's own read-only Live Client Data API (`https://127.0.0.1:2999/liveclientdata`), which reports what you can already see on your screen, and draws only your own goals and stats. The app never reads game memory or sends input to the game. The overlay needs League in Borderless or Windowed mode, can be hidden with Ctrl+Shift+H and turned off in Settings. Everything else runs after the game.

## Install

Download `League-Coach-Setup-<version>.exe` from the [latest release](https://github.com/touchdowned/league-coach/releases/latest) and run it. It installs for your Windows user (no admin), adds Start menu and desktop shortcuts, and opens the app. Pin it to the taskbar from there.

The app updates itself: every push to `phase-1-match-review` or `main` builds a new installer in GitHub Actions and publishes it as a release. The app checks hourly, downloads the update in the background and installs it when you close the app (or click the "update ready" notification). Your settings, API key and synced games are kept in `%APPDATA%\league-coach`, which updates don't touch.

Windows SmartScreen may warn the first time because the installer isn't code-signed: choose **More info → Run anyway**.

## Run from source

1. Install [Node.js 22 LTS](https://nodejs.org) and [Git](https://git-scm.com).
2. In a terminal:
   ```
   git clone https://github.com/touchdowned/league-coach
   cd league-coach
   npm install
   npm start
   ```
3. In **Settings**, enter your Riot ID (`Name#TAG`), region and a Riot API key from [developer.riotgames.com](https://developer.riotgames.com). Development keys expire every 24 hours. Your key is stored only on your PC (in the app's user data folder), never in this repo.
4. Press **Sync games**.

### Replays

Replay control uses League's built-in Replay API. Turn it on once from Settings or the review screen (adds `EnableReplayApi=1` to `Config/game.cfg`, keeping a backup). The League client must be open to download or open a replay; Riot only keeps replays for the current patch.

For development with hot reload: `npm run dev`. Tests: `npm test`.

## How it works

- `src/core/riot.ts`: Riot API client (account-v1, match-v5, timeline) with rate limiting, 429 retry and a disk cache, so each game is only downloaded once.
- `src/core/analysis.ts`: per-game metrics (CS@10/15, gold and XP diff vs your lane opponent, deaths before 14, kill participation, vision) and mistake detection from timeline events.
- `src/core/coach.ts`: picks the current problem to work on and tracks it game by game.
- `src/core/puzzles.ts`: builds puzzles from your deaths, plus endless generated drills.
- `src/core/profile.ts`, `src/core/champions.ts`: skill scores and champion pool stats.
- `src/core/roles.ts`: compares your roles against rough Silver/Gold benchmarks (`src/core/benchmarks.ts`) and recommends one. About 15 games per role gives a reliable answer.
- `src/main`: Electron main process and IPC. `src/renderer`: React UI.

## Roadmap

- **Phase 2:** League Replay API. Click a mistake and the replay jumps there with the camera on you; auto-record clips of each death.
- **Phase 3:** load downloaded match VODs (mp4), sync them to the match timeline and track the minimap for positioning feedback.
- Champion-specific mechanics trainers (combos, skillshot aim and dodging).
- AI-written coaching summaries per game.
