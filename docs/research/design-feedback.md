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
