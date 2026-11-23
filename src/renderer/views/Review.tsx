import { Check, ChevronLeft, Eye, EyeOff, ChevronRight, Clapperboard, MonitorPlay, Pause, Play, Trophy, Video, Waves } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { fmtTime } from "../../core/analysis";
import { benchmarkFor, ROLE_LABEL } from "../../core/benchmarks";
import type { GameReport, Mistake } from "../../core/types";
import { momentCount, REVIEW_MOMENTS, type Leak } from "../../core/engine";
import { coach, ReplayState, Settings, TaskProgress, Vod } from "../api";
import { ChampIcon, DeathMap, LineChart, MapBackdrop } from "../charts";
import { describeSpot, dist, positionAt } from "../../core/track";
import { minionsAt } from "../../core/waves";
import { atMinute, summarize, type LaneStats } from "../../core/benchmark";
import { hasVision, lastSeen, visibleAt } from "../../core/vision";
import { Rift, useGameClock } from "../rift";
import { useProgress } from "../progress";
import { Button, Empty, Kbd, ProgressBar, Spinner } from "../ui";

export function ReviewView({
  games,
  target,
  settings,
  onTargetConsumed,
  onPuzzles,
  onGameUpdated,
}: {
  games: GameReport[];
  target: { matchId: string; autoplay: boolean; kind?: string } | null;
  settings: Settings;
  onTargetConsumed: () => void;
  onPuzzles: () => void;
  onGameUpdated?: (r: GameReport) => void;
}) {
  const { state: progress } = useProgress();
  const [selected, setSelected] = useState<string | null>(target?.matchId ?? null);
  // Low friction: opening Review starts playing; Space pauses.
  const [autoplay, setAutoplay] = useState(target?.autoplay ?? true);
  const [startKind, setStartKind] = useState<string | undefined>(target?.kind);

  useEffect(() => {
    if (target) {
      setSelected(target.matchId);
      setAutoplay(target.autoplay);
      setStartKind(target.kind);
      onTargetConsumed();
    }
  }, [target, onTargetConsumed]);

  if (games.length === 0) return <div className="page"><Empty title="No games yet" body="Sync your games first, then come back to review them." /></div>;

  const current = games.find((g) => g.metrics.matchId === selected) ?? games.find((g) => !progress.reviewedGames.includes(g.metrics.matchId)) ?? games[0];
  const nextUnreviewed = games.find((g) => g !== current && momentCount(g) > 0 && !progress.reviewedGames.includes(g.metrics.matchId)) ?? null;

  return (
    <div className="review-layout">
      <div className="game-list">
        {games.map((g) => {
          const m = g.metrics;
          const done = progress.reviewedGames.includes(m.matchId);
          return (
            <button key={m.matchId} className={`game-item ${m.win ? "w" : "l"} ${current.metrics.matchId === m.matchId ? "on" : ""}`} onClick={() => { setSelected(m.matchId); setAutoplay(true); setStartKind(undefined); }}>
              <ChampIcon name={m.champion} size={34} />
              <span className="gi-main">
                <strong>{m.champion}</strong>
                <small>
                  {ROLE_LABEL[m.role]} · {m.kills}/{m.deaths}/{m.assists}
                </small>
              </span>
              <span className="gi-side">
                <b className="grade-chip" title="Moments to review">{momentCount(g)}</b>
                {done ? <i className="check" /> : momentCount(g) > 0 ? <span className="dot-new" /> : null}
              </span>
            </button>
          );
        })}
      </div>
      <div className="review-main">
        <ReviewPlayer
          key={current.metrics.matchId}
          r={current}
          autoplay={autoplay}
          startKind={current.metrics.matchId === selected ? startKind : undefined}
          settings={settings}
          next={nextUnreviewed}
          onNext={(id) => { setSelected(id); setAutoplay(true); }}
          onPuzzles={onPuzzles}
          onGameUpdated={onGameUpdated}
        />
      </div>
    </div>
  );
}

// One entry per leak, biggest gold cost first. Older reports without the engine's
// leaks fall back to one entry per death.
interface Moment {
  key: string;
  timeMs: number;
  main?: Mistake;
  extra: Mistake[];
  leak?: Leak;
}

const MAX_MOMENTS = REVIEW_MOMENTS;


function toMoments(r: GameReport): Moment[] {
  if (r.leaks?.length) {
    return r.leaks.slice(0, MAX_MOMENTS).map((l) => {
      const ms = l.deathMs != null ? r.mistakes.filter((m) => m.timeMs === l.deathMs).sort((a, b) => b.severity - a.severity) : [];
      return { key: `${r.metrics.matchId}:${l.kind}:${l.t}`, timeMs: l.t, main: ms[0], extra: ms.slice(1), leak: l };
    });
  }
  return deathMoments(r);
}

function promptFor(mo: Moment, opp: string | null): string {
  const at = fmtTime(mo.timeMs);
  switch (mo.leak?.kind) {
    case "recall":
      return `${at}: you recall. Was this the right time?`;
    case "farm":
      return `${at}: watch your farm against ${opp ?? "your opponent"}. What's leaking?`;
    case "roam":
      return `${at}: you leave lane. Was it worth it?`;
    case "objective":
      return `${at}: an objective is coming. Where should you be?`;
    default:
      return `${at}: you die here. Why?`;
  }
}

const costTier = (mo: Moment) => (mo.leak ? (mo.leak.cost >= 600 ? "hi" : mo.leak.cost >= 300 ? "mid" : "lo") : (mo.main?.severity ?? 0) >= 8 ? "hi" : (mo.main?.severity ?? 0) >= 6 ? "mid" : "lo");

function deathMoments(r: GameReport): Moment[] {
  const by = new Map<number, Mistake[]>();
  for (const m of r.mistakes) by.set(m.timeMs, [...(by.get(m.timeMs) ?? []), m]);
  return [...by.entries()]
    .map(([t, ms]) => {
      const sorted = [...ms].sort((a, b) => b.severity - a.severity);
      return { key: `${r.metrics.matchId}:${t}`, timeMs: t, main: sorted[0], extra: sorted.slice(1) };
    })
    .sort((a, b) => a.timeMs - b.timeMs);
}

type Media = { kind: "clip"; url: string } | { kind: "vod"; vod: Vod } | { kind: "replay" } | { kind: "rift" } | { kind: "map" };

const LEAD_MS = 40000; // the lead-up shown before each death
const FREEZE_MS = 4000; // freeze this long before the death (temporal occlusion)

function ReviewPlayer({
  r,
  autoplay,
  startKind,
  settings,
  next,
  onNext,
  onPuzzles,
  onGameUpdated,
}: {
  r: GameReport;
  autoplay: boolean;
  startKind?: string;
  settings: Settings;
  next: GameReport | null;
  onNext: (matchId: string) => void;
  onPuzzles: () => void;
  onGameUpdated?: (r: GameReport) => void;
}) {
  const m = r.metrics;
  const moments = useMemo(() => toMoments(r), [r]);
  const { state: progress, award } = useProgress();
  const [idx, setIdx] = useState(() => Math.max(0, startKind ? moments.findIndex((mo) => mo.main?.kind === startKind || mo.leak?.kind === startKind || mo.extra.some((x) => x.kind === startKind)) : 0));
  const [playing, setPlaying] = useState(autoplay && moments.length > 0);
  const [elapsed, setElapsed] = useState(0);
  // Predict, then reveal: the coaching stays hidden for the first few seconds so you
  // commit to your own read first (generation effect), unless you reveal it.
  const [revealed, setRevealed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [clips, setClips] = useState<Record<string, string> | null>(null);
  const [vod, setVod] = useState<Vod | null | undefined>(undefined);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState<TaskProgress | null>(null);
  const [reading, setReading] = useState<TaskProgress | null>(null);
  const [bench, setBench] = useState<LaneStats[]>([]);
  useEffect(() => {
    coach().benchGet?.().then((res) => res.ok && setBench(res.value)).catch(() => undefined);
  }, []);
  const [vodOffset, setVodOffset] = useState(() => Number(safeGet(`lc.vodOffset.${m.matchId}`) ?? 0));
  const videoRef = useRef<HTMLVideoElement>(null);
  const per = Math.max(6, settings.autoAdvanceSec || 14);
  const moment = moments[idx];
  const benchSummary = useMemo(() => summarize(bench, m.role, m.champion), [bench, m.role, m.champion]);
  const benchLine = benchSummary && r.lane && moment?.leak ? atMinute(benchSummary, r.lane, moment.leak.t) : null;

  // Load media sources.
  const refreshReplay = useCallback(async () => {
    const s = await coach().replayState(m.matchId);
    setReplay(s.ok ? s.value : { kind: "client-closed" });
  }, [m.matchId]);

  useEffect(() => {
    coach().clipsList(m.matchId).then((x) => setClips(x.ok ? x.value : {}));
    coach().vodFind(m.matchId).then((x) => setVod(x.ok ? x.value : null));
    refreshReplay();
    const t = setInterval(refreshReplay, 3000);
    return () => clearInterval(t);
  }, [m.matchId, refreshReplay]);

  useEffect(() => coach().onClipsProgress((p) => setRecording(p.done >= p.total ? null : p)), []);
  useEffect(() => coach().onScanProgress((p) => setReading(p.phase === "done" ? null : p)), []);

  const media: Media = !moment
    ? { kind: "map" }
    : clips?.[String(moment.timeMs)]
      ? { kind: "clip", url: clips[String(moment.timeMs)] }
      : vod
        ? { kind: "vod", vod }
        : replay?.kind === "open"
          ? { kind: "replay" }
          : r.track
            ? { kind: "rift" }
            : { kind: "map" };

  // Freeze-and-predict on the live map. For ganks, the enemy jungler stays in the fog and you
  // have to place them before the answer shows (jungle tracking is the skill being trained).
  const [frozen, setFrozen] = useState(false);
  const [guess, setGuess] = useState<{ x: number; y: number } | null>(null);
  const enemyJungler = r.track?.players.find((p) => p.teamId !== r.teamId && p.role === "JUNGLE");
  const junglerDrill = media.kind === "rift" && !!enemyJungler && !!moment && !!moment.main && (moment.main.kind === "ganked" || !!moment.main.context?.enemyJunglerInvolved);

  // On each moment: point the media at it.
  useEffect(() => {
    if (!moment) return;
    setElapsed(0);
    setRevealed(false);
    setFrozen(false);
    setGuess(null);
    const start = Math.max(0, moment.timeMs / 1000 - 12);
    if (media.kind === "vod" && videoRef.current) {
      videoRef.current.currentTime = Math.max(0, start + vodOffset);
      if (playing) videoRef.current.play().catch(() => undefined);
    }
    if (media.kind === "replay") {
      coach().replaySeek(start, !playing);
      coach().replayFollow(m.champion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, media.kind]);

  // Pause/resume media with the review.
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      if (playing) v.play().catch(() => undefined);
      else v.pause();
    }
    if (media.kind === "replay" && replay?.kind === "open") coach().replaySeek(replay.time, !playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const finish = useCallback(async () => {
    setPlaying(false);
    setFinished(true);
    await award({ type: "game", matchId: m.matchId });
  }, [award, m.matchId]);

  const go = useCallback(
    async (to: number) => {
      if (moment) await award({ type: "moment", id: moment.key });
      if (to >= moments.length) return finish();
      setIdx(Math.max(0, to));
    },
    [moment, moments.length, award, finish],
  );

  // Auto-advance timer (clips advance when they end instead).
  useEffect(() => {
    if (!playing || finished || !moment || media.kind === "clip") return;
    if (media.kind === "rift" && !revealed) return; // the map review waits for your call first
    const started = performance.now() - elapsed * 1000;
    let raf = 0;
    const tick = () => {
      const e = (performance.now() - started) / 1000;
      if (e >= per) {
        go(idx + 1);
        return;
      }
      setElapsed(e);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, idx, finished, media.kind, revealed]);

  // Keyboard: space play/pause, arrows step.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === " ") {
        e.preventDefault();
        if (finished) return;
        setPlaying((p) => !p);
      } else if (e.key === "r" || e.key === "R") setRevealed(true);
      else if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [go, idx, finished]);

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string } | unknown>) {
    setBusy(label);
    const res = (await fn()) as { ok: boolean; error?: string };
    setBusy(null);
    if (res && res.ok === false) toast.error(res.error ?? "That didn't work");
    refreshReplay();
  }

  const reviewed = progress.reviewedGames.includes(m.matchId);
  const revealAt = media.kind === "clip" ? 12 : Math.min(5, per * 0.35);
  useEffect(() => {
    if (media.kind !== "rift" && !revealed && elapsed >= revealAt) setRevealed(true);
  }, [elapsed, revealAt, revealed, media.kind]);
  // Without the jungler drill, the frozen map gives you a few seconds to call it, then reveals.
  useEffect(() => {
    if (media.kind !== "rift" || !frozen || revealed || junglerDrill || !playing) return;
    const t = setTimeout(() => setRevealed(true), 3500);
    return () => clearTimeout(t);
  }, [media.kind, frozen, revealed, junglerDrill, playing]);
  const pickJungler = (p: { x: number; y: number }) => {
    if (!frozen || revealed || !moment || !enemyJungler || !r.track) return;
    setGuess(p);
    setRevealed(true);
    const truth = positionAt(r.track, enemyJungler.id, moment.timeMs - FREEZE_MS);
    award({ type: "puzzle", right: !!truth && dist(p, truth) < 3000 });
  };
  const timerPct = media.kind === "clip" ? elapsed / (videoRef.current?.duration || 19) : elapsed / per;

  return (
    <div className="page review-page">
      <header className="review-head">
        <ChampIcon name={m.champion} size={52} />
        <div className="rh-main">
          <h1>
            {m.champion} {m.opponentChampion && <span className="muted">vs {m.opponentChampion}</span>}
          </h1>
          <p className="muted">
            <span className={m.win ? "win" : "loss"}>{m.win ? "Victory" : "Defeat"}</span> · {ROLE_LABEL[m.role]} · {Math.round(m.durationMin)} min · {m.kills}/{m.deaths}/{m.assists} · {new Date(m.gameCreation).toLocaleDateString()}
          </p>
        </div>
        <span className="moments-big"><b>{momentCount(r)}</b><small>moments</small></span>
      </header>

      {moments.length === 0 ? (
        <div className="hero quiet">
          No deaths the match data can flag in this game. The stats below show where it was won or lost: start with your CS and gold lead at 15.
        </div>
      ) : finished ? (
        <Summary r={r} reviewed={reviewed} next={next} onNext={onNext} onPuzzles={onPuzzles} onRestart={() => { setFinished(false); setIdx(0); setPlaying(true); }} />
      ) : (
        <section className="player">
          <div className="stories">
            {moments.map((mo, i) => (
              <button key={mo.key} className="story" onClick={() => setIdx(i)} aria-label={`Moment ${i + 1}`}>
                <span className="story-fill" style={{ transform: `scaleX(${i < idx ? 1 : i === idx ? Math.min(1, timerPct) : 0})` }} />
              </button>
            ))}
          </div>

          <div className="stage">
            {media.kind === "clip" ? (
              <video key={media.url} ref={videoRef} src={media.url} autoPlay={playing} controls onEnded={() => playing && go(idx + 1)} onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)} />
            ) : media.kind === "vod" ? (
              <video ref={videoRef} src={media.vod.url} controls preload="auto" />
            ) : media.kind === "replay" ? (
              <div className="stage-replay">
                <MonitorPlay size={28} className="muted" />
                <span><span className="live-dot" /> Playing in your League replay window</span>
                <small className="muted">The camera jumps to 12s before each moment.</small>
              </div>
            ) : media.kind === "rift" && moment ? (
              <RiftMoment
                key={moment.key}
                r={r}
                moment={moment}
                playing={playing}
                frozen={frozen}
                revealed={revealed}
                onFrozen={() => setFrozen(true)}
                hideId={junglerDrill && !revealed ? enemyJungler!.id : undefined}
                drill={junglerDrill ? enemyJungler!.champion : undefined}
                guess={guess}
                onPick={junglerDrill ? pickJungler : undefined}
              />
            ) : moment ? (
              <MomentMap r={r} moment={moment} />
            ) : null}
            {media.kind !== "rift" && <span className="stage-time">{moment ? fmtTime(moment.timeMs) : ""}</span>}
          </div>

          <div className="moment" key={moment?.key}>
            <div className="moment-top">
              <span className={`sev sev-${costTier(moment)}`}>
                {idx + 1}/{moments.length}
              </span>
              <h2>{revealed ? (moment.leak?.title ?? moment.main?.title) : promptFor(moment, m.opponentChampion)}</h2>
            </div>
            {!revealed && (
              <button className="guess" onClick={() => setRevealed(true)}>
                <Eye size={16} />
                <span>
                  {media.kind === "rift" ? (
                    junglerDrill ? (
                      <>
                        <strong>Where's {enemyJungler!.champion}?</strong> The jungler is hidden, like on your minimap. {frozen ? "Click where you think they are." : "Watch the lead-up; it freezes 4 seconds before you die."} <Kbd>R</Kbd> skips.
                      </>
                    ) : (
                      <>
                        <strong>Call it before you see it.</strong> {moment.leak && moment.leak.kind !== "death" ? (frozen ? "Frozen at the moment. What would you do differently?" : "Watch the lead-up. It freezes at the moment.") : frozen ? "Frozen 4 seconds before you die. What's about to go wrong?" : "Watch the lead-up. It freezes 4 seconds before you die."} Or press <Kbd>R</Kbd>.
                      </>
                    )
                  ) : (
                    <>
                      <strong>Call it before you see it.</strong> Watch the moment and decide what went wrong. Revealing in {Math.max(1, Math.ceil(revealAt - elapsed))}s, or press <Kbd>R</Kbd>.
                    </>
                  )}
                </span>
              </button>
            )}
            <div className={`reveal ${revealed ? "on" : ""}`} aria-hidden={!revealed}>
            {moment.leak ? (
              <>
                <div className="cost-row">
                  <span className="cost-total">≈ {moment.leak.cost.toLocaleString("en-US")}g</span>
                  {moment.leak.costParts.map((p) => (
                    <span key={p.label} className="cost-part">
                      {p.label} <b>{p.gold.toLocaleString("en-US")}g</b>
                    </span>
                  ))}
                </div>
                <div className="think">
                  <p className="eyebrow">What you were doing</p>
                  <p>{moment.leak.doing}</p>
                  {moment.leak.evidence.length > 0 && (
                    <ul className="evidence">
                      {moment.leak.evidence.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="fix">
                  <p className="eyebrow">Next time</p>
                  <p>{moment.leak.nextTime}</p>
                </div>
                {benchLine && moment.leak.t < 16 * 60_000 && moment.leak.kind !== "objective" && (
                  <p className="bench-line"><Trophy size={13} /> {benchLine}</p>
                )}
              </>
            ) : moment.main ? (
              <>
                <p className="moment-detail">
                  {moment.main.detail}
                  {moment.extra.length > 0 && <> Also: {moment.extra.map((x) => x.title.replace(/ at \d+:\d+$/, "").toLowerCase()).join(", ")}.</>}
                </p>
                <div className="think">
                  <p className="eyebrow">What you were probably thinking</p>
                  <p>{moment.main.read}</p>
                </div>
                <div className="fix">
                  <p className="eyebrow">Why that's wrong</p>
                  <p>{moment.main.tip}</p>
                </div>
              </>
            ) : null}
            </div>
            <div className="controls">
              <Button variant="ghost" size="sm" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>
                <ChevronLeft size={16} /> Prev
              </Button>
              <Button variant="primary" size="sm" onClick={() => setPlaying((p) => !p)}>
                {playing ? <><Pause size={14} fill="currentColor" /> Pause</> : <><Play size={14} fill="currentColor" /> Play review</>}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => go(idx + 1)}>
                {idx + 1 >= moments.length ? <><Check size={16} /> Finish</> : <>Next <ChevronRight size={16} /></>}
              </Button>
              <span className="hint">
                <Kbd>Space</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd>
              </span>
            </div>
          </div>
        </section>
      )}

      <SourceBar
        r={r}
        replay={replay}
        vod={vod}
        clips={clips}
        busy={busy}
        recording={recording}
        vodOffset={vodOffset}
        onVodOffset={(v) => {
          setVodOffset(v);
          safeSet(`lc.vodOffset.${m.matchId}`, String(v));
        }}
        onDownload={() => act("download", () => coach().replayDownload(m.matchId))}
        onWatch={() => act("watch", () => coach().replayWatch(m.matchId))}
        onEnable={() => act("enable", async () => {
          const res = await coach().replayEnableApi();
          if (res.ok) toast.success("Replay control turned on", { description: "It works the next time you open a replay." });
          return res;
        })}
        onRecord={() => act("record", async () => {
          const res = await coach().clipsRecord(m.matchId, moments.map((x) => x.timeMs));
          if (res.ok) {
            setClips(res.value);
            toast.success("Clips saved", { description: "They'll play right here from now on." });
          }
          return res;
        })}
        onCancelRecord={() => coach().clipsCancel()}
        reading={reading}
        onRead={() => act("read", async () => {
          setReading({ done: 0, total: 1, label: "Starting" });
          const res = await coach().replayRead(m.matchId);
          setReading(null);
          if (res.ok) {
            onGameUpdated?.(res.value);
            toast.success("Replay read", { description: "Wave state now comes from the replay's minimap." });
          }
          return res;
        })}
        onCancelRead={() => coach().replayReadCancel()}
        onPickVod={() => act("vod", async () => {
          const res = await coach().vodPick(m.matchId);
          if (res.ok && res.value) setVod(res.value);
          return res;
        })}
      />

      <GameStats r={r} />
    </div>
  );
}

function RiftMoment(props: {
  r: GameReport;
  moment: Moment;
  playing: boolean;
  frozen: boolean;
  revealed: boolean;
  onFrozen: () => void;
  hideId?: number;
  drill?: string;
  guess: { x: number; y: number } | null;
  onPick?: (p: { x: number; y: number }) => void;
}) {
  const { r, moment, playing, frozen, revealed } = props;
  const track = r.track!;
  const death = moment.timeMs;
  const freezeAt = death - FREEZE_MS;
  const me = track.players.find((p) => p.champion === r.metrics.champion && p.teamId === r.teamId);
  // Lead-up at 6x, then after the reveal play through the death at 2x.
  const leadT = useGameClock(Math.max(0, death - LEAD_MS), freezeAt, 6, playing && !frozen, props.onFrozen);
  const afterT = useGameClock(freezeAt, Math.min(track.durationMs, death + 5000), 2, playing && revealed);
  const t = revealed ? afterT : leadT;
  const jungler = props.drill ? track.players.find((p) => p.champion === props.drill && p.teamId !== r.teamId) : undefined;
  const truth = jungler ? positionAt(track, jungler.id, freezeAt) : null;
  const off = props.guess && truth ? dist(props.guess, truth) : null;
  // With the replay read: show what you could see during the lead-up, everything after.
  const vision = hasVision(r.waves, r.teamId);
  const [view, setView] = useState<"you" | "all">("you");
  useEffect(() => setView(revealed ? "all" : "you"), [revealed]);
  const seen = vision && view === "you" ? visibleAt(r.waves, t) : null;
  const fogged = seen ? track.players.filter((p) => p.teamId !== r.teamId && !seen.has(p.id)).map((p) => p.id) : [];
  const fogGhosts = fogged
    .map((id) => {
      const ls = lastSeen(r.waves, id, t, 90_000);
      const p = track.players.find((x) => x.id === id)!;
      return ls ? { x: ls.x, y: ls.y, champion: p.champion, label: `${Math.round((t - ls.t) / 1000)}s ago` } : null;
    })
    .filter((g): g is { x: number; y: number; champion: string; label: string } => !!g);
  return (
    <div className="stage-map rift-stage">
      <div className="rift-wrap">
        <Rift
          track={track}
          teamId={r.teamId}
          meId={me?.id}
          t={t}
          hidden={[...(props.hideId ? [props.hideId] : []), ...fogged]}
          ghosts={fogGhosts}
          guess={props.guess}
          answer={props.guess && truth && jungler ? { ...truth, champion: jungler.champion } : null}
          onPick={frozen && !revealed ? props.onPick : undefined}
          highlight={revealed ? (moment.leak?.focus ?? moment.main?.context?.position ?? null) : null}
          minions={minionsAt(r.waves, t)}
        />
        <span className="rift-clock">{fmtTime(t)}</span>
        {vision && (
          <button className="rift-view" onClick={() => setView((v) => (v === "you" ? "all" : "you"))} title="Switch between your team's vision and everything">
            {view === "you" ? <><Eye size={13} /> Your vision</> : <><EyeOff size={13} /> Fog off: everything</>}
          </button>
        )}
        {frozen && !revealed && <span className="rift-frozen">{props.onPick ? `Click where ${props.drill} is` : "Frozen"}</span>}
        {off !== null && truth && (
          <span className={`rift-verdict ${off < 1500 ? "good" : off < 3000 ? "ok" : "bad"}`}>
            {off < 1500 ? "Spot on." : off < 3000 ? "Close." : "Missed."} {props.drill} was {describeSpot(truth, r.teamId)}
          </span>
        )}
        <MomentFacts r={r} moment={moment} compact />
      </div>
    </div>
  );
}

function MomentMap({ r, moment }: { r: GameReport; moment: Moment }) {
  const pos = moment.leak?.focus ?? moment.main?.context?.position;
  const size = 360;
  const [x, y] = pos ? [(pos.x / 14870) * size, (1 - pos.y / 14870) * size] : [size / 2, size / 2];
  return (
    <div className="stage-map">
      <svg viewBox={`0 0 ${size} ${size}`} className="map">
        <MapBackdrop size={size} />
        <circle cx={x} cy={y} r="30" className="pulse" />
        <path d={`M${x - 8},${y - 8}L${x + 8},${y + 8}M${x + 8},${y - 8}L${x - 8},${y + 8}`} className="map-death big" />
      </svg>
      <MomentFacts r={r} moment={moment} />
    </div>
  );
}

function MomentFacts({ r, moment, compact }: { r: GameReport; moment: Moment; compact?: boolean }) {
  const c = moment.main?.context;
  const gold = r.series.filter((p) => p.goldDiff !== null && Math.abs(p.minute * 60000 - moment.timeMs) <= 6 * 60000);
  return (
      <div className={compact ? "rift-hud" : "stage-facts"}>
        {!compact && <p className="eyebrow">At the moment</p>}
        {c?.goldDiff != null && (
          <p>
            <b className={c.goldDiff >= 0 ? "pos" : "neg"}>{c.goldDiff >= 0 ? "+" : ""}{Math.round(c.goldDiff)}g</b> vs {r.metrics.opponentChampion ?? "lane"}
          </p>
        )}
        {c?.currentGold != null && (
          <p>
            <b>{Math.round(c.currentGold)}g</b> unspent
          </p>
        )}
        {c && c.killers.length > 0 && (
          <p>
            Killed by <b>{c.killers.join(", ")}</b>
          </p>
        )}
        {c?.followedBy && (
          <p>
            Enemy took <b>{c.followedBy.name}</b> {c.followedBy.afterSec}s later
          </p>
        )}
        {!compact && gold.length > 2 && (
          <div className="mini-gold">
            <LineChart points={gold.map((p) => ({ x: p.minute, y: p.goldDiff! }))} height={90} format={(n) => `${n >= 0 ? "+" : ""}${Math.round(n)}`} xLabel={(v) => `${v}m`} markers={[{ x: Math.round(moment.timeMs / 60000), label: "✕" }]} />
          </div>
        )}
        {!compact && <p className="muted small">{r.track ? "Positions come from Riot's match data. Faded icons are estimates between known points." : "Sync again to see every champion on the map. Add a replay clip or your recording below to watch this moment here."}</p>}
      </div>
  );
}

function SourceBar(props: {
  r: GameReport;
  replay: ReplayState | null;
  vod: Vod | null | undefined;
  clips: Record<string, string> | null;
  busy: string | null;
  recording: TaskProgress | null;
  vodOffset: number;
  onVodOffset: (v: number) => void;
  onDownload: () => void;
  onWatch: () => void;
  onEnable: () => void;
  onRecord: () => void;
  onCancelRecord: () => void;
  onPickVod: () => void;
  reading: TaskProgress | null;
  onRead: () => void;
  onCancelRead: () => void;
}) {
  const { replay, vod, clips, busy, recording } = props;
  const clipCount = clips ? Object.keys(clips).length : 0;
  let status: React.ReactNode;
  let action: React.ReactNode = null;

  if (!replay) status = <><Spinner /> Checking the League client…</>;
  else if (recording) {
    status = <>Recording: {recording.label}</>;
    action = <Button size="sm" variant="ghost" onClick={props.onCancelRecord}>Stop</Button>;
  } else
    switch (replay.kind) {
      case "client-closed":
        status = "Open the League client to download and watch this replay.";
        break;
      case "unavailable":
        status = replay.reason;
        break;
      case "can-download":
        status = "Replay not downloaded yet.";
        action = <Button size="sm" variant="primary" loading={busy === "download"} onClick={props.onDownload}>Download replay</Button>;
        break;
      case "downloading":
        status = (
          <span className="dl">
            Downloading replay <ProgressBar value={replay.progress} thin />
          </span>
        );
        break;
      case "api-disabled":
        status = "Replay downloaded. To let the app jump to each moment, turn on League's replay control (one setting in game.cfg).";
        action = <Button size="sm" variant="primary" loading={busy === "enable"} onClick={props.onEnable}>Turn on replay control</Button>;
        break;
      case "ready":
        status = "Replay ready.";
        action = <Button size="sm" variant="primary" loading={busy === "watch"} onClick={props.onWatch}>Open replay</Button>;
        break;
      case "open":
        status = clipCount ? `Replay open. ${clipCount} clips saved.` : "Replay open. Record each moment as a clip to watch it here, inside the review.";
        action = <Button size="sm" variant="primary" loading={busy === "record"} onClick={props.onRecord}>{clipCount ? "Record missing clips" : "Record clips"}</Button>;
        break;
    }

  return (
    <section className="sources">
      <div className="source">
        <span className="source-icon"><Clapperboard size={16} /></span>
        <div className="source-body">
          <strong>League replay</strong>
          <small>{status}</small>
        </div>
        {action}
      </div>
      <div className="source">
        <span className="source-icon"><Waves size={16} /></span>
        <div className="source-body">
          <strong>Replay reading</strong>
          <small>
            {props.reading
              ? props.reading.label
              : props.r.wavesRead
                ? props.r.waves?.champs?.length ? "Read from the replay: minions, real paths, and what was on your minimap vs what was really there." : "Read from the replay. Recalls, farm and lane deaths quote real minion counts."
                : "Guessed from Riot's data. Read the replay to get real minion counts, real paths, and what was on your minimap at every moment. It plays fast on your screen (about 4 min). Don't touch it while it runs."}
          </small>
        </div>
        {props.reading ? (
          <Button size="sm" variant="ghost" onClick={props.onCancelRead}>Stop</Button>
        ) : (
          replay && replay.kind !== "client-closed" && replay.kind !== "unavailable" && (
            <Button size="sm" variant={props.r.wavesRead ? "ghost" : "primary"} loading={busy === "read"} onClick={props.onRead}>{props.r.wavesRead ? "Read again" : "Read the replay"}</Button>
          )
        )}
      </div>
      <div className="source">
        <span className="source-icon"><Video size={16} /></span>
        <div className="source-body">
          <strong>Your recording</strong>
          <small>{vod === undefined ? "Looking…" : vod ? vod.name : "No recording linked. Optional, if you record with OBS or Outplayed."}</small>
        </div>
        {vod && (
          <label className="offset" title="Shift if the video doesn't start when the game starts">
            Offset
            <input type="number" value={props.vodOffset} step={1} onChange={(e) => props.onVodOffset(Number(e.target.value))} />s
          </label>
        )}
        <Button size="sm" variant="ghost" loading={busy === "vod"} onClick={props.onPickVod}>{vod ? "Change" : "Link video"}</Button>
      </div>
    </section>
  );
}

function Summary({ r, reviewed, next, onNext, onPuzzles, onRestart }: { r: GameReport; reviewed: boolean; next: GameReport | null; onNext: (id: string) => void; onPuzzles: () => void; onRestart: () => void }) {
  const [count, setCount] = useState(next ? 6 : 0);
  useEffect(() => {
    if (!next || count <= 0) return;
    const t = setTimeout(() => (count === 1 ? onNext(next.metrics.matchId) : setCount(count - 1)), 1000);
    return () => clearTimeout(t);
  }, [count, next, onNext]);

  return (
    <section className="summary">
      <div className="summary-badge"><Check size={28} strokeWidth={3} /></div>
      <h2>Game reviewed</h2>
      <p className="muted">{reviewed ? "XP added." : ""} Take this into your next game:</p>
      <p className="summary-focus">{r.focus}</p>
      <div className="summary-actions">
        {next ? (
          <Button variant="primary" size="lg" onClick={() => onNext(next.metrics.matchId)}>
            Next: {next.metrics.champion} {count > 0 ? `in ${count}s` : ""}
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onPuzzles}>
            All caught up · Train with puzzles
          </Button>
        )}
        {next && count > 0 && (
          <Button variant="ghost" onClick={() => setCount(0)}>
            Stay here
          </Button>
        )}
        <Button variant="ghost" onClick={onRestart}>
          Watch again
        </Button>
      </div>
    </section>
  );
}

function GameStats({ r }: { r: GameReport }) {
  const m = r.metrics;
  const b = benchmarkFor(m.role);
  const rows: [string, string, string, boolean | null][] = [
    ["CS at 10", String(m.cs10), String(b.cs10), m.cs10 >= b.cs10],
    ["Gold at 15", m.goldDiff15 === null ? "–" : `${m.goldDiff15 >= 0 ? "+" : ""}${m.goldDiff15}`, "±0", m.goldDiff15 === null ? null : m.goldDiff15 >= 0],
    ["Early deaths", String(m.deathsPre14), b.deathsPre14.toFixed(1), m.deathsPre14 <= b.deathsPre14],
    ["Kill part.", `${Math.round(m.killParticipation * 100)}%`, `${Math.round(b.killParticipation * 100)}%`, m.killParticipation >= b.killParticipation],
    ["Vision/min", m.visionPerMin.toFixed(2), b.visionPerMin.toFixed(2), m.visionPerMin >= b.visionPerMin],
    r.recallWindows?.length
      ? ["Recall windows", `${r.recallWindows.filter((w) => w.taken).length} of ${r.recallWindows.length}`, "half+", r.recallWindows.filter((w) => w.taken).length * 2 >= r.recallWindows.length]
      : ["Dmg share", `${Math.round(m.damageShare * 100)}%`, "20%", m.damageShare >= 0.2],
  ];
  return (
    <section className="stats-section">
      <div className="stat-strip">
        {rows.map(([label, you, typ, good]) => (
          <div key={label} className={`stat ${good === true ? "good" : good === false ? "bad" : ""}`}>
            <small>{label}</small>
            <strong>{you}</strong>
            <span>typical {typ}</span>
          </div>
        ))}
      </div>
      <div className="grid-2 wide-left">
        <div className="panel">
          <div className="panel-head">
            <h3>Gold lead vs {m.opponentChampion ?? "lane opponent"}</h3>
          </div>
          <LineChart
            points={r.series.filter((p) => p.goldDiff !== null).map((p) => ({ x: p.minute, y: p.goldDiff! }))}
            format={(n) => `${n >= 0 ? "+" : ""}${Math.round(n)}`}
            xLabel={(x) => `${x}m`}
            markers={[...new Set(r.mistakes.map((x) => Math.round(x.timeMs / 60000)))].map((x, i) => ({ x, label: String(i + 1) }))}
          />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Deaths and kills</h3>
          </div>
          <DeathMap deaths={r.deathsAt} kills={r.killsAt} size={240} />
        </div>
      </div>
    </section>
  );
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

