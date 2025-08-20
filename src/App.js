import { useState } from "react";
import { inflate } from "pako";

export default function App() {
  const [digitCode, setDigitCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pickedLocation, setPickedLocation] = useState("");
  const [indexPreview, setIndexPreview] = useState("");
  const [jsonPreview, setJsonPreview] = useState("");

  const go = async () => {
    setError("");
    setStatus("Fetching index URL…");
    setPickedLocation("");
    setIndexPreview("");
    setJsonPreview("");
  
    try {
      if (!/^\d+$/.test(digitCode)) throw new Error("Enter a numeric digit code (digits only).");
  
      // 1) Get the Index JSON URL from backend
      const res = await fetch("/api/get-index-url");
      const data = await res.json();
      if (!data.indexUrl) throw new Error("Could not fetch index URL from BCBSTX site.");
      const indexUrl = data.indexUrl;
  
      // 2) Fetch the JSON index
      setStatus("Downloading index JSON…");
      const idxRes = await fetch(`/api/proxy-index?url=${encodeURIComponent(indexUrl)}`);
      if (!idxRes.ok) throw new Error(`Index request failed: HTTP ${idxRes.status}`);
      const idx = await idxRes.json();
      setIndexPreview(prettyPreview(idx));
  
      // 3) Find the in-network file
      setStatus('Locating "Blue Essentials in-network file"…');
      const location = findBlueEssentialsLocation(idx);
      if (!location) throw new Error('Could not find description "Blue Essentials in-network file".');
      setPickedLocation(location);
  
      // 4) Download and stream preview via backend
      setStatus("Streaming decompressed JSON preview…");
      const proxyRes = await fetch(`/api/fetch-gz?url=${encodeURIComponent(location)}`);
      if (!proxyRes.ok) throw new Error(`Backend fetch failed: HTTP ${proxyRes.status}`);
  
      // 5) Stream the response — read first ~100 KB
      const reader = proxyRes.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let result = "";
      let done = false;
  
      while (!done && result.length < 100000) {
        const { value, done: readerDone } = await reader.read();
        if (value) result += decoder.decode(value, { stream: true });
        done = readerDone;
      }
  
      const preview = result.slice(0, 5000) + (result.length > 5000 ? "\n…(truncated)…" : "");
      setJsonPreview(preview);
  
      // 6) Optional: trigger full download
      // Uncomment if you want to save full previewed chunk
      // downloadFile(`Blue-Essentials_in-network.json`, result, "application/json");
  
      setStatus("Done. Preview ready.");
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setStatus("");
    }
  };
  

  return (
    <div className="wrap">
      <h1>Step 1 — Fetch Blue Essentials In‑Network JSON</h1>

      <div className="row">
        <label>Digit code</label>
        <input
          value={digitCode}
          onChange={(e) => setDigitCode(e.target.value)}
          placeholder="e.g., 33602"
          inputMode="numeric"
          pattern="[0-9]*"
        />
        <button onClick={go}>Go</button>
      </div>

      {status && <div className="status">{status}</div>}
      {error && <div className="error">Error: {error}</div>}

      <section>
        <h2>Matched .json.gz location</h2>
        <pre className="mono small">{pickedLocation || "—"}</pre>
      </section>

      <section>
        <h2>Index JSON — preview</h2>
        <pre className="mono small">{indexPreview || "—"}</pre>
      </section>

      <section>
        <h2>Decompressed JSON — preview</h2>
        <pre className="mono">{jsonPreview || "—"}</pre>
      </section>

      <style>{css}</style>
    </div>
  );
}

// --- Helpers ---
function findBlueEssentialsLocation(idx) {
  if (!idx || !Array.isArray(idx.reporting_structure)) return null;
  for (const s of idx.reporting_structure) {
    const files = s?.in_network_files;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (f?.description === "Blue Essentials in-network file" && f?.location) {
        return f.location;
      }
    }
  }
  return null;
}

function prettyPreview(obj) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
    return s.length > 5000 ? s.slice(0, 5000) + "\n…(truncated)…" : s;
  } catch {
    return String(obj).slice(0, 5000);
  }
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Inline CSS ---
const css = `
  .wrap { max-width: 980px; margin: 32px auto; padding: 16px; font-family: system-ui, sans-serif; }
  h1 { font-size: 22px; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 16px 0 8px; }
  .row { display: grid; grid-template-columns: 140px 1fr auto; gap: 8px; align-items: center; margin: 10px 0; }
  input { padding: 8px; border: 1px solid #ddd; border-radius: 6px; }
  button { padding: 8px 12px; border: 1px solid #222; border-radius: 6px; cursor: pointer; background: #111; color: #fff; }
  .status { margin: 8px 0; color: #0366d6; }
  .error { margin: 8px 0; color: #b00020; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 10px; overflow: auto; }
  .small { font-size: 12px; }
  pre { max-height: 360px; }
`;
