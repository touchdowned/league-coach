# Mechanics trainers

The Mechanics view ("Lane lab") trains landing skillshots, dodging your lane opponents'
skillshots, trading (both at once) and combos, on your own champions in a three.js lane.
See `mechanics-design.md` for how each feature was argued for and against.

## Where the data comes from

- **Your champions**: your most-played mid and top champions from synced games
  (`trainingPool`), and the lane opponents you met most on each for the dodge drill.
- **Spell names, icons, cooldowns, ranges, move speed**: Riot Data Dragon, fetched per patch and cached.
- **Missile speeds and cast ranges**: Community Dragon `{champion}.bin.json` when it loads, accepted only within sane bounds.
- **Spell shapes, widths and cast times**: the curated table in `src/core/mechanics/kits.ts` for ~75 common
  mid and top champions. Others get shapes guessed from their Data Dragon text.

## Why the drills work the way they do

| Practice principle | What the trainer does |
| --- | --- |
| Challenge point framework (Guadagnoli & Lee, 2004): learning is best at a moderate success rate | 2-down/1-up staircase per drill and champion, converging near 70% success |
| Contextual interference / random practice (meta-analyses 2024, retention and transfer) | Target paths, distances, casters and combos are randomised and interleaved, never the same twice in a row |
| Bandwidth and summary feedback | A miss only gets a correction (ghost line to the right aim point, one-line cue) when it was well outside the hit window. Each set ends with a summary |
| External focus of attention (Wulf) | Cues name outcomes ("aim ahead of where they're walking", "step sideways to the line") rather than hand movements |
| Spacing | Sets of 12 to 20 trials; three a day as a warm-up |

Sources:
- [High contextual interference improves retention in motor learning: systematic review and meta-analysis (2024)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11237090/)
- [The effect of contextual interference on transfer in motor learning (2024)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11349744/)
- [Challenge point framework](https://en.wikipedia.org/wiki/Challenge_point_framework)
- [Increasing speed of processing with action video games](https://pubmed.ncbi.nlm.nih.gov/20485453/)
