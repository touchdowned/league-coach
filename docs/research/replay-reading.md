# Reading the actual replay

S's ask: read the replay itself after the game, not only Riot's match data, so wave
state and movement are read from what happened instead of guessed.

## Options, and the attack on each

| Option | What it would give | Attack | Verdict |
|---|---|---|---|
| A. Decode the `.rofl` file | Every packet: exact positions, minions, spells | Packets are encrypted, and the encryption, field layout and packet ids change **every patch**. The one public pipeline (maknee, 2025) runs the game client's own code in an emulator to decrypt them, and says it breaks on packet changes. It would break every two weeks, and patch 26.20 (Oct 2026) moved Riot to "official APIs only" for third-party game data. | **Cut.** Not maintainable and out of bounds. |
| B. Read the replay client's memory | Exact positions | Riot blocked third-party memory access in 26.20. Ban risk. | **Cut.** |
| C. Live Client Data API (port 2999) | Items, scores, events | No positions, no minions. Adds nothing the timeline lacks. | **Cut.** |
| D. Play the replay and read the minimap off the screen | Every minion and champion dot, sampled every 1–2 game seconds | It takes over the screen for a few minutes per game. Pixel reading needs calibration per resolution and minimap size. | **Ship.** It uses only the official Replay API (seek, speed, fog off) and pixels on S's own screen, the same thing a recording does. |

## How D works

1. Open the replay through the League client (already built), wait for the Replay API.
2. Pause, turn fog of war off, then capture the screen with the minimap on and with it off. The pixels that change are the minimap, so it's found on any resolution or minimap size.
3. Take a few frames before minions spawn (0:15–1:04) and keep the per-pixel median. That's the empty map.
4. Play at high speed. Each capture: crop the minimap, subtract the empty map, keep small saturated blue and red blobs (minions; champion icons are much bigger), map pixels to game units, stamp with the replay's own clock.
5. Snap each minion to its lane and store, per lane, where each team's minions are.
6. The engine asks "where was the wave and who had more minions at 8:08 in top" instead of guessing from CS.

## What the wave data changes in the advice

- **Recalls:** "When you backed at 8:08, 7 of Garen's minions were walking into your tower against 1 of yours. At 7:41 your wave was crashing into his tower: backing then cost nothing."
- **Deaths in lane:** "You fought with 1 minion against his 6": minion advantage, read rather than guessed.
- **Farm gaps:** whether the wave sat frozen at their tower (you couldn't reach it) or under yours (you were last-hitting under tower).

## Honest limits

- Needs the replay to play on screen for roughly 2–4 minutes per game. Don't touch the game window while it reads.
- Colors and sizes are tuned on synthetic frames until it runs on a real replay; the first real run is the calibration.
- Replays only exist for the current patch, so old games can't be read.
- Never runs during a live game: it refuses if League says a game is in progress.
