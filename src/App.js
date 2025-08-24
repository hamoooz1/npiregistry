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

  // NEW: picklist state lives in component
  const [rateOptions, setRateOptions] = useState([]);          // [{ idx, price, label }]
  const [selectedRateIdx, setSelectedRateIdx] = useState("");  // string index into negotiated_rates
  const [providerRefOptions, setProviderRefOptions] = useState([]); // numbers for chosen rate

  // --- Helpers that touch state MUST be inside the component ---
  function buildRateOptions(match) {
    const out = [];
    const nrs = Array.isArray(match?.negotiated_rates) ? match.negotiated_rates : [];
    nrs.forEach((nr, idx) => {
      const np = Array.isArray(nr?.negotiated_prices) ? nr.negotiated_prices : [];
      const price = np[0]?.negotiated_rate;
      if (price !== undefined && price !== null) {
        out.push({ idx, price, label: String(price) });
      }
    });
    return out;
  }

  function setupPicklistsForMatch(match) {
    const rates = buildRateOptions(match);
    setRateOptions(rates);
    setSelectedRateIdx("");     // no preselect
    setProviderRefOptions([]);  // clear until user picks a rate
  }

  function onSelectRate(e) {
    const val = e.target.value;       // string index
    setSelectedRateIdx(val);
    const idx = Number(val);
    const nr = matchData?.negotiated_rates?.[idx];
    const refs = Array.isArray(nr?.provider_references) ? nr.provider_references : [];
    setProviderRefOptions(refs);
    // If you also want to mirror into providerRefs:
    // setProviderRefs(refs);
  }

  const go = async () => {
    if (window.__GO_BUSY) return;
    window.__GO_BUSY = true;

    setError("");
    setStatus("Checking cache…");
    setPickedLocation("");
    setIndexPreview("");
    setJsonPreview("");
    setMatchData(null);
    setProviderRefs(null);
    setRateOptions([]);
    setSelectedRateIdx("");
    setProviderRefOptions([]);

    const buildFilterUrl = (code) =>
      `/api/filter-by-code?digitCode=${encodeURIComponent(code)}&debug=1&first=1`; // using first match for now

    try {
      if (!/^[\d]+$/.test(digitCode)) {
        throw new Error("Enter a numeric digit code (digits only).");
      }

      // 1) Use cached decompressed file if present
      try {
        const metaRes = await fetch("/api/decompressed-meta");
        if (metaRes.ok) {
          const meta = await metaRes.json();
          if (meta.exists) {
            setPickedLocation("(cached: /tmp/decompressed.json)");
            setStatus("Filtering cached file (first match) …");
            const filterRes = await fetch(buildFilterUrl(digitCode));
            if (!filterRes.ok) {
              let msg = `Filtering failed: HTTP ${filterRes.status}`;
              try { const j = await filterRes.json(); if (j?.error) msg += ` — ${j.error}`; } catch {}
              throw new Error(msg);
            }
            const { match, provider_references } = await filterRes.json();
            setMatchData(match);
            setProviderRefs(provider_references);
            setJsonPreview(prettyPreview(match));
            // populate picklists
            setupPicklistsForMatch(match);
            setStatus("Done. Data filtered from cache (first match).");
            return;
          }
        }
      } catch {
        // fall through to full flow
      }

      // 2) Full flow
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

      setStatus("Filtering decompressed data (first match) …");
      const filterRes2 = await fetch(buildFilterUrl(digitCode));
      if (!filterRes2.ok) {
        let msg = `Filtering failed: HTTP ${filterRes2.status}`;
        try { const j = await filterRes2.json(); if (j?.error) msg += ` — ${j.error}`; } catch {}
        throw new Error(msg);
      }

      const { match: match2, provider_references: providerRefs2 } = await filterRes2.json();
      setMatchData(match2);
      setProviderRefs(providerRefs2);
      setJsonPreview(prettyPreview(match2));
      // populate picklists
      setupPicklistsForMatch(match2);

      setStatus("Done. Data filtered.");
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setStatus("");
    } finally {
      window.__GO_BUSY = false;
    }
  };

  return (
    <div className="wrap">
      <h1>Step 1 — Fetch Blue Essentials In-Network JSON</h1>

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
        <h2>Pick a negotiated rate</h2>
        {rateOptions.length ? (
          <select value={selectedRateIdx} onChange={onSelectRate}>
            <option value="">— Select a rate —</option>
            {rateOptions.map((o) => (
              <option key={o.idx} value={o.idx}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="mono small">— No negotiated rates found —</div>
        )}
      </section>

      <section>
        <h2>Provider references for selected rate</h2>
        {selectedRateIdx === "" ? (
          <div className="mono small">— Pick a rate above —</div>
        ) : providerRefOptions.length ? (
          <select multiple size={Math.min(10, Math.max(5, providerRefOptions.length))}>
            {providerRefOptions.map((ref, i) => (
              <option key={i} value={String(ref)}>{String(ref)}</option>
            ))}
          </select>
        ) : (
          <div className="mono small">— No provider references on this rate —</div>
        )}
      </section>

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

// --- Non-state helpers can stay outside ---
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
