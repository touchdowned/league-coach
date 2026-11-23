import { useEffect, useState } from "react";
import type { MapEvent } from "../core/types";

// ---------- Champion icons (Riot Data Dragon) ----------

let ddVersion: Promise<string> | null = null;
function useDdragonVersion() {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    ddVersion ??= fetch("https://ddragon.leagueoflegends.com/api/versions.json")
      .then((r) => r.json())
      .then((list: string[]) => list[0])
      .catch(() => "15.1.1");
    ddVersion.then(setV);
  }, []);
  return v;
}

export function ChampIcon({ name, size = 36 }: { name: string; size?: number }) {
  const v = useDdragonVersion();
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (!v || broken) return <span className="champ-icon fallback" style={style}>{name.slice(0, 2)}</span>;
  return (
    <img
      className="champ-icon"
      style={style}
      alt={name}
      src={`https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${name}.png`}
      onError={() => setBroken(true)}
    />
  );
}

// ---------- Line chart with a zero baseline (gold lead, trends) ----------

export interface LinePoint {
  x: number;
  y: number;
}

export function LineChart({
  points,
  height = 180,
  zeroLine = true,
  format = (n: number) => String(Math.round(n)),
  xLabel = (x: number) => String(x),
  markers = [],
  reference,
}: {
  points: LinePoint[];
  height?: number;
  zeroLine?: boolean;
  format?: (n: number) => string;
  xLabel?: (x: number) => string;
  markers?: { x: number; label: string }[];
  reference?: { y: number; label: string };
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="chart-empty">Not enough data yet</div>;
  const W = 520;
  const H = height;
  const pad = { l: 44, r: 12, t: 12, b: 22 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y).concat(zeroLine ? [0] : [], reference ? [reference.y] : []);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  const span = y1 - y0;
  y0 -= span * 0.08;
  y1 += span * 0.08;
  const sx = (x: number) => pad.l + ((x - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x)},${sy(p.y)}`).join("");
  const base = zeroLine ? sy(0) : H - pad.b;
  const area = `${line}L${sx(points[points.length - 1].x)},${base}L${sx(points[0].x)},${base}Z`;
  const ticks = [y1 - span * 0.08, (y0 + y1) / 2, y0 + span * 0.08];
  const id = `clip${Math.round(Math.random() * 1e9)}`;
  const hp = hover !== null ? points[hover] : null;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(sx(p.x) - px) < Math.abs(sx(points[best].x) - px)) best = i;
          });
          setHover(best);
        }}
      >
        <defs>
          <clipPath id={`${id}-pos`}>
            <rect x="0" y="0" width={W} height={base} />
          </clipPath>
          <clipPath id={`${id}-neg`}>
            <rect x="0" y={base} width={W} height={H - base} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="grid" />
            <text x={pad.l - 6} y={sy(t) + 4} className="axis" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {zeroLine && <line x1={pad.l} x2={W - pad.r} y1={base} y2={base} className="zero" />}
        {reference && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={sy(reference.y)} y2={sy(reference.y)} className="ref" />
            <text x={W - pad.r} y={sy(reference.y) - 4} className="axis" textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}
        {zeroLine ? (
          <>
            <path d={area} className="area pos" clipPath={`url(#${id}-pos)`} />
            <path d={area} className="area neg" clipPath={`url(#${id}-neg)`} />
          </>
        ) : (
          <path d={area} className="area neutral" />
        )}
        <path d={line} className="line" />
        {markers.map((m, i) => (
          <g key={i}>
            <line x1={sx(m.x)} x2={sx(m.x)} y1={pad.t} y2={H - pad.b} className="marker-line" />
            <circle cx={sx(m.x)} cy={pad.t + 6} r="8" className="marker-dot" />
            <text x={sx(m.x)} y={pad.t + 10} textAnchor="middle" className="marker-text">
              {m.label}
            </text>
          </g>
        ))}
        {[points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].map((p) => (
          <text key={p.x} x={sx(p.x)} y={H - 6} className="axis" textAnchor="middle">
            {xLabel(p.x)}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={sx(hp.x)} x2={sx(hp.x)} y1={pad.t} y2={H - pad.b} className="hover-line" />
            <circle cx={sx(hp.x)} cy={sy(hp.y)} r="4" className="hover-dot" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: `${(sx(hp.x) / W) * 100}%` }}>
          <strong>{format(hp.y)}</strong> <span>{xLabel(hp.x)}</span>
        </div>
      )}
    </div>
  );
}

// ---------- Radar (skill profile) ----------

export function Radar({
  axes,
  values,
  compare,
  size = 280,
}: {
  axes: string[];
  values: number[];
  compare?: number[];
  size?: number;
}) {
  const c = size / 2;
  const R = size / 2 - 42;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    return [c + Math.cos(a) * R * (v / 100), c + Math.sin(a) * R * (v / 100)];
  };
  const poly = (vs: number[]) => vs.map((v, i) => pt(i, v).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="radar">
      {[25, 50, 75, 100].map((r) => (
        <polygon key={r} points={poly(axes.map(() => r))} className={r === 50 ? "ring avg" : "ring"} />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 100);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} className="spoke" />;
      })}
      {compare && <polygon points={poly(compare)} className="shape compare" />}
      <polygon points={poly(values)} className="shape" />
      {values.map((v, i) => {
        const [x, y] = pt(i, v);
        return <circle key={i} cx={x} cy={y} r="3.5" className="vertex" />;
      })}
      {axes.map((a, i) => {
        const [x, y] = pt(i, 122);
        return (
          <text key={a} x={x} y={y} textAnchor="middle" className="radar-label">
            <tspan x={x} dy="0">
              {a}
            </tspan>
            <tspan x={x} dy="15" className="radar-value">
              {values[i]}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}

// ---------- Meter (0-100 score bar with the 50 = average tick) ----------

export function Meter({ value, label, delta }: { value: number; label: string; delta?: number | null }) {
  const tone = value >= 60 ? "good" : value >= 45 ? "ok" : "bad";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">
          {value}
          {delta ? <em className={delta > 0 ? "up" : "down"}>{delta > 0 ? `▲${delta}` : `▼${-delta}`}</em> : null}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${value}%` }} />
        <div className="meter-avg" title="Typical Silver/Gold" />
      </div>
    </div>
  );
}

// ---------- Win/loss or pass/fail dots ----------

export function ResultDots({ results, labels }: { results: (boolean | null)[]; labels?: string[] }) {
  return (
    <div className="dots">
      {results.map((r, i) => (
        <span key={i} className={`dot ${r === null ? "na" : r ? "pass" : "fail"}`} title={labels?.[i]} />
      ))}
    </div>
  );
}

// ---------- Stylised Summoner's Rift (drawn, so it's crisp and works offline) ----------

export function MapBackdrop({ size }: { size: number }) {
  const k = size / 100;
  const lane = { fill: "none", stroke: "#3a4658", strokeWidth: 3 * k, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <g className="rift">
      <rect width={size} height={size} fill="#132019" />
      {/* river */}
      <path d={`M${4 * k},${4 * k} L${96 * k},${96 * k}`} stroke="#1d3a4a" strokeWidth={6 * k} strokeLinecap="round" />
      {/* lanes */}
      <path d={`M${10 * k},${90 * k} L${8 * k},${8 * k} L${90 * k},${10 * k}`} {...lane} />
      <path d={`M${10 * k},${90 * k} L${92 * k},${92 * k} L${90 * k},${10 * k}`} {...lane} />
      <path d={`M${12 * k},${88 * k} L${88 * k},${12 * k}`} {...lane} />
      {/* bases */}
      <path d={`M0,${size} L0,${78 * k} A${22 * k},${22 * k} 0 0 0 ${22 * k},${size} Z`} fill="rgba(59,130,246,0.35)" />
      <path d={`M${size},0 L${78 * k},0 A${22 * k},${22 * k} 0 0 0 ${size},${22 * k} Z`} fill="rgba(239,93,93,0.35)" />
      {/* objective pits */}
      <circle cx={67 * k} cy={70 * k} r={4 * k} fill="#2b2f1c" stroke="#6b6431" />
      <circle cx={33 * k} cy={30 * k} r={4 * k} fill="#2a1c2f" stroke="#64316b" />
      <text x={67 * k} y={77.5 * k} textAnchor="middle" className="map-pit">Dragon</text>
      <text x={33 * k} y={24 * k} textAnchor="middle" className="map-pit">Baron</text>
    </g>
  );
}

// ---------- Map with death / kill positions ----------

const MAP_MAX = 14870;

export function DeathMap({ deaths, kills, size = 300 }: { deaths: MapEvent[]; kills: MapEvent[]; size?: number }) {
  const px = (e: MapEvent) => [(e.x / MAP_MAX) * size, (1 - e.y / MAP_MAX) * size];
  const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="map">
      <MapBackdrop size={size} />
      <rect width={size} height={size} className="map-frame" />
      {kills.map((k, i) => {
        const [x, y] = px(k);
        return (
          <circle key={`k${i}`} cx={x} cy={y} r="6" className="map-kill">
            <title>Kill at {fmt(k.timeMs)}</title>
          </circle>
        );
      })}
      {deaths.map((d, i) => {
        const [x, y] = px(d);
        return (
          <g key={`d${i}`}>
            <path d={`M${x - 6},${y - 6}L${x + 6},${y + 6}M${x + 6},${y - 6}L${x - 6},${y + 6}`} className="map-death" />
            <title>Death at {fmt(d.timeMs)}</title>
          </g>
        );
      })}
    </svg>
  );
}
