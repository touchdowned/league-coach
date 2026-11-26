/**
 * The game's minimap ward icons, fetched from CommunityDragon the first time they're needed
 * and cached under userData (never shipped or committed). If they can't be had, the reader
 * falls back to the star rule alone (no ward kinds, no control wards).
 */
import { app, nativeImage, net } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import { bgraToRgba, wardTemplate, type WardKind, type WardTemplate } from "../core/minimap";

const BASE = "https://raw.communitydragon.org/latest/game/assets/ux/minimap/icons/";
/** Icon file → kind. Both teams use the same shapes; the reader matches them against each team's colour. */
export const WARD_ICONS: [string, WardKind][] = [
  ["minimap_ward_green_full.png", "stealth"],
  ["minimap_ward_green_low.png", "stealth_low"],
  ["minimap_jammer_friendly.png", "control"],
  ["minimap_jammer_enemy.png", "control"],
];

let cached: Promise<WardTemplate[]> | null = null;

/** Templates for every icon that could be had (possibly none). `dir` overrides the cache folder. */
export function wardTemplates(dir = path.join(app.getPath("userData"), "minimap-icons")): Promise<WardTemplate[]> {
  cached ??= (async () => {
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
    const out: WardTemplate[] = [];
    for (const [file, kind] of WARD_ICONS) {
      const local = path.join(dir, file);
      let buf = await fs.readFile(local).catch(() => null);
      if (!buf) {
        try {
          const res = await net.fetch(BASE + file);
          if (res.ok) {
            buf = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(local, buf).catch(() => undefined);
          }
        } catch {
          /* offline: this icon is skipped */
        }
      }
      if (!buf) continue;
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) continue;
      const { width, height } = img.getSize();
      const data = new Uint8ClampedArray(img.toBitmap());
      bgraToRgba(data);
      out.push(wardTemplate(kind, { w: width, h: height, data }));
    }
    return out;
  })();
  return cached;
}
