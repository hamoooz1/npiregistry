import { useState } from "react";

export default function App() {
  const [digitCode, setDigitCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pickedLocation, setPickedLocation] = useState("");
  const [indexPreview, setIndexPreview] = useState("");
  const [jsonPreview, setJsonPreview] = useState("");
  const [matchData, setMatchData] = useState(null);
  const [providerRefs, setProviderRefs] = useState(null);

  const go = async () => {
  setError("");
  setStatus("Checking cache…");
  setPickedLocation("");
  setIndexPreview("");
  setJsonPreview("");
  setMatchData(null);
  setProviderRefs(null);

  try {
    if (!/^[\d]+$/.test(digitCode)) {
      throw new Error("Enter a numeric digit code (digits only).");
    }

    // 1) If we already have /tmp/decompressed.json on the server, skip straight to filtering.
    try {
      const metaRes = await fetch("/api/decompressed-meta");
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta.exists) {
          setPickedLocation("(cached: /tmp/decompressed.json)");
          setStatus("Filtering cached file…");
          const filterRes = await fetch(`/api/filter-by-code?digitCode=${encodeURIComponent(digitCode)}`);
          if (!filterRes.ok) throw new Error(`Filtering failed: HTTP ${filterRes.status}`);
          const { match, provider_references } = await filterRes.json();
          setMatchData(match);
          setProviderRefs(provider_references);
          setJsonPreview(prettyPreview(match));
          setStatus("Done. Data filtered from cache.");
          return; // ✅ we're done; no need to hit index/decompress
        }
      }
    } catch {
      // If the cache check fails for any reason, fall through to full flow.
    }

    // 2) Full flow (no cache): fetch index → find Blue Essentials file → decompress → filter.
    setStatus("Fetching index URL…");
    const res = await fetch("/api/get-index-url");
    const data = await res.json();
    if (!data.indexUrl) throw new Error("Could not fetch index URL from BCBSTX site.");
    const indexUrl = data.indexUrl;

    setStatus("Downloading index JSON…");
    const idxRes = await fetch(`/api/proxy-index?url=${encodeURIComponent(indexUrl)}`);
    if (!idxRes.ok) throw new Error(`Index request failed: HTTP ${idxRes.status}`);
    const idx = await idxRes.json();
    setIndexPreview(prettyPreview(idx));

    setStatus('Locating "Blue Essentials in-network file"…');
    const location = findBlueEssentialsLocation(idx);
    if (!location) throw new Error('Could not find description "Blue Essentials in-network file".');
    setPickedLocation(location);

    setStatus("Decompressing file on server…");
    const decompressRes = await fetch(`/api/decompress?url=${encodeURIComponent(location)}`);
    if (!decompressRes.ok) throw new Error(`Decompression failed: HTTP ${decompressRes.status}`);
    await decompressRes.json();

    setStatus("Filtering decompressed data…");
    const filterRes = await fetch(`/api/filter-by-code?digitCode=${encodeURIComponent(digitCode)}`);
    if (!filterRes.ok) throw new Error(`Filtering failed: HTTP ${filterRes.status}`);

    const { match, provider_references } = await filterRes.json();
    setMatchData(match);
    setProviderRefs(provider_references);
    setJsonPreview(prettyPreview(match));

    setStatus("Done. Data filtered.");
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
        <h2>Filtered Result (in_network)</h2>
        <pre className="mono small">{jsonPreview || "—"}</pre>
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