# league-coach

teaches me league

A personal, post-game League of Legends coach for Windows. It loads your recent games from the Riot API, finds the moments that cost you (ganks, overextending, shutdowns, dying with unspent gold, deaths that gave up dragon or baron), grades each game, gives you one focus for the next game, and compares your roles to tell you where you climb best.

Everything runs after the game. The app never reads game memory or draws over a live game, so it stays within Riot's third-party rules and Vanguard.

## Run it

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

For development with hot reload: `npm run dev`. Tests: `npm test`.

## How it works

- `src/core/riot.ts`: Riot API client (account-v1, match-v5, timeline) with rate limiting, 429 retry and a disk cache, so each game is only downloaded once.
- `src/core/analysis.ts`: per-game metrics (CS@10/15, gold and XP diff vs your lane opponent, deaths before 14, kill participation, vision) and mistake detection from timeline events.
- `src/core/roles.ts`: compares your roles against rough Silver/Gold benchmarks (`src/core/benchmarks.ts`) and recommends one. About 15 games per role gives a reliable answer.
- `src/main`: Electron main process and IPC. `src/renderer`: React UI.

## Roadmap

- **Phase 2:** League Replay API. Click a mistake and the replay jumps there with the camera on you; auto-record clips of each death.
- **Phase 3:** load downloaded match VODs (mp4), sync them to the match timeline and track the minimap for positioning feedback.
- AI-written coaching summaries per game.
