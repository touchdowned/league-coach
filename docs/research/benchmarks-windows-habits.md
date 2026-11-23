# Benchmarks, recall windows, habits

## 1. Compare to Master+ players

- Proposal: read high-elo replays of your champion and matchup, show what they did at the same minute and wave state.
- Attack: since patch 26.20 third-party apps can't download replays of games you weren't in, so their wave state is out of reach. Same matchup is too rare to find through the API without thousands of calls.
- Survives as: Master+ timelines (still served by the API). Riot's ladder → random Challenger/GM/Master players → their ranked games → the two laners in your role per game, reduced to a few numbers (CS at 10/15, first recall time and gold, recalls and deaths before 14, plates, minute-by-minute CS/recalls/gold spent). A few games are added after each sync so it never burns the API key. Champion-specific once 5+ games of your champion are found, role-wide before that, and it says which.
- Shown: a "You vs Master+" table on Coach, and on each laning moment in review: "At 8:00, Master+ Darius had 64 CS, 1 recall, 3,400g spent. You: 54 CS, 0 recalls, 2,638g."
- Attack 2: "Recalls before 14" and "gold on first recall" aren't better when higher. Shown without good/bad colour.

## 2. Recall-window finder

- Proposal: mark every moment your wave was crashing into their tower and you had item gold; count the ones you passed.
- Attack: without the replay read, "crashing" is a guess. So it only runs on replay-read games and says nothing otherwise.
- Definition: wave front under their tower, 3+ of your minions there, 1,100g+ in pocket, you alive. A window is "taken" if you start a recall within 25s.
- Shown: "Recall windows 1 of 4" on each read game, and on a bad recall: "You passed 2 recall windows before this: 6:12 with 1,240g, 7:05 with 1,410g."

## 7. The same mistake across games

- Proposal: link repeats like "3 of your last 5 deaths facechecking river after 15 minutes".
- Attack: grouping by leak type alone ("you die a lot") is the generic advice S rejected. Grouping too narrowly finds nothing.
- Survives as: every leak carries why (cause from the engine's read: ganked, collapsed on, chasing, lost 1v1, sat on gold, recalled into their wave...), where (river side, lane, whose jungle) and when (laning / mid / late). Habits are the most specific group with 3+ cases in 2+ of the last 10 games, ranked by gold per game, and death habits say how often the killer had shown on your minimap first.
