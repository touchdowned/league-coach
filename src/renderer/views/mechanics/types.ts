import type { Drill, Staircase } from "../../../core/mechanics/plan";

/** What a drill reports when its set ends. */
export interface SetSummary {
  drill: Drill;
  score: number; // 0-1
  detail: number;
  stair: Staircase;
  lines: string[];
}
