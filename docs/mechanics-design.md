# Mechanics trainer v2: features, argued for and against

v1 was a flat top-down arena where you stood still and threw spells at a circle that walked
around at random. S's verdict: unrealistic, generic, not immersive. For v2, every feature was
first proposed, then argued against, and kept only if it survived. The rule for a feature
was simple: **does practising it change what your hands do in a real lane?** If not, it was cut.

## Evidence used

- **Timing beats movement.** Warburton et al. 2023 (PNAS Nexus, *Kinematic markers of skill in FPS games*)
  found aim skill tracked temporal measures (acquire time r=0.99, correction time r=0.76, reaction
  r=0.63) far more than movement speed (r=-0.30). The biggest gains came in the first five rounds.
- **Experts read their opponents.** Park et al. 2021 (CHI, *Secrets of Gosu*) found pros differed in
  reaction time (460 vs 504 ms), in fixation on hidden enemies, and in movement-and-ability
  combos. Stutter-step frequency did not differ.
- **Habits players use in lane** (Dignitas coaching articles, 2021 and 2025):
  - Cast when the target is locked in an auto-attack animation.
  - Aim where the opponent habitually dodges, not where they stand.
  - Lanes and minions remove dodge options.
  - On League's tilted camera, aim at the head going left-to-right and at the feet going right-to-left.
- **What existing trainers offer.** loldodgegame and MOBA Warmup run real abilities in modes that mix
  aiming and dodging, and seed drills from your own games. Their weakness is the same as v1:
  abstract arenas.
- **How to schedule practice** (unchanged from v1): adaptive difficulty around 70% success
  (challenge point), random and interleaved practice, and feedback only on clear misses.

## Kept

| # | Proposal | Critique | Verdict |
|---|---|---|---|
| 1 | **3D lane in three.js with League's tilted, perspective camera** | Is 3D just eye candy? No. The camera tilt is why skillshots aimed up the screen behave differently from those aimed down it, and why the "aim at the head or the feet" rule exists. A flat view trains the wrong aim offsets. | Keep. The camera follows your champion with a fixed tilt. The exact angle is not published, so it is approximated and the zoom can be adjusted. |
| 2 | **Right-click to move, with the green move marker and quick cast at the cursor's ground point** | Without this, nothing about trading in lane transfers. In lane, aiming always happens while moving. | Keep. Cast times stop your champion, which then resumes its last move order, as in the game. |
| 3 | **Minion waves that fight, die and block skillshots** | Is it overkill? No. Most real misses are minion blocks, or chances that only open when the wave thins. Aiming at an open target is the easy case. | Keep. Each ability carries a `blockedByMinions` flag (Morgana Q blocks, Ahri Q passes through). |
| 4 | **Enemy bot that plays like a laner**: last-hits dying minions, holds trading range, never fully stands still (spam-clicking), side-steps your cast after a human reaction time (~250 ms at mid levels), can't dodge during its auto-attack wind-up, has a favourite dodge side, sometimes Flashes | This is the core of the trainer. A random walker is the biggest reason v1 felt fake, and every one of these behaviours is something you learn to exploit in real lanes. | Keep. Difficulty scales reaction time, dodge chance and how predictable its habits are. |
| 5 | **Shots scored by situation**: target in auto-attack, target farming, target free | Generic accuracy % says nothing. Splitting hits by situation teaches *when* to cast, which the research says matters most. | Keep. The set summary shows hit rate per situation. |
| 6 | **Dodge and Trade modes in the same lane**: the enemy is one of your real lane opponents casting its real skillshots at you, aiming at where you're walking | A separate abstract dodge arena (v1) fails for the same reasons as the aim one. | Keep. Trade = both directions at once, which is what laning is. |
| 7 | **Health bars, damage numbers, hit flashes and synthesized sounds** | Juice for its own sake is slop. But hearing and seeing that a hit landed is the knowledge of results the learning relies on, and S asked for immersion. | Keep, but minimal. No particle spam. |
| 8 | **Real hitboxes**: a selection ring at each champion's feet, edge-of-hitbox collision | Players aim at the edge of the hitbox, not the model, so showing the ring helps you calibrate. | Keep. |
| 9 | **Quick cast with indicator** (hold the key to see the indicator, release to cast) as a setting | People train with the setting they play with. | Keep as a toggle. |
| 10 | **Miss explanations in the world**: a ghost of where the spell needed to go, plus *why* (they dodged, you cast into a free target, a minion blocked it) | v1 had the ghost line but no reason. The reason is the useful part. | Keep, shown only on clear misses (bandwidth feedback). |

## Cut

| Proposal | Why it was cut |
|---|---|
| Leaderboards / ranked mode | There's only one player, and comparing with yourself is already the trend line. |
| Stroboscopic / reaction-time flash drills | Evidence is for 6 to 10 week programmes with near transfer only. It doesn't train lane decisions. |
| Full Summoner's Rift map, towers, jungle | Costs a lot and doesn't change aim or dodge practice. One lane segment is enough. |
| Riot champion models | Not ours to ship. Champions are original stylised figures with the official champion icon as a nameplate. |
| A stats dashboard of every metric | It wouldn't drive any action. The summary shows the 2 to 3 numbers that change what you do next. |
| Mouse-kinematics capture (overshoot, corrections) | Interesting research but noisy in a click-to-cast game. Revisit if timing metrics plateau. |

## Sources
- Warburton et al., *Kinematic markers of skill in first-person shooter video games*, PNAS Nexus 2023: https://academic.oup.com/pnasnexus/article/2/8/pgad249/7233873
- Park et al., *Secrets of Gosu*, CHI 2021: https://cookingfoil.github.io/paper/park2021secrets.pdf
- Rogers et al., KovaaK's reliability study, Frontiers 2024: https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1309991/full
- Buckley et al., *Rapid Skill Capture in a First-Person Shooter*, arXiv:1411.1316
- Dignitas, *Improving the effectiveness of your skillshots*, *Landing skill shots*, *loldodgegame guide*
- Riot, *Background on our camera decisions for the updated Summoner's Rift* (2014)
