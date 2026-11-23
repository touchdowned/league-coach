import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DraftApp } from "./overlay/Draft";
import { OverlayApp } from "./overlay/Overlay";
import "./styles.css";

// One bundle, three windows: the app, the in-game overlay and the champ-select card.
const view = location.hash.replace("#", "");
createRoot(document.getElementById("root")!).render(view === "overlay" ? <OverlayApp /> : view === "draft" ? <DraftApp /> : <App />);
