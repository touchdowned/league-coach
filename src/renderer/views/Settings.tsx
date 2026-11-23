import { useState } from "react";
import { REGIONS } from "../../core/riot";
import type { Settings } from "../api";

export function SettingsView({ value, onSave }: { value: Settings; onSave: (s: Settings) => void }) {
  const [s, setS] = useState(value);
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Everything here is saved only on this PC.</p>
        </div>
      </div>
      <form
        className="card settings"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(s);
        }}
      >
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
        <label>
          Riot API key
          <input type="password" value={s.apiKey} placeholder="RGAPI-…" onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
          <small className="muted">Get a free key at developer.riotgames.com. Development keys expire every 24 hours, so paste a new one when sync says it expired.</small>
        </label>
        <label>
          Games to load
          <input type="number" min={5} max={100} value={s.matchCount} onChange={(e) => setS({ ...s, matchCount: Number(e.target.value) })} />
          <small className="muted">More games give a better profile and role verdict. 50+ is ideal.</small>
        </label>
        <button className="primary" type="submit">
          Save
        </button>
      </form>
    </div>
  );
}
