import { useEffect } from "react";
import { coach } from "./api";

/**
 * The overlay window lets the mouse through to League except over our own panels. The panels
 * (anything marked data-hit) report where they are, and the main process compares the cursor
 * against them: mouse-enter events can't be relied on, because Windows doesn't forward the
 * pointer to an ignored window while the League window under it is the active one.
 */
export function useOverlayHits(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let last = "";
    const report = () => {
      const rects = Array.from(document.querySelectorAll<HTMLElement>("[data-hit]"))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
      const key = JSON.stringify(rects);
      if (key === last) return;
      last = key;
      coach().overlayRects?.(rects);
    };
    report();
    const id = setInterval(report, 120);
    return () => {
      clearInterval(id);
      coach().overlayRects?.([]);
    };
  }, [active]);
}

export const hitMark = { "data-hit": "" };
