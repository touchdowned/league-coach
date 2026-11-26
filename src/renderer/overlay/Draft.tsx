import { Brain, Check, Crosshair, Lock, ShieldAlert, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChallengeId } from "../../core/mind";
import { ROLE_LABEL } from "../../core/benchmarks";
import { coach, DraftInfo, DraftOption } from "../api";
import { ChampIcon } from "../charts";
import { champName } from "../../core/names";

const INTENTIONS = ["Play for the long game", "Next wave over last fight", "Mute early, stay on my screen", "Trust my reads", "Calm hands, slow breaths"];
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

/** The champ-select card: pick one skill goal and one mental goal, then lock in. */
export function DraftApp() {
  const [info, setInfo] = useState<DraftInfo | null>(null);
  useEffect(() => {
    document.body.classList.add("overlay-body");
    coach().mindDraftInfo().then((r) => r.ok && setInfo(r.value));
    return coach().onMindDraft(setInfo);
  }, []);
  if (!info) return null;
  return <DraftCard info={info} onClose={() => coach().mindCloseDraft()} floating />;
}

export function DraftCard({ info, onClose, floating, onLocked }: { info: DraftInfo; onClose?: () => void; floating?: boolean; onLocked?: () => void }) {
  const [skill, setSkill] = useState<ChallengeId>(info.plan?.skill ?? info.recommendedSkill);
  const [mental, setMental] = useState<ChallengeId>(info.plan?.mental ?? info.recommendedMental);
  const [intention, setIntention] = useState(info.plan?.intention ?? info.lastIntention ?? "");
  const [editing, setEditing] = useState(!info.plan);
  useEffect(() => {
    if (!info.plan) return;
    setSkill(info.plan.skill);
    setMental(info.plan.mental);
    setIntention(info.plan.intention);
  }, [info.plan]);
  const locked = !!info.plan && !editing;

  async function lock() {
    await coach().mindLockPlan({ skill, mental, intention, champion: info.champion ?? undefined, role: info.role });
    setEditing(false);
    onLocked?.();
  }

  const skillOpt = info.skillOptions.find((o) => o.id === skill) ?? info.skillOptions[0];
  const mentalOpt = info.mentalOptions.find((o) => o.id === mental) ?? info.mentalOptions[0];

  return (
    <div className={`draft ${floating ? "floating" : ""}`}>
      <header className="draft-head" style={floating ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined}>
        <div className="draft-champ">
          {info.champion ? <ChampIcon name={info.champion} size={40} /> : <span className="draft-champ-empty" />}
          <div>
            <span className="eyebrow accent">Game plan</span>
            <strong>{info.championName ?? "Pick your champion"}</strong>
            <small className="muted">
              {info.role ? ROLE_LABEL[info.role] : "Role unknown"}
              {info.enemyName ? ` vs ${champName(info.enemyName)}` : ""}
            </small>
          </div>
        </div>
        {onClose && (
          <button className="draft-x" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        )}
      </header>

      <div className={`draft-queue ${info.queue.tone}`}>
        <ShieldAlert size={15} aria-hidden />
        <div>
          <b>{info.queue.title}</b>
          <span>{info.queue.body}</span>
        </div>
      </div>

      {info.focus && (
        <div className="draft-focus">
          <span className="eyebrow accent">Your one focus this game</span>
          <b>{info.focus.title}</b>
          <span>{info.focus.rule}</span>
          <small>{info.focus.cue}</small>
        </div>
      )}

      {info.read && info.read.games > 0 && (
        <div className="draft-read">
          <Stat label={`On ${champName(info.championName)}`} value={pct(info.read.winRate)} sub={`${info.read.games} games`} />
          <Stat label="CS @10" value={info.read.cs10 ?? "—"} />
          <Stat label="Deaths <14" value={info.read.deathsPre14?.toFixed(1) ?? "—"} />
          {info.enemyName && <Stat label={`vs ${champName(info.enemyName)}`} value={info.read.vsGames ? pct(info.read.vsWinRate) : "New"} sub={info.read.vsGames ? `${info.read.vsGold15! >= 0 ? "+" : ""}${info.read.vsGold15}g @15` : "no games yet"} />}
        </div>
      )}

      {locked ? (
        <div className="draft-locked">
          <LockedGoal icon="skill" opt={skillOpt} />
          <LockedGoal icon="mental" opt={mentalOpt} />
          {intention && <p className="draft-intention">“{intention}”</p>}
          <div className="draft-actions">
            <span className="draft-ok">
              <Check size={14} /> Locked. It'll be on your screen in game.
            </span>
            <button className="draft-link" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </div>
      ) : (
        <>
          <Section icon="skill" title="Skill goal" options={info.skillOptions} value={skill} onPick={setSkill} recommended={info.recommendedSkill} />
          <Section icon="mental" title="Mental goal" options={info.mentalOptions} value={mental} onPick={setMental} recommended={info.recommendedMental} />
          <div className="draft-sec">
            <span className="draft-sec-title">
              <Sparkles size={13} aria-hidden /> Say it before you load in
            </span>
            <input className="draft-input" value={intention} maxLength={60} placeholder="One line for this game" onChange={(e) => setIntention(e.target.value)} />
            <div className="draft-chips">
              {INTENTIONS.map((t) => (
                <button key={t} className={`chip ${intention === t ? "on" : ""}`} onClick={() => setIntention(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <button className="draft-lock" onClick={lock}>
            <Lock size={15} /> Lock in goals
          </button>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="draft-stat">
      <small>{label}</small>
      <b>{value}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

function Section({ icon, title, options, value, onPick, recommended }: { icon: "skill" | "mental"; title: string; options: DraftOption[]; value: ChallengeId; onPick: (id: ChallengeId) => void; recommended: ChallengeId }) {
  const Icon = icon === "skill" ? Crosshair : Brain;
  return (
    <div className="draft-sec">
      <span className="draft-sec-title">
        <Icon size={13} aria-hidden /> {title}
      </span>
      <div className="draft-opts">
        {options.map((o) => (
          <button key={o.id} className={`draft-opt ${value === o.id ? "on" : ""}`} onClick={() => onPick(o.id)}>
            <span className="draft-opt-top">
              <b>{o.title}</b>
              {o.id === recommended && <span className="draft-rec">Coach pick</span>}
            </span>
            <span className="draft-opt-reason">{o.reason}</span>
            {value === o.id && <span className="draft-opt-rule">{o.rule}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function LockedGoal({ icon, opt }: { icon: "skill" | "mental"; opt?: DraftOption }) {
  if (!opt) return null;
  const Icon = icon === "skill" ? Crosshair : Brain;
  return (
    <div className="draft-goal">
      <Icon size={15} aria-hidden />
      <div>
        <b>{opt.title}</b>
        <span>{opt.rule}</span>
      </div>
    </div>
  );
}
