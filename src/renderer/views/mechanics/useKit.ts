import { useEffect, useState } from "react";
import { DdChampion, kitFromDdragon, offlineKit, speedsFromCdragon } from "../../../core/mechanics/data";
import type { Kit } from "../../../core/mechanics/kits";

const DD = "https://ddragon.leagueoflegends.com";
const CDRAGON = "https://raw.communitydragon.org/latest/game/data/characters";

let version: Promise<string> | null = null;
export function ddVersion(): Promise<string> {
  version ??= fetch(`${DD}/api/versions.json`)
    .then((r) => r.json())
    .then((list: string[]) => list[0])
    .catch(() => "15.1.1");
  return version;
}

export const spellIcon = (v: string, file: string) => `${DD}/cdn/${v}/img/spell/${file}`;

const cache = new Map<string, Promise<Kit | null>>();

function stored(key: string): Kit | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Kit) : null;
  } catch {
    return null;
  }
}

function store(key: string, kit: Kit) {
  try {
    localStorage.setItem(key, JSON.stringify(kit));
  } catch {
    /* storage full or blocked: we'll refetch next time */
  }
}

/**
 * Loads a champion's kit: Data Dragon for names, icons and cooldowns, Community
 * Dragon for missile speeds, curated shapes from kits.ts. Cached per patch.
 * Falls back to the curated table alone when offline.
 */
export function loadKit(champion: string): Promise<Kit | null> {
  let p = cache.get(champion);
  if (p) return p;
  p = (async () => {
    const v = await ddVersion();
    const key = `lc.kit2.${v}.${champion}`;
    const hit = stored(key);
    if (hit) return hit;
    try {
      const res = await fetch(`${DD}/cdn/${v}/data/en_US/champion/${champion}.json`);
      if (!res.ok) throw new Error(String(res.status));
      const dd = (await res.json()).data[champion] as DdChampion;
      const lower = champion.toLowerCase();
      const bin = await fetch(`${CDRAGON}/${lower}/${lower}.bin.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const kit = kitFromDdragon(dd, bin ? speedsFromCdragon(bin, champion) : undefined);
      store(key, kit);
      return kit;
    } catch {
      cache.delete(champion);
      return offlineKit(champion);
    }
  })();
  cache.set(champion, p);
  return p;
}

export function useKit(champion: string | null): { kit: Kit | null; loading: boolean } {
  const [state, setState] = useState<{ kit: Kit | null; loading: boolean; for: string | null }>({ kit: null, loading: !!champion, for: null });
  useEffect(() => {
    if (!champion) return;
    let live = true;
    setState({ kit: null, loading: true, for: champion });
    loadKit(champion).then((kit) => live && setState({ kit, loading: false, for: champion }));
    return () => {
      live = false;
    };
  }, [champion]);
  return { kit: state.for === champion ? state.kit : null, loading: state.for !== champion || state.loading };
}

export function useDdVersion(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    ddVersion().then(setV);
  }, []);
  return v;
}
