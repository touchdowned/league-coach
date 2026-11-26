import { promises as fs } from "fs";
import path from "path";

const VIDEO = /\.(mp4|mkv|webm|mov)$/i;

export interface VodFile {
  path: string;
  name: string;
  modifiedMs: number;
  sizeMb: number;
}

/** Lists video files in a folder (one level of subfolders, since recorders often sort by date). */
export async function listVods(dir: string): Promise<VodFile[]> {
  const out: VodFile[] = [];
  async function scan(d: string, depth: number) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 1) await scan(p, depth + 1);
      else if (e.isFile() && VIDEO.test(e.name)) {
        const st = await fs.stat(p);
        out.push({ path: p, name: e.name, modifiedMs: st.mtimeMs, sizeMb: Math.round(st.size / 1e6) });
      }
    }
  }
  await scan(dir, 0);
  return out;
}

/**
 * Picks the recording for a game: a file named with the match/game id, or else the
 * file whose last write is closest to when the game ended (within 45 minutes).
 */
export function matchVod(files: VodFile[], matchId: string, gameStartMs: number, durationSec: number): VodFile | null {
  const gameId = matchId.split("_").pop() ?? matchId;
  const named = files.find((f) => f.name.includes(gameId));
  if (named) return named;
  const end = gameStartMs + durationSec * 1000;
  let best: VodFile | null = null;
  let bestGap = 45 * 60_000;
  for (const f of files) {
    const gap = Math.abs(f.modifiedMs - end);
    if (gap < bestGap) {
      best = f;
      bestGap = gap;
    }
  }
  return best;
}
