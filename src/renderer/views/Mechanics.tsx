import { useEffect, useMemo, useState } from "react";
import { Crosshair, Keyboard, Shield, Sparkles } from "lucide-react";
import type { Kit } from "../../core/mechanics/kits";
import { CURATED_CHAMPIONS, isSkillshot } from "../../core/mechanics/kits";
import {
  commonOpponents,
  DAILY_SETS,
  Drill,
  DRILLS,
  EMPTY_MECHANICS,
  MechanicsState,
  recordSet,
  setsToday,
  START,
  stairKey,
  suggestedDrill,
  trainingPool,
  trend,
} from "../../core/mechanics/plan";
import type { GameReport } from "../../core/types";
import { ChampIcon } from "../charts";
import { useProgress } from "../progress";
import { Button, Ring, Skeleton } from "../ui";
import { AimDrill } from "./mechanics/AimDrill";
import { ComboDrill } from "./mechanics/ComboDrill";
import { DodgeDrill } from "./mechanics/DodgeDrill";
import type { SetSummary } from "./mechanics/types";
import { loadKit, spellIcon, useDdVersion, useKit } from "./mechanics/useKit";

const KEY = "lc.mechanics";
const ICON = { aim: Crosshair, dodge: Shield, combo: Keyboard };
/** Casters used for dodging when you have no lane opponents with skillshots on record. */
const FALLBACK_CASTERS = ["Lux", "Ahri", "Xerath", "Morgana"];

function load(): MechanicsState {
  try {
    return { ...EMPTY_MECHANICS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY_MECHANICS;
  }
}

export function MechanicsView({ games }: { games: GameReport[] }) {
  const pool = useMemo(() => trainingPool(games), [games]);
  const [champion, setChampion] = useState(pool[0]?.champion ?? "Ahri");
  const [state, setState] = useState<MechanicsState>(load);
  const [active, setActive] = useState<Drill | null>(null);
  const [summary, setSummary] = useState<SetSummary | null>(null);
  const [runId, setRunId] = useState(0);
  const { kit, loading } = useKit(champion);
  const { award } = useProgress();
  const suggested = useMemo(() => suggestedDrill(games), [games]);

  const entry = pool.find((p) => p.champion === champion);
  const opponentNames = useMemo(() => {
    const own = entry?.opponents ?? [];
    const all = commonOpponents(games);
    return [...new Set([...own, ...all, ...FALLBACK_CASTERS])].slice(0, 8);
  }, [entry, games]);
  const casters = useCasters(opponentNames, active === "dodge");

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: progress just won't persist */
    }
  }, [state]);

  function start(d: Drill) {
    setSummary(null);
    setActive(d);
    setRunId((n) => n + 1);
  }

  function finished(s: SetSummary) {
    setState((prev) => recordSet(prev, { date: new Date().toISOString(), drill: s.drill, champion, score: s.score, level: s.stair.level, detail: s.detail }, s.stair));
    setSummary(s);
    setActive(null);
    award({ type: "drill", score: s.score });
  }

  const stair = (d: Drill) => state.stairs[stairKey(d, champion)] ?? START;
  const today = setsToday(state);
  const noSkillshots = kit && !kit.abilities.some(isSkillshot);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Mechanics</p>
          <h1>Train your champions' hands</h1>
          <p className="muted">Short sets that get harder as you hit them. Do {DAILY_SETS} as a warm-up before you queue.</p>
        </div>
        <div className="mech-daily">
          <Ring value={today / DAILY_SETS} size={52} tone={today >= DAILY_SETS ? "good" : "accent"}>
            <b>{Math.min(today, DAILY_SETS)}</b>
          </Ring>
          <div>
            <b>{today >= DAILY_SETS ? "Warm-up done" : `${DAILY_SETS - Math.min(today, DAILY_SETS)} sets to go`}</b>
            <p className="muted small">today</p>
          </div>
        </div>
      </div>

      <div className="champ-chips mech-pool">
        {pool.map((p) => (
          <button key={p.champion} className={`champ-chip ${p.champion === champion ? "active" : ""}`} disabled={!!active} onClick={() => setChampion(p.champion)}>
            <ChampIcon name={p.champion} size={28} />
            <span>{p.champion}</span>
            {p.games > 0 && <span className="muted small">{p.games} games</span>}
          </button>
        ))}
        <select className="mech-other" value={pool.some((p) => p.champion === champion) ? "" : champion} disabled={!!active} onChange={(e) => e.target.value && setChampion(e.target.value)}>
          <option value="">Other champion…</option>
          {CURATED_CHAMPIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {active ? (
        <div className="panel">
          <div className="panel-head">
            <h2>
              {DRILLS.find((d) => d.id === active)!.label} · {champion}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
              Stop set
            </Button>
          </div>
          {!kit ? (
            <Skeleton h={420} r={12} />
          ) : active === "aim" ? (
            <AimDrill key={runId} kit={kit} stair={stair("aim")} onDone={finished} />
          ) : active === "combo" ? (
            <ComboDrill key={runId} kit={kit} stair={stair("combo")} onDone={finished} />
          ) : casters === null ? (
            <Skeleton h={420} r={12} />
          ) : (
            <DodgeDrill key={runId} you={kit} casters={casters} stair={stair("dodge")} onDone={finished} />
          )}
        </div>
      ) : (
        <>
          {summary && (
            <div className="panel mech-summary">
              <div>
                <p className="eyebrow accent">Set complete</p>
                <h2>{Math.round(summary.score * 100)}%</h2>
                <ul>
                  {summary.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
              <div className="summary-actions">
                <Button variant="primary" onClick={() => start(summary.drill)}>
                  Another set
                </Button>
                <Button onClick={() => start(nextDrill(summary.drill))}>Switch to {DRILLS.find((d) => d.id === nextDrill(summary.drill))!.label.toLowerCase()}</Button>
              </div>
            </div>
          )}

          <div className="grid-3">
            {DRILLS.map((d) => {
              const Icon = ICON[d.id];
              const t = trend(state, d.id, champion);
              const last = t[t.length - 1];
              const blocked = d.id === "aim" && noSkillshots;
              return (
                <div key={d.id} className="tile mech-tile">
                  <div className="tile-top">
                    <Icon size={18} />
                    <h3>{d.label}</h3>
                    {d.id === suggested && <span className="pill mech-suggest">Suggested</span>}
                  </div>
                  <p className="muted small">{blocked ? `${champion} has no skillshots to aim. Try combos or dodging.` : d.cue}</p>
                  <Spark values={t.map((h) => h.score)} />
                  <div className="mech-tile-foot">
                    <span className="muted small">
                      Level {stair(d.id).level}
                      {last ? ` · last ${Math.round(last.score * 100)}%` : ""}
                    </span>
                    <Button variant={d.id === suggested ? "primary" : "secondary"} size="sm" disabled={loading || !kit || !!blocked} onClick={() => start(d.id)}>
                      Start
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <KitPanel kit={kit} loading={loading} champion={champion} />

          <div className="panel mech-why">
            <Sparkles size={16} />
            <p className="small muted">
              Each set adapts so you land about 7 in 10: easy enough to keep going, hard enough to learn from. Drills and spell angles are mixed rather than repeated, and you
              only get a correction when a miss isn't close. Short daily sets beat one long session.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const nextDrill = (d: Drill): Drill => (d === "aim" ? "dodge" : d === "dodge" ? "combo" : "aim");

function useCasters(names: string[], enabled: boolean): Kit[] | null {
  const [kits, setKits] = useState<Kit[] | null>(null);
  const key = names.join(",");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setKits(null);
    Promise.all(names.map(loadKit)).then((ks) => {
      if (!live) return;
      const usable = ks.filter((k): k is Kit => !!k && k.abilities.some(isSkillshot)).slice(0, 4);
      setKits(usable);
    });
    return () => {
      live = false;
    };
    // names is derived from key
  }, [key, enabled]);
  return kits;
}

function Spark({ values }: { values: number[] }) {
  if (!values.length) return <div className="mech-spark is-empty small muted">No sets yet</div>;
  return (
    <div className="mech-spark" aria-label="Recent set scores">
      {values.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(8, v * 100)}%` }} className={v >= 0.7 ? "good" : ""} />
      ))}
    </div>
  );
}

const SHAPE: Record<string, string> = { line: "Line skillshot", circle: "Area skillshot", cone: "Cone", target: "Targeted", self: "Self / no aim", dash: "Dash" };

function KitPanel({ kit, loading, champion }: { kit: Kit | null; loading: boolean; champion: string }) {
  const v = useDdVersion();
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{champion}'s kit in the trainer</h3>
        {kit && <span className="muted small">{kit.source === "curated" ? "Riot data plus hand-checked spell shapes" : "Shapes guessed from Riot's spell text"}</span>}
      </div>
      {loading || !kit ? (
        <Skeleton h={64} r={10} />
      ) : (
        <div className="mech-kit">
          {kit.abilities.map((a) => (
            <div key={a.key} className="mech-ability">
              {a.icon && v ? <img src={spellIcon(v, a.icon)} alt="" /> : <span className="combo-glyph">{a.key}</span>}
              <div>
                <b>{a.name && a.name !== a.key ? `${a.key} · ${a.name}` : a.key}</b>
                <p className="muted small">
                  {SHAPE[a.shape]}
                  {a.range ? ` · ${a.range} range` : ""}
                  {isSkillshot(a) && a.speed ? ` · ${a.speed} speed` : ""}
                  {isSkillshot(a) && a.delay ? ` · ${a.delay}s cast` : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
