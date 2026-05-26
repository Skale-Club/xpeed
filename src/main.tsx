import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./lib/i18n";

// When a new Vercel deployment lands, hashed JS chunks from the previous build
// are no longer served. Lazy-imported routes fail with a MIME-type error.
// Catching this Vite event and reloading fetches the new index.html, which
// references the correct chunk hashes.
window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);
