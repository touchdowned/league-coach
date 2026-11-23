# Design and feedback research notes

What the UI and feedback loops are based on, and what changed because of it.
The learning-science department's full write-up is linked from the PR.

## Rewards stay informational
- Gamification has small to medium positive effects on learning, and they hold up
  best when game elements support the task rather than replace it
  (Sailer & Homner 2020, *Educational Psychology Review*, meta-analysis).
- Rewards that feel controlling can crowd out intrinsic motivation
  (Deci, Koestner & Ryan 1999, meta-analysis; self-determination theory).
- **In the app:** XP and streaks are only earned for practice (reviewing moments,
  finishing a review, puzzles). Never for wins, KDA or games played.
  Per-game letter grades were removed; games show how many moments are left to review.

## Predict, then reveal
- Generating an answer before seeing it improves retention (the generation effect,
  Slamecka & Graf 1978; Bertsch et al. 2007 meta-analysis).
- Video feedback works best when paired with cues that point attention at what matters.
- **In the app:** each review moment opens with "you die here. Why?" and hides the
  explanation for a few seconds (or until R), with the map, gold and killers as cues.

## Spaced retrieval and interleaving
- Retrieval practice spaced over time beats re-study (Roediger & Karpicke 2006;
  Cepeda et al. 2006 meta-analysis). Mixing problem types helps transfer (Rohrer & Taylor 2007).
- **In the app:** a missed puzzle comes back four puzzles later, tagged "Second try".
  Own-game puzzles are interleaved with drills.

## Tilt
- Performance and decision quality drop after losses in competitive games; short breaks help.
- **In the app:** after two losses in a row (within six hours), Coach suggests ten minutes
  off queue and a review or puzzle set.

## Interface (Emil Kowalski's design principles)
- One custom ease-out curve, animations under 300 ms, scale(0.97) on press,
  no scale(0) entrances, one entrance animation per container, prefers-reduced-motion respected.
- One focus at a time on Coach, with the pass rule and a 10-game pass strip.

## Round 2: propose, then attack

Every idea below was pitched, then attacked for being generic, unrealistic, or not
making S better at League. Only the survivors were built.

| Idea | Attack | Verdict |
| --- | --- | --- |
| 3D Summoner's Rift in three.js | No licensed map models; a fake low-poly Rift is less real than League's own replay, which the app already drives. Decoration, not training. | Killed |
| Live Rift map: all ten champions moved through each death from Riot's timeline (positions every minute plus exact kill spots), on the real minimap art | Positions between data points are estimates. Answer: show it honestly (faded and dashed icons when far from a known point). It uses S's real games, so it isn't generic. | **Built** |
| Freeze 4 seconds before each death and make S call it (temporal occlusion) | Is it just a gimmick pause? No: occlusion training has a large effect on anticipation in sport (Muller & Morris-Binelli 2024 meta-analysis, *Sports Medicine*). | **Built** |
| "Where's the jungler?" inside gank deaths: the enemy jungler is hidden; S clicks where they are, and the reveal shows the real spot and the distance | Directly trains the skill behind S's top leak (ganks). Scored by distance, not by multiple choice, so it can't be guessed. | **Built** |
| Endless jungle tracking drill from every laning minute of S's games (hundreds of questions per sync) | Only useful if the last-seen info matches the in-game reality. The question shows where the jungler was a minute earlier, about what a good minimap habit gives. | **Built** |
| Death-risk meter from positions (like Dota 2 death prediction, Katona et al. 2019, arXiv:1906.03939) | Needs high-frequency positions; Riot gives one per minute, so it would be noise dressed up as AI. | Killed for now |
| Eye-tracking minimap trainer | Experts do look at the minimap more (Sci. Reports 2025 meta-analysis), but S has no eye tracker. | Killed |
| League-style gold HUD skin | Cosplay. Doesn't change a single decision. | Killed |
