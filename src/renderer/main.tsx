import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DraftApp } from "./overlay/Draft";
import { OverlayApp } from "./overlay/Overlay";
import { OverlayRoot } from "./views/Overlay";
import { FindingOverlay } from "./views/FindingOverlay";
import "./styles.css";

// One bundle, four windows: the app, the coaching overlay over a replay (#overlay/<matchId>),
// the in-game mental overlay (#live-overlay) and the champ-select card (#draft).
const view = location.hash.replace("#", "");
const replayOverlay = view.match(/^overlay\/(.+)$/);
const findingOverlay = view.match(/^finding\/([^/]+)\/(.+)$/);
if (replayOverlay || findingOverlay) document.documentElement.classList.add("overlay-doc");
createRoot(document.getElementById("root")!).render(
  findingOverlay ? <FindingOverlay matchId={decodeURIComponent(findingOverlay[1])} findingId={decodeURIComponent(findingOverlay[2])} />
  : replayOverlay ? <OverlayRoot matchId={decodeURIComponent(replayOverlay[1])} />
  : view === "live-overlay" ? <OverlayApp />
  : view === "draft" ? <DraftApp />
  : <App />,
);
