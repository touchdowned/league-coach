import { LANE, type LaneShot } from "../../../core/mechanics/lane";
import { dist, timeToReach } from "../../../core/mechanics/sim";

export { LANE };

/** Seconds from cast until an area spell lands. */
export const timeToReachShot = (s: LaneShot) => timeToReach(s.ability, dist(s.origin, s.target));
