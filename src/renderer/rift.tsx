import { useEffect, useRef, useState } from "react";
import { describeSpot, dist, positionAt, RIFT, Track } from "../core/track";
import { MapBackdrop, useDdragonVersion } from "./charts";

const MINIMAP = [
  "https://raw.communitydragon.org/latest/game/assets/maps/info/map11/2dlevelminimap.png",
  "https://ddragon.leagueoflegends.com/cdn/6.8.1/img/map/map11.png",
];

export const toView = (p: { x: number; y: number }, size: number) => [
  ((p.x - RIFT.minX) / (RIFT.maxX - RIFT.minX)) * size,
  (1 - (p.y - RIFT.minY) / (RIFT.maxY - RIFT.minY)) * size,
];
export const fromView = (vx: number, vy: number, size: number) => ({
  x: RIFT.minX + (vx / size) * (RIFT.maxX - RIFT.minX),
  y: RIFT.minY + (1 - vy / size) * (RIFT.maxY - RIFT.minY),
});

export interface RiftProps {
  track: Track;
  teamId: number;
  meId?: number;
  t: number;
  size?: number;
  /** Players kept in the fog (not drawn). */
  hidden?: number[];
  /** Ghost markers, e.g. "last seen" spots. */
  ghosts?: { x: number; y: number; champion: string; label: string }[];
  guess?: { x: number; y: number } | null;
  answer?: { x: number; y: number; champion: string } | null;
  onPick?: (p: { x: number; y: number }) => void;
  highlight?: { x: number; y: number } | null;
  /** Minions read from the replay's minimap. */
  minions?: { x: number; y: number; team: number }[];
  /** Extra SVG drawn on top (arrows, rings), given the map size. */
  overlay?: (size: number) => React.ReactNode;
}

/** Summoner's Rift with every champion where Riot's data puts them at time t. */
export function Rift({ track, teamId, meId, t, size = 520, hidden = [], ghosts = [], guess, answer, onPick, highlight, minions = [], overlay }: RiftProps) {
  const v = useDdragonVersion();
  const [src, setSrc] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const [broken, setBroken] = useState<string[]>([]);
  const url = (c: string) => `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${c}.png`;
  // Champion portrait clipped to a circle, or initials on a disc if the image can't load.
  const face = (c: string, x: number, y: number, rr: number, grey = false) =>
    v && !broken.includes(c) ? (
      <image href={url(c)} x={x - rr} y={y - rr} width={rr * 2} height={rr * 2} clipPath="url(#rift-clip-c)" filter={grey ? "url(#rift-grey)" : undefined} onError={() => setBroken((b) => [...b, c])} />
    ) : (
      <g className="rift-initials">
        <circle cx={x} cy={y} r={rr} />
        <text x={x} y={y + rr * 0.35}>{c.slice(0, 2)}</text>
      </g>
    );
  const r = size * 0.04;

  const recentKills = track.kills.filter((k) => k.t <= t && t - k.t < 6000);
  const recentObj = track.objectives.filter((o) => o.t <= t && t - o.t < 12000);

  function pick(e: React.MouseEvent<SVGSVGElement>) {
    if (!onPick || !svgRef.current) return;
    const b = svgRef.current.getBoundingClientRect();
    onPick(fromView(((e.clientX - b.left) / b.width) * size, ((e.clientY - b.top) / b.height) * size, size));
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${size} ${size}`} className={`rift-map ${onPick ? "picking" : ""}`} onClick={pick}>
      <defs>
        <clipPath id="rift-clip-c" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
        <filter id="rift-grey">
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <radialGradient id="rift-vignette" cx="50%" cy="50%" r="72%">
          <stop offset="70%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      {src < MINIMAP.length ? (
        <image href={MINIMAP[src]} width={size} height={size} preserveAspectRatio="none" onError={() => setSrc((s) => s + 1)} className="rift-art" />
      ) : (
        <MapBackdrop size={size} />
      )}
      <rect width={size} height={size} fill="url(#rift-vignette)" pointerEvents="none" />

      {minions.map((mn, i) => {
        const [x, y] = toView(mn, size);
        return <rect key={`m${i}`} className={`rift-minion ${mn.team === teamId ? "ally" : "enemy"}`} x={x - size * 0.005} y={y - size * 0.005} width={size * 0.01} height={size * 0.01} />;
      })}

      {recentObj.map((o, i) => {
        const [x, y] = toView(o, size);
        return (
          <g key={i} className={`rift-obj ${o.teamId === teamId ? "ally" : "enemy"}`}>
            <circle cx={x} cy={y} r={r * 1.5} />
            <text x={x} y={y - r * 2}>{o.label}</text>
          </g>
        );
      })}

      {recentKills.map((k, i) => {
        const [x, y] = toView(k, size);
        const age = (t - k.t) / 6000;
        const mine = k.victim === meId;
        return <circle key={i} cx={x} cy={y} r={r * (1.2 + age * 2.2)} className={`rift-burst ${mine ? "mine" : ""}`} style={{ opacity: 1 - age }} />;
      })}

      {highlight && (() => {
        const [x, y] = toView(highlight, size);
        return <circle cx={x} cy={y} r={r * 2.2} className="rift-highlight" />;
      })()}

      {ghosts.map((g, i) => {
        const [x, y] = toView(g, size);
        return (
          <g key={`g${i}`} className="rift-ghost">
            {face(g.champion, x, y, r, true)}
            <circle cx={x} cy={y} r={r} className="ring" />
            <text x={x} y={y + r * 2.1}>{g.label}</text>
          </g>
        );
      })}

      {track.players
        .filter((p) => !hidden.includes(p.id))
        .map((p) => {
          const at = positionAt(track, p.id, t);
          if (!at) return null;
          const [x, y] = toView(at, size);
          const side = p.id === meId ? "me" : p.teamId === teamId ? "ally" : "enemy";
          return (
            <g key={p.id} className={`rift-champ ${side} ${at.dead ? "dead" : ""} ${at.certainty < 0.5 ? "unsure" : ""}`} style={{ opacity: at.dead ? 0.45 : 0.45 + 0.55 * at.certainty }}>
              {face(p.champion, x, y, r, at.dead)}
              <circle cx={x} cy={y} r={r} className="ring" />
              {at.dead && <path d={`M${x - r * 0.6},${y - r * 0.6}L${x + r * 0.6},${y + r * 0.6}M${x + r * 0.6},${y - r * 0.6}L${x - r * 0.6},${y + r * 0.6}`} className="x" />}
            </g>
          );
        })}

      {overlay?.(size)}

      {guess && (() => {
        const [x, y] = toView(guess, size);
        return (
          <g className="rift-guess">
            {answer && (() => {
              const [ax, ay] = toView(answer, size);
              return <line x1={x} y1={y} x2={ax} y2={ay} />;
            })()}
            <circle cx={x} cy={y} r={r * 0.9} />
            <circle cx={x} cy={y} r={r * 0.25} className="dot" />
          </g>
        );
      })()}

      {answer && (() => {
        const [x, y] = toView(answer, size);
        return (
          <g className="rift-champ enemy answer">
            <circle cx={x} cy={y} r={r * 1.9} className="pulse" />
            {face(answer.champion, x, y, r * 1.2)}
            <circle cx={x} cy={y} r={r * 1.2} className="ring" />
          </g>
        );
      })()}
    </svg>
  );
}

/** Animated game clock: runs t from `from` to `to` at `speed`x while `playing`, then calls onEnd. */
export function useGameClock(from: number, to: number, speed: number, playing: boolean, onEnd?: () => void) {
  const [t, setT] = useState(from);
  const tRef = useRef(from);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    tRef.current = from;
    setT(from);
  }, [from]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(to, tRef.current + (now - last) * speed);
      last = now;
      tRef.current = next;
      setT(next);
      if (next >= to) return endRef.current?.();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, speed, playing, from]);
  return t;
}

export { describeSpot, dist };
