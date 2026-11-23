import { useEffect, useState } from "react";
import type { GameReport } from "../../core/types";
import { coach } from "../api";
import { ProgressProvider } from "../progress";
import { Walkthrough } from "./Walkthrough";

/** Root of the transparent overlay window drawn over the League replay. */
export function OverlayRoot({ matchId }: { matchId: string }) {
  const [r, setR] = useState<GameReport | null>(null);
  useEffect(() => {
    coach()
      .listGames()
      .then((gs) => setR(gs.find((g) => g.metrics.matchId === matchId) ?? null));
  }, [matchId]);
  if (!r) return null;
  return (
    <ProgressProvider>
      <Walkthrough r={r} source="replay" onExit={() => coach().overlayClose(false)} onFinished={() => coach().overlayClose(true)} />
    </ProgressProvider>
  );
}
