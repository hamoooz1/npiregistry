import { useState, useEffect } from "react";

export default function App() {
  const [digitCode, setDigitCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pickedLocation, setPickedLocation] = useState("");
  const [indexPreview, setIndexPreview] = useState("");
  const [jsonPreview, setJsonPreview] = useState("");
  const [matchData, setMatchData] = useState(null);
  const [providerRefs, setProviderRefs] = useState(null);
  const [selectedProviderRef, setSelectedProviderRef] = useState("");
  const [npiList, setNpiList] = useState([]); // numbers


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
    setSelectedProviderRef("");
    setNpiList([]);
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

  async function onSelectProviderRef(e) {
    const val = e.target.value;
    setSelectedProviderRef(val);
    setNpiList([]);

    if (!val) return;

    try {
      setStatus(`Fetching NPIs for ${val}…`);
      const resp = await fetch(`/api/provider-npis?ids=${encodeURIComponent(val)}&debug=1`);
      let payload;
      try {
        payload = await resp.json();
      } catch {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status} — ${txt}`);
      }
      if (!resp.ok) throw new Error(payload?.error || `HTTP ${resp.status}`);

      const npis = payload?.by_id?.[val]?.npis || [];
      setNpiList(npis);
      setStatus(`Loaded NPIs for ${val}`);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus("");
    }
  }

  const go = async () => {
    setSelectedProviderRef("");
    setNpiList([]);


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
              try { const j = await filterRes.json(); if (j?.error) msg += ` — ${j.error}`; } catch { }
              throw new Error(msg);
            }
            const { match, provider_references } = await filterRes.json();
            setMatchData(match);
            setProviderRefs(provider_references);
            setJsonPreview(prettyPreview(match));
            // populate picklists
            setupPicklistsForMatch(match);
            setSelectedProviderRef("");
            setNpiList([]);
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
        try { const j = await filterRes2.json(); if (j?.error) msg += ` — ${j.error}`; } catch { }
        throw new Error(msg);
      }

      const { match: match2, provider_references: providerRefs2 } = await filterRes2.json();
      setMatchData(match2);
      setProviderRefs(providerRefs2);
      setJsonPreview(prettyPreview(match2));
      // populate picklists
      setupPicklistsForMatch(match2);
      setSelectedProviderRef("");
      setNpiList([]);
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
          <>
            <select
              value={selectedProviderRef}
              onChange={onSelectProviderRef}
            >
              <option value="">— Select a provider reference —</option>
              {providerRefOptions.map((ref, i) => (
                <option key={i} value={String(ref)}>{String(ref)}</option>
              ))}
            </select>

            <div style={{ marginTop: 8 }}>
              <strong>NPIs:</strong>{" "}
              {npiList.length
                ? `${npiList.length} found`
                : selectedProviderRef
                  ? "— none —"
                  : "— pick a provider reference —"}
            </div>

            {npiList.length > 0 && (
            <pre className="mono small" style={{ maxHeight: 180 }}>
              {JSON.stringify(npiList, null, 2)}
            </pre>
            )}
          </>
        ) : (
          <div className="mono small">— No provider references on this rate —</div>
        )}
      </section>

      <NpiCards npiList={npiList} />
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
  .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 8px; }
.card { border: 1px solid #eee; border-radius: 10px; padding: 12px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
.card.error { border-color: #f4c7c7; background: #fff8f8; }
.title { font-weight: 600; margin-bottom: 2px; }
.muted { color: #666; font-size: 12px; margin-bottom: 8px; }
.line { display: grid; grid-template-columns: 110px 1fr; gap: 8px; margin: 4px 0; }
.label { color: #555; font-size: 12px; }
.err { color: #b00020; font-size: 13px; }

`;

function NpiCards({ npiList }) {
  const [entries, setEntries] = useState({});   // { "1234567890": resultObject|null }
  const [errors, setErrors] = useState({});     // { "1234567890": "error msg" }
  const [pending, setPending] = useState(0);

  // fetch with modest concurrency and caching per render
  useEffect(() => {
    const numbers = Array.from(new Set((npiList || []).map(n => String(n).padStart(10, "0"))));
    if (!numbers.length) {
      setEntries({});
      setErrors({});
      setPending(0);
      return;
    }

    let cancelled = false;
    setEntries({});
    setErrors({});
    setPending(numbers.length);

    const CONCURRENCY = 6;
    let cursor = 0;

    const runNext = async () => {
      if (cancelled) return;
      const i = cursor++;
      if (i >= numbers.length) return;

      const npi = numbers[i];
      try {
        const resp = await fetch(`/api/npi?number=${encodeURIComponent(npi)}`);
        let data;
        try {
          data = await resp.json();
        } catch {
          const txt = await resp.text();
          throw new Error(`HTTP ${resp.status} — ${txt.slice(0, 200)}`);
        }
        if (!resp.ok) {
          throw new Error(data?.Errors?.[0]?.description || data?.error || `HTTP ${resp.status}`);
        }
        const result = Array.isArray(data?.results) ? data.results[0] : null;
        setEntries(prev => ({ ...prev, [npi]: result }));
      } catch (e) {
        setErrors(prev => ({ ...prev, [npi]: e.message || String(e) }));
      } finally {
        setPending(p => p - 1);
        runNext(); // kick the next in queue
      }
    };

    // start workers
    for (let k = 0; k < Math.min(CONCURRENCY, numbers.length); k++) runNext();

    return () => { cancelled = true; };
  }, [npiList]);

  const numbers = Object.keys(entries).length || Object.keys(errors).length
    ? Array.from(new Set((npiList || []).map(n => String(n).padStart(10, "0"))))
    : [];

  return (
    <section>
      <h2>NPI Profiles {pending > 0 ? `(loading ${pending}…)` : ""}</h2>
      {!numbers.length ? (
        <div className="mono small">— Provide NPIs —</div>
      ) : (
        <div className="card-grid">
          {numbers.map(npi => (
            <NpiCard key={npi} npi={npi} result={entries[npi]} error={errors[npi]} />
          ))}
        </div>
      )}
    </section>
  );
}

function NpiCard({ npi, result, error }) {
  if (error) {
    return (
      <div className="card error">
        <div className="muted">NPI {npi}</div>
        <div className="err">{error}</div>
      </div>
    );
  }
  if (result === undefined) {
    return (
      <div className="card">
        <div className="muted">NPI {npi}</div>
        <div>Loading…</div>
      </div>
    );
  }
  if (result === null) {
    return (
      <div className="card">
        <div className="muted">NPI {npi}</div>
        <div>Not found.</div>
      </div>
    );
  }

  // shape the data
  const basic = result.basic || {};
  const name =
    basic.organization_name ||
    [basic.first_name, basic.middle_name, basic.last_name].filter(Boolean).join(" ") ||
    `NPI ${npi}`;
  const credential = basic.credential;
  const enumDate = basic.enumeration_date;
  const lastUpdated = basic.last_updated;

  const tax = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  const primaryTax = tax.find(t => t.primary) || tax[0];
  const taxLine = primaryTax
    ? `${primaryTax.desc || primaryTax.code}${primaryTax.state ? ` — ${primaryTax.state}` : ""}${primaryTax.license ? ` — Lic ${primaryTax.license}` : ""}`
    : "—";

  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const loc = addresses.find(a => a.address_purpose === "LOCATION") || addresses[0];
  const addr = loc
    ? `${loc.address_1 || ""}${loc.address_2 ? `, ${loc.address_2}` : ""}, ${loc.city || ""}, ${loc.state || ""} ${loc.postal_code || ""}`
    : "—";
  const phone = loc?.telephone_number || "—";
  const fax = loc?.fax_number || "";

  return (
    <div className="card">
      <div className="title">{name}{credential ? `, ${credential}` : ""}</div>
      <div className="muted">NPI {npi} • {basic.status || "—"}</div>
      <div className="line"><span className="label">Taxonomy</span><span>{taxLine}</span></div>
      <div className="line"><span className="label">Location</span><span>{addr}</span></div>
      <div className="line"><span className="label">Phone</span><span>{phone}{fax ? ` • Fax ${fax}` : ""}</span></div>
      <div className="line"><span className="label">Enumerated</span><span>{enumDate || "—"}</span></div>
      <div className="line"><span className="label">Last updated</span><span>{lastUpdated || "—"}</span></div>
    </div>
  );
}
