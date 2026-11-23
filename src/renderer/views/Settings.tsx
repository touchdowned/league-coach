import { useState } from "react";
import { toast } from "sonner";
import { REGIONS } from "../../core/riot";
import { coach, Settings } from "../api";
import { Button } from "../ui";

export function SettingsView({ value, onSave }: { value: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [s, setS] = useState(value);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(value);

  async function pick(field: "leagueDir" | "vodDir") {
    const r = await coach().folderPick();
    if (r.ok && r.value) setS({ ...s, [field]: r.value });
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>Account and sources</h1>
          <p className="muted">Everything here stays on this PC.</p>
        </div>
      </header>

      <form
        className="panel form"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          await onSave(s);
          setSaving(false);
        }}
      >
        <h3>Riot account</h3>
        <div className="row-2">
          <label>
            Riot ID
            <input value={s.riotId} placeholder="Name#TAG" onChange={(e) => setS({ ...s, riotId: e.target.value })} />
          </label>
          <label>
            Region
            <select value={s.region} onChange={(e) => setS({ ...s, region: e.target.value })}>
              {Object.keys(REGIONS).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Riot API key
          <input type="password" value={s.apiKey} placeholder="RGAPI-…" onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
          <small>From developer.riotgames.com. Development keys expire every 24 hours; paste a new one when sync says so.</small>
        </label>
        <label>
          Games to analyze
          <input type="number" min={5} max={100} value={s.matchCount} onChange={(e) => setS({ ...s, matchCount: Number(e.target.value) })} />
          <small>50+ gives a more reliable plan and role verdict.</small>
        </label>

        <h3>Replays and recordings</h3>
        <label>
          League install folder
          <span className="input-row">
            <input value={s.leagueDir} onChange={(e) => setS({ ...s, leagueDir: e.target.value })} />
            <Button type="button" size="sm" onClick={() => pick("leagueDir")}>
              Browse
            </Button>
          </span>
          <small>Used to download replays and jump to each moment. Default: C:\Riot Games\League of Legends</small>
        </label>
        <div className="inline-action">
          <div>
            <strong>Replay control</strong>
            <small>Lets the app seek your replay and record clips. Adds EnableReplayApi=1 to League's game.cfg (a backup is kept).</small>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={async () => {
              const r = await coach().replayEnableApi();
              if (r.ok) toast.success("Replay control on");
              else toast.error("Couldn't change game.cfg", { description: r.error });
            }}
          >
            Turn on
          </Button>
        </div>
        <label>
          Recordings folder (optional)
          <span className="input-row">
            <input value={s.vodDir} placeholder="e.g. C:\Users\you\Videos\Outplayed" onChange={(e) => setS({ ...s, vodDir: e.target.value })} />
            <Button type="button" size="sm" onClick={() => pick("vodDir")}>
              Browse
            </Button>
          </span>
          <small>If you record games with OBS or Outplayed, the app matches each video to its game.</small>
        </label>

        <h3>Review</h3>
        <label>
          Seconds per moment
          <input type="number" min={6} max={60} value={s.autoAdvanceSec} onChange={(e) => setS({ ...s, autoAdvanceSec: Number(e.target.value) })} />
          <small>How long guided review stays on a moment before moving on (clips advance when they end).</small>
        </label>

        <div className="form-foot">
          <Button variant="primary" type="submit" loading={saving} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
