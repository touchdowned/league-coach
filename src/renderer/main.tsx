import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OverlayRoot } from "./views/Overlay";
import "./styles.css";

// The coaching overlay over the League replay loads this same bundle at #overlay/<matchId>.
const overlay = location.hash.match(/^#overlay\/(.+)$/);
if (overlay) document.documentElement.classList.add("overlay-doc");
createRoot(document.getElementById("root")!).render(overlay ? <OverlayRoot matchId={decodeURIComponent(overlay[1])} /> : <App />);
