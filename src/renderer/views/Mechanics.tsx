import { useEffect, useMemo, useState } from "react";
import { Crosshair, Keyboard, Shield, Sparkles, Swords } from "lucide-react";
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
import { ComboDrill } from "./mechanics/ComboDrill";
import { LaneDrill, LaneSettings } from "./mechanics/LaneDrill";
import type { SetSummary } from "./mechanics/types";
import { spellIcon, useDdVersion, useKit } from "./mechanics/useKit";
import { champName } from "../../core/names";

const KEY = "lc.mechanics";
const SETTINGS_KEY = "lc.mechanics.settings";
const ICON = { aim: Crosshair, dodge: Shield, trade: Swords, combo: Keyboard };
/** Opponents used when you have no lane matchups on record. */
const FALLBACK_OPPONENTS = ["Lux", "Ahri", "Xerath", "Morgana", "Syndra"];

function load(): MechanicsState {
  try {
    return { ...EMPTY_MECHANICS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY_MECHANICS;
  }
}

function loadSettings(): LaneSettings {
  const d: LaneSettings = { indicator: false, realCooldowns: false, sound: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return d;
  }
}

export function MechanicsView({ games }: { games: GameReport[] }) {
  const pool = useMemo(() => trainingPool(games), [games]);
  const [champion, setChampion] = useState(pool[0]?.champion ?? "Ahri");
  const [state, setState] = useState<MechanicsState>(load);
  const [settings, setSettings] = useState<LaneSettings>(loadSettings);
  const [active, setActive] = useState<Drill | null>(null);
  const [summary, setSummary] = useState<SetSummary | null>(null);
  const [runId, setRunId] = useState(0);
  const { kit, loading } = useKit(champion);
  const { award } = useProgress();
  const suggested = useMemo(() => suggestedDrill(games), [games]);

  const entry = pool.find((p) => p.champion === champion);
  const opponents = useMemo(() => {
    const own = entry?.opponents ?? [];
    const all = commonOpponents(games);
    return [...new Set([...own, ...all, ...FALLBACK_OPPONENTS])].filter((c) => c !== champion).slice(0, 6);
  }, [entry, games, champion]);
  const [opponent, setOpponent] = useState<string | null>(null);
  const opp = opponent && opponents.includes(opponent) ? opponent : opponents[0];
  const { kit: oppKit, loading: oppLoading } = useKit(opp ?? null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: progress just won't persist */
    }
  }, [state]);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  function start(d: Drill) {
    setSummary(null);
    setActive(d);
    setRunId((n) => n + 1);
    // The set fills the screen: bring the stage to the top so the ability bar is visible.
    requestAnimationFrame(() => document.querySelector(".mech-running")?.scrollIntoView({ block: "start" }));
  }

  function finished(s: SetSummary) {
    setState((prev) => recordSet(prev, { date: new Date().toISOString(), drill: s.drill, champion, score: s.score, level: s.stair.level, detail: s.detail }, s.stair));
    setSummary(s);
    setActive(null);
    award({ type: "drill", score: s.score });
  }

  const stair = (d: Drill) => state.stairs[stairKey(d, champion)] ?? START;
  const today = setsToday(state);
  const noSkillshots = !!kit && !kit.abilities.some(isSkillshot);
  const oppNoSkillshots = !!oppKit && !oppKit.abilities.some(isSkillshot);
  const why = (d: Drill): string | null =>
    (d === "aim" || d === "trade") && noSkillshots
      ? `${champName(champion)} has no skillshots to aim. Try dodging or combos.`
      : (d === "dodge" || d === "trade") && oppNoSkillshots
        ? `${champName(opp)} has no skillshots to dodge. Pick another opponent.`
        : null;

  return (
    <div className={`page ${active ? "mech-running" : ""}`}>
      {!active && (
        <>
        <div className="page-head">
          <div>
            <p className="eyebrow">Mechanics</p>
            <h1>Lane lab</h1>
            <p className="muted">A real lane with your champion, your lane opponents and live minion waves. The enemy laner gets sharper as you beat it.</p>
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

        <div className="mech-pick">
          <div>
            <p className="eyebrow">You play</p>
            <div className="champ-chips mech-pool">
              {pool.map((p) => (
                <button key={p.champion} className={`champ-chip ${p.champion === champion ? "active" : ""}`} disabled={!!active} onClick={() => setChampion(p.champion)}>
                  <ChampIcon name={p.champion} size={28} />
                  <span>{champName(p.champion)}</span>
                  {p.games > 0 && <span className="muted small">{p.games} games</span>}
                </button>
              ))}
              <select className="mech-other" value={pool.some((p) => p.champion === champion) ? "" : champion} disabled={!!active} onChange={(e) => e.target.value && setChampion(e.target.value)}>
                <option value="">Other champion…</option>
                {CURATED_CHAMPIONS.map((c) => (
                  <option key={c} value={c}>
                    {champName(c)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <p className="eyebrow">Into</p>
            <div className="champ-chips mech-pool">
              {opponents.map((o) => (
                <button key={o} className={`champ-chip ${o === opp ? "active enemy" : ""}`} disabled={!!active} onClick={() => setOpponent(o)}>
                  <ChampIcon name={o} size={28} />
                  <span>{champName(o)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        </>
      )}

      {active ? (
        <div className="panel lane-panel">
          <div className="panel-head">
            <h2>
              {DRILLS.find((d) => d.id === active)!.label} · {champName(champion)} vs {champName(opp)}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
              Stop set
            </Button>
          </div>
          {!kit || (active !== "combo" && !oppKit) ? (
            <Skeleton h={520} r={12} />
          ) : active === "combo" ? (
            <ComboDrill key={runId} kit={kit} stair={stair("combo")} onDone={finished} />
          ) : (
            <LaneDrill key={runId} mode={active} you={kit} enemy={oppKit!} stair={stair(active)} settings={settings} onDone={finished} />
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

          <div className="mech-drills">
            {DRILLS.map((d) => {
              const Icon = ICON[d.id];
              const t = trend(state, d.id, champion);
              const last = t[t.length - 1];
              const blocked = why(d.id);
              return (
                <div key={d.id} className="tile mech-tile">
                  <div className="tile-top">
                    <Icon size={18} />
                    <h3>{d.label}</h3>
                    {d.id === suggested && <span className="pill mech-suggest">Suggested</span>}
                  </div>
                  <p className="muted small">{blocked ?? d.cue}</p>
                  <Spark values={t.map((h) => h.score)} />
                  <div className="mech-tile-foot">
                    <span className="muted small">
                      Level {stair(d.id).level}
                      {last ? ` · last ${Math.round(last.score * 100)}%` : ""}
                    </span>
                    <Button
                      variant={d.id === suggested ? "primary" : "secondary"}
                      size="sm"
                      disabled={loading || !kit || !!blocked || (d.id !== "combo" && (oppLoading || !oppKit))}
                      onClick={() => start(d.id)}
                    >
                      Start
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="panel mech-settings">
            <h3>Controls</h3>
            <label className="mech-toggle">
              <input type="checkbox" checked={settings.indicator} onChange={(e) => setSettings({ ...settings, indicator: e.target.checked })} />
              <span>
                <b>Quick cast with indicator</b>
                <small className="muted">Hold the key to see the spell's shape, release to cast. Match what you use in game.</small>
              </span>
            </label>
            <label className="mech-toggle">
              <input type="checkbox" checked={settings.realCooldowns} onChange={(e) => setSettings({ ...settings, realCooldowns: e.target.checked })} />
              <span>
                <b>Real cooldowns</b>
                <small className="muted">Off: practice-tool short cooldowns for more reps. On: every cast counts, like in lane.</small>
              </span>
            </label>
            <label className="mech-toggle">
              <input type="checkbox" checked={settings.sound} onChange={(e) => setSettings({ ...settings, sound: e.target.checked })} />
              <span>
                <b>Sound</b>
                <small className="muted">Different sounds for a hit, a minion block and getting hit.</small>
              </span>
            </label>
          </div>

          <KitPanel kit={kit} loading={loading} champion={champion} />

          <div className="panel mech-why">
            <Sparkles size={16} />
            <p className="small muted">
              The enemy reacts to your cast animation after a human reaction time, can't dodge while it's mid auto-attack, favours one dodge side, and Flashes when it's low.
              Those are the habits you exploit in real lanes. It adapts so you land about 7 in 10.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const nextDrill = (d: Drill): Drill => (d === "aim" ? "dodge" : d === "dodge" ? "trade" : d === "trade" ? "combo" : "aim");

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
        <h3>{champName(champion)}'s kit in the trainer</h3>
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
