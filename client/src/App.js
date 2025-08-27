import React, { useState, useEffect, useRef } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "";

/* ───────────────────────────────
   Tiny UI atoms
   ─────────────────────────────── */

function LoadingSpinner({ size = 18, stroke = 3 }) {
  return (
    <span
      className="spinner"
      role="status"
      aria-live="polite"
      aria-label="Loading"
      style={{ width: size, height: size, borderWidth: stroke }}
    />
  );
}

function StatusBar({ busy, text, error }) {
  if (!text && !error) return null;
  return (
    <div className={`statusbar ${error ? "error" : ""}`}>
      {busy && <LoadingSpinner size={16} stroke={2} />}
      <span className="status-text">{error ? `Error: ${String(error)}` : text}</span>
    </div>
  );
}

/* ───────────────────────────────
   Fancy Multi-Select Dropdown
   ─────────────────────────────── */

function MultiSelectDropdown({
  options = [],        // array of strings
  value = [],          // array of strings
  onChange,            // (array<string>) => void
  placeholder = "Filter by Provider Ref",
  maxMenuHeight = 260,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  // close on outside click / Esc
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const allSelected = value.length && value.length === options.length;
  const someSelected = value.length > 0 && !allSelected;

  function toggleOne(opt) {
    const exists = value.includes(opt);
    const next = exists ? value.filter((v) => v !== opt) : [...value, opt];
    onChange?.(next);
  }
  function selectAll() {
    onChange?.(options.slice());
  }
  function clearAll() {
    onChange?.([]);
  }


  return (
    <div className={`msd ${disabled ? "disabled" : ""}`} ref={boxRef}>
      <button
        type="button"
        className={`msd-btn ${open ? "open" : ""}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="msd-label">
          {value.length === 0 && <span className="msd-placeholder">{placeholder}</span>}
          {value.length > 0 && (
            <>
              {placeholder}
              <span className="msd-count">{value.length}</span>
            </>
          )}
        </span>
        <svg className={`msd-caret ${open ? "up" : "down"}`} width="16" height="16" viewBox="0 0 24 24">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open && (
        <div className="msd-menu" style={{ maxHeight: maxMenuHeight }}>
          <div className="msd-actions">
            <button className="chip" onClick={selectAll} disabled={options.length === 0}>
              Select all
            </button>
            <button className="chip ghost" onClick={clearAll} disabled={value.length === 0}>
              Clear
            </button>
          </div>
          <div className="msd-list">
            {options.length === 0 ? (
              <div className="msd-empty muted small">No provider references</div>
            ) : (
              options.map((opt) => {
                const checked = value.includes(opt);
                return (
                  <div
                    key={opt}
                    className={`msd-item ${checked ? "checked" : ""}`}
                    onClick={() => toggleOne(opt)}
                    role="option"
                    aria-selected={checked}
                    tabIndex={0}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleOne(opt)}
                  >
                    <span className={`checkbox ${checked ? "on" : ""}`}>
                      {checked && (
                        <svg viewBox="0 0 24 24" width="14" height="14">
                          <path d="M20 6L9 17l-5-5" strokeWidth="3" fill="none" />
                        </svg>
                      )}
                    </span>
                    <span className="msd-text">{opt}</span>
                  </div>
                );
              })
            )}
          </div>
          {(allSelected || someSelected) && (
            <div className="msd-footer muted small">
              {allSelected ? "All selected" : `${value.length} selected`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────
   Main App
   ─────────────────────────────── */

export default function App() {
  const [digitCode, setDigitCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pickedLocation, setPickedLocation] = useState("");
  const [indexPreview, setIndexPreview] = useState("");
  const [jsonPreview, setJsonPreview] = useState("");
  const [matchData, setMatchData] = useState(null);
  const [providerRefs, setProviderRefs] = useState(null);

  // NPIs + mapping NPI -> provider refs
  const [npiList, setNpiList] = useState([]); // array<string>
  const [npiMap, setNpiMap] = useState({});   // { "1234567890": { refs: ["400.x", ...] } }

  // picklist state
  const [rateOptions, setRateOptions] = useState([]); // [{ idx, price, label }]
  const [selectedRateIdx, setSelectedRateIdx] = useState(""); // string index
  const [providerRefOptions, setProviderRefOptions] = useState([]); // array<string>

  // multi-filter for provider references
  const [providerFilter, setProviderFilter] = useState([]); // array<string>

  // unified busy flag for spinners
  const [busy, setBusy] = useState(false);

  /* ---------- UI helpers that touch state ---------- */

  function buildRateOptions(match) {
    const out = [];
    const nrs = Array.isArray(match?.negotiated_rates) ? match.negotiated_rates : [];
    nrs.forEach((nr, idx) => {
      const np = Array.isArray(nr?.negotiated_prices) ? nr.negotiated_prices : [];
      const price = np[0]?.negotiated_rate;
      if (price !== undefined && price !== null && Number.isFinite(Number(price))) {
        out.push({ idx, price: Number(price), label: String(price) });
      }
    });
    return out.sort((a, b) => a.price - b.price);
  }

  function setupPicklistsForMatch(match) {
    const rates = buildRateOptions(match);
    setRateOptions(rates);
    setSelectedRateIdx("");
    setProviderRefOptions([]);
    setNpiList([]);
    setNpiMap({});
    setProviderFilter([]);
  }

  async function onSelectRate(e) {
    const val = e.target.value; // string index
    setSelectedRateIdx(val);
    const idx = Number(val);
    const nr = matchData?.negotiated_rates?.[idx];
    const refs = Array.isArray(nr?.provider_references) ? nr.provider_references : [];
    const refStrings = refs.map(String);
    setProviderRefOptions(refStrings);

    // Fetch ALL NPIs for these provider references
    setBusy(true);
    setStatus(`Fetching NPIs for ${refStrings.length} provider reference(s)…`);
    setError("");
    setNpiList([]);
    setNpiMap({});
    setProviderFilter([]); // empty filter => show all
    try {
      if (!refStrings.length) {
        setStatus("No provider references on this rate.");
        return;
      }
      const q = refStrings.join(",");
      const resp = await api(`/api/provider-npis?ids=${encodeURIComponent(q)}&debug=1`);
      let payload;
      try {
        payload = await resp.json();
      } catch {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status} — ${txt}`);
      }
      if (!resp.ok) throw new Error(payload?.error || `HTTP ${resp.status}`);

      const byId = payload?.by_id || {};
      const map = {}; // npi -> { refs:Set }
      for (const refId of Object.keys(byId)) {
        const npis = Array.isArray(byId[refId]?.npis) ? byId[refId].npis : [];
        for (const n of npis) {
          const key = String(n).padStart(10, "0");
          if (!map[key]) map[key] = { refs: new Set() };
          map[key].refs.add(String(refId));
        }
      }
      const frozen = {};
      const allNpis = [];
      for (const [npi, obj] of Object.entries(map)) {
        frozen[npi] = { refs: Array.from(obj.refs).sort() };
        allNpis.push(npi);
      }
      allNpis.sort();

      setNpiMap(frozen);
      setNpiList(allNpis);
      setStatus(`Loaded ${allNpis.length} NPIs. Use the filter to narrow by Provider Ref.`);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Main flow ---------- */

  const go = async () => {
    if (window.__GO_BUSY) return;
    window.__GO_BUSY = true;

    setNpiList([]);
    setNpiMap({});
    setProviderFilter([]);

    setError("");
    setStatus("Checking cache…");
    setBusy(true);
    setPickedLocation("");
    setIndexPreview("");
    setJsonPreview("");
    setMatchData(null);
    setProviderRefs(null);
    setRateOptions([]);
    setSelectedRateIdx("");
    setProviderRefOptions([]);

    const buildFilterUrl = (code) => `/api/filter-by-code?digitCode=${encodeURIComponent(code)}&debug=1`;

    try {
      if (!/^[\d]+$/.test(digitCode)) throw new Error("Enter a numeric digit code (digits only).");

      // 1) Use cached decompressed file if present
      try {
        const metaRes = await api("/api/decompressed-meta");
        if (metaRes.ok) {
          const meta = await metaRes.json();
          if (meta.exists) {
            setPickedLocation("(cached: /tmp/decompressed.json)");
            setStatus("Filtering cached file (first match) …");
            const filterRes = await api(buildFilterUrl(digitCode));
            if (!filterRes.ok) {
              let msg = `Filtering failed: HTTP ${filterRes.status}`;
              try {
                const j = await filterRes.json();
                if (j?.error) msg += ` — ${j.error}`;
              } catch {}
              throw new Error(msg);
            }
            const { match, provider_references } = await filterRes.json();
            setMatchData(match);
            setProviderRefs(provider_references);
            setJsonPreview(prettyPreview(match));
            setupPicklistsForMatch(match);
            setStatus("Done. Data filtered from cache (first match).");
            return;
          }
        }
      } catch {
        // fall through
      }

      // 2) Full flow
      setStatus("Fetching index URL…");
      const res = await api("/api/get-index-url");
      const data = await res.json();
      if (!data.indexUrl) throw new Error("Could not fetch index URL from BCBSTX site.");
      const indexUrl = data.indexUrl;

      setStatus("Downloading index JSON…");
      const idxRes = await api(`/api/proxy-index?url=${encodeURIComponent(indexUrl)}`);
      if (!idxRes.ok) throw new Error(`Index request failed: HTTP ${idxRes.status}`);
      const idx = await idxRes.json();
      setIndexPreview(prettyPreview(idx));

      setStatus('Locating "Blue Essentials in-network file"…');
      const location = findBlueEssentialsLocation(idx);
      if (!location) throw new Error('Could not find description "Blue Essentials in-network file".');
      setPickedLocation(location);

      setStatus("Decompressing file on server…");
      const decompressRes = await api(`/api/decompress?url=${encodeURIComponent(location)}`);
      if (!decompressRes.ok) throw new Error(`Decompression failed: HTTP ${decompressRes.status}`);
      await decompressRes.json();

      setStatus("Filtering decompressed data (first match) …");
      const filterRes2 = await api(buildFilterUrl(digitCode));
      if (!filterRes2.ok) {
        let msg = `Filtering failed: HTTP ${filterRes2.status}`;
        try {
          const j = await filterRes2.json();
          if (j?.error) msg += ` — ${j.error}`;
        } catch {}
        throw new Error(msg);
      }

      const { match: match2, provider_references: providerRefs2 } = await filterRes2.json();
      setMatchData(match2);
      setProviderRefs(providerRefs2);
      setJsonPreview(prettyPreview(match2));
      setupPicklistsForMatch(match2);
      setStatus("Done. Data filtered.");
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setStatus("");
    } finally {
      setBusy(false);
      window.__GO_BUSY = false;
    }
  };

  /* ---------- UI ---------- */

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/sptLogo.png" className="brand-logo" alt="SPT logo" />
          <span>In Network Finder</span>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => window.location.reload()}>
            Reset
          </button>
        </div>
      </header>

      <main className="wrap">
        <h1>Fetch & Explore In-Network Rates</h1>

        <div className="panel">
          <div className="row">
            <label className="label">Digit code</label>
            <input
              className="input"
              value={digitCode}
              onChange={(e) => setDigitCode(e.target.value)}
              placeholder="e.g., 33602"
              inputMode="numeric"
              pattern="[0-9]*"
              onKeyDown={(e) => e.key === "Enter" && go()}
            />
            <button className="btn primary" onClick={go} disabled={busy} aria-busy={busy}>
              {busy ? <LoadingSpinner /> : "Go"}
            </button>
          </div>

          <StatusBar busy={busy} text={status} error={error} />
        </div>

        <div className="grid">
          <section className="card span-2">
            <h2>Pick a negotiated rate</h2>
            {rateOptions.length ? (
              <select className="select" value={selectedRateIdx} onChange={onSelectRate}>
                <option value="">— Select a rate —</option>
                {rateOptions.map((o) => (
                  <option key={o.idx} value={o.idx}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <div className="muted mono small">— No negotiated rates found —</div>
            )}
          </section>

          {/* Removed: the right-side provider references card */}
        </div>

        {/* Profile cards */}
        <NpiCards
          npiList={npiList}
          npiMap={npiMap}
          providerRefOptions={providerRefOptions}
          providerFilter={providerFilter}
          onProviderFilterChange={setProviderFilter}
        />
      </main>

      <style>{css}</style>
    </div>
  );
}

/* ───────────────────────────────
   Non-state helpers
   ─────────────────────────────── */

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

function api(path, init) {
  return fetch(`${API_BASE}${path}`, init);
}

/* ───────────────────────────────
   NPI Cards + Filter
   ─────────────────────────────── */

    // Return the taxonomy group BEFORE the em dash (e.g., "Psychiatry & Neurology, Psychiatry")
function getTaxonomyGroupFromResult(result) {
  if (!result) return "";
  const tax = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  const primary = tax.find((t) => t.primary) || tax[0];
  const raw = primary?.desc || primary?.code || "";
  if (!raw) return "";
  // Split on em dash (—). If not present, use full text.
  const beforeDash = String(raw).split("—")[0].trim();
  // Clean up any trailing comma/spaces like "..., Psychiatry ,"
  return beforeDash.replace(/[,\s]+$/g, "");
}

   function NpiCards({
    npiList,
    npiMap,
    providerRefOptions,
    providerFilter,
    onProviderFilterChange,
  }) {
    const [entries, setEntries] = useState({}); // {"1234567890": result|null}
    const [errors, setErrors] = useState({});   // {"123...":"err"}
    const [pending, setPending] = useState(0);
  
    // NEW: taxonomy filter state
    const [taxonomyFilter, setTaxonomyFilter] = useState([]);
    const [taxonomyOptions, setTaxonomyOptions] = useState([]);
  
    // Fetch CMS profiles for the current npiList
    useEffect(() => {
      const numbers = Array.from(new Set((npiList || []).map((n) => String(n).padStart(10, "0"))));
      if (!numbers.length) {
        setEntries({});
        setErrors({});
        setPending(0);
        setTaxonomyFilter([]);
        setTaxonomyOptions([]);
        return;
      }
  
      let cancelled = false;
      setEntries({});
      setErrors({});
      setPending(numbers.length);
      setTaxonomyFilter([]);        // reset taxonomy filter on new load
      setTaxonomyOptions([]);       // will repopulate as entries arrive
  
      const CONCURRENCY = 6;
      let cursor = 0;
  
      const runNext = async () => {
        if (cancelled) return;
        const i = cursor++;
        if (i >= numbers.length) return;
  
        const npi = numbers[i];
        try {
          const resp = await api(`/api/npi?number=${encodeURIComponent(npi)}`);
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
          setEntries((prev) => ({ ...prev, [npi]: result }));
        } catch (e) {
          setErrors((prev) => ({ ...prev, [npi]: e.message || String(e) }));
        } finally {
          setPending((p) => p - 1);
          runNext();
        }
      };
  
      for (let k = 0; k < Math.min(CONCURRENCY, numbers.length); k++) runNext();
      return () => {
        cancelled = true;
      };
    }, [npiList]);
  
    // Build taxonomy options from loaded entries (incrementally)
    useEffect(() => {
      const set = new Set();
      for (const npi of Object.keys(entries)) {
        const result = entries[npi];
        if (!result) continue; // skip null/undefined
        const group = getTaxonomyGroupFromResult(result);
        if (group) set.add(group);
      }
      const opts = Array.from(set).sort((a, b) => a.localeCompare(b));
      setTaxonomyOptions(opts);
  
      // If the current taxonomyFilter includes values no longer present (edge cases),
      // trim them so the UI never shows “stale” selections.
      if (taxonomyFilter.length) {
        const allowed = new Set(opts);
        const next = taxonomyFilter.filter((t) => allowed.has(t));
        if (next.length !== taxonomyFilter.length) setTaxonomyFilter(next);
      }
    }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  
    const allNumbers =
      Object.keys(entries).length || Object.keys(errors).length
        ? Array.from(new Set((npiList || []).map((n) => String(n).padStart(10, "0"))))
        : [];
  
    // Apply Provider Ref + Taxonomy filters
    const displayNumbers = allNumbers.filter((npi) => {
      // 1) Provider refs (empty selection => pass)
      const refs = npiMap?.[npi]?.refs || [];
      const providerPass =
        !providerFilter || providerFilter.length === 0
          ? true
          : refs.some((r) => providerFilter.includes(String(r)));
  
      if (!providerPass) return false;
  
      // 2) Taxonomy (empty selection => pass)
      if (!taxonomyFilter || taxonomyFilter.length === 0) return true;
  
      const result = entries[npi];
      if (!result) return false; // if taxonomy filter is on, hide until we know
      const group = getTaxonomyGroupFromResult(result);
      return group && taxonomyFilter.includes(group);
    });
  
    return (
      <section className="npisection">
        <div className="npiheader">
          <h2>NPI Profiles</h2>
  
          <div className="filterbar">
            <MultiSelectDropdown
              options={providerRefOptions}
              value={providerFilter}
              onChange={onProviderFilterChange}
              placeholder="Provider Ref"
              maxMenuHeight={260}
              disabled={providerRefOptions.length === 0}
            />
            <MultiSelectDropdown
              options={taxonomyOptions}
              value={taxonomyFilter}
              onChange={setTaxonomyFilter}
              placeholder="Taxonomy"
              maxMenuHeight={260}
              disabled={taxonomyOptions.length === 0}
            />
  
            {pending > 0 && (
              <div className="pending" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <LoadingSpinner />
                <span>Loading {pending}…</span>
              </div>
            )}
          </div>
        </div>
  
        <div className="npiscroll">
          {!displayNumbers.length ? (
            <div className="muted mono small">— No NPIs match the current filter —</div>
          ) : (
            <div className="card-grid">
              {displayNumbers.map((npi) => (
                <NpiCard
                  key={npi}
                  npi={npi}
                  result={entries[npi]}
                  error={errors[npi]}
                  providerRefs={(npiMap?.[npi]?.refs || []).map(String)}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }
  

function NpiCard({ npi, result, error, providerRefs = [] }) {
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
        <div className="loadingline">
          <LoadingSpinner />
          <span>Loading…</span>
        </div>
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

  const basic = result.basic || {};
  const name =
    basic.organization_name ||
    [basic.first_name, basic.middle_name, basic.last_name].filter(Boolean).join(" ") ||
    `NPI ${npi}`;
  const credential = basic.credential;
  const enumDate = basic.enumeration_date;
  const lastUpdated = basic.last_updated;

  const tax = Array.isArray(result.taxonomies) ? result.taxonomies : [];
  const primaryTax = tax.find((t) => t.primary) || tax[0];
  const taxLine = primaryTax
    ? `${primaryTax.desc || primaryTax.code}${primaryTax.state ? ` — ${primaryTax.state}` : ""}${
        primaryTax.license ? ` — Lic ${primaryTax.license}` : ""
      }`
    : "—";

  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const loc = addresses.find((a) => a.address_purpose === "LOCATION") || addresses[0];
  const addr = loc
    ? `${loc.address_1 || ""}${loc.address_2 ? `, ${loc.address_2}` : ""}, ${loc.city || ""}, ${
        loc.state || ""
      } ${loc.postal_code || ""}`
    : "—";
  const phone = loc?.telephone_number || "—";
  const fax = loc?.fax_number || "";

  return (
    <div className="card">
      <div className="title">
        {name}
        {credential ? `, ${credential}` : ""}
      </div>
      <div className="muted">
        NPI {npi} • {basic.status || "—"}
      </div>
      <div className="line">
        <span className="label">Provider Ref(s)</span>
        <span>{providerRefs.length ? providerRefs.join(", ") : "—"}</span>
      </div>
      <div className="line">
        <span className="label">Taxonomy</span>
        <span>{taxLine}</span>
      </div>
      <div className="line">
        <span className="label">Location</span>
        <span>{addr}</span>
      </div>
      <div className="line">
        <span className="label">Phone</span>
        <span>
          {phone}
          {fax ? ` • Fax ${fax}` : ""}
        </span>
      </div>
      <div className="line">
        <span className="label">Enumerated</span>
        <span>{enumDate || "—"}</span>
      </div>
      <div className="line">
        <span className="label">Last updated</span>
        <span>{lastUpdated || "—"}</span>
      </div>
    </div>
  );
}

/* ───────────────────────────────
   CSS (adds multi-select styles)
   ─────────────────────────────── */

const css = `
:root{
  --bg: #0b0f14;
  --panel: #0f1520;
  --card: #121a25;
  --card-2: #0f1722;
  --text: #e6eaf2;
  --muted: #9aa7b6;
  --primary: #3b82f6;
  --primary-700: #2563eb;
  --accent: #22d3ee;
  --error: #ef4444;
  --border: #1f2a37;
  --ring: #3b82f6;
  --shadow: rgba(0,0,0,.35);
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; background: var(--bg); color: var(--text); }

.app { min-height: 100%; display: flex; flex-direction: column; }

.topbar{
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; background: rgba(15,21,32,.8); backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: .2px; }
.brand-logo { height: 22px; width: auto; display: block; }

.wrap { width: 100%; max-width: 1100px; margin: 28px auto; padding: 0 16px; }
h1 { font-size: 22px; margin: 0 0 12px; }
h2 { font-size: 16px; margin: 0 0 10px; }

.panel{
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  box-shadow: 0 10px 30px var(--shadow);
  margin-bottom: 18px;
}

.row{
  display: grid; grid-template-columns: 120px 1fr auto; gap: 10px; align-items: center;
}

.label{ color: var(--muted); font-size: 12px; }

.input{
  height: 40px;
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 12px;
  outline: none;
  transition: box-shadow .15s ease, border-color .15s ease, transform .05s ease;
}
.input:focus{
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgba(59,130,246,.25);
}

.btn{
  height: 40px; padding: 0 14px;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--card-2); color: var(--text);
  cursor: pointer;
  transition: transform .05s ease, background .2s ease, border-color .2s ease, opacity .2s ease;
  display: inline-flex; align-items: center; gap: 8px; justify-content: center;
}
.btn:hover{ transform: translateY(-1px); border-color: #2a3a4b; }
.btn:active{ transform: translateY(0); }

.btn.primary{ background: linear-gradient(180deg, var(--primary), var(--primary-700)); border-color: transparent; }
.btn.primary[disabled]{ opacity: .65; cursor: not-allowed; }

.btn.ghost{ background: transparent; }
.btn.ghost:hover{ background: rgba(255,255,255,.03); }

.statusbar{
  margin-top: 10px;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  background: #0e1622;
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
}
.statusbar.error{
  border-color: #331c1f;
  background: #1b0f11;
  color: #ffd7db;
}
.status-text{ font-size: 13px; opacity: .95; }

.spinner{
  display:inline-block;
  border-style: solid;
  border-color: transparent;
  border-top-color: var(--accent);
  border-right-color: var(--primary);
  border-radius: 999px;
  animation: spin .9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.grid{
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 900px){
  .grid{ grid-template-columns: 1fr; }
}
.card{
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  box-shadow: 0 10px 30px var(--shadow);
}
.card.span-2{ grid-column: span 2; }
.card.error{ border-color: #4b2326; background: #1e1011; }

.select{
  height: 40px; width: 100%;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  padding: 0 12px;
  outline: none;
  transition: box-shadow .15s ease, border-color .15s ease;
}
.select:focus{
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgba(59,130,246,.25);
}

.mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.small{ font-size: 12px; }
.muted{ color: var(--muted); }

.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-top: 8px; }
.title { font-weight: 700; margin-bottom: 4px; }
.line { display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin: 6px 0; }
.err { color: #ff9aa2; font-size: 13px; }

.npisection {
  margin-top: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px;
  box-shadow: 0 10px 30px var(--shadow);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 240px;
}

.npiheader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.filterbar{
  display:flex;
  align-items:center;
  gap:10px;
}

/* Fancy Multi-Select Dropdown */
.msd { position: relative; }
.msd.disabled { opacity: .6; pointer-events: none; }

.msd-btn{
  height: 40px; min-width: 200px;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  display: inline-flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 0 12px;
  cursor: pointer;
  transition: box-shadow .15s ease, border-color .15s ease, transform .05s ease;
}
.msd-btn.open, .msd-btn:focus{
  border-color: var(--ring);
  box-shadow: 0 0 0 3px rgba(59,130,246,.25);
}
.msd-label { display: inline-flex; align-items: center; gap: 8px; }
.msd-placeholder { color: var(--muted); }
.msd-count{
  font-size: 12px; background: rgba(34,211,238,.15);
  color: var(--accent); border: 1px solid rgba(34,211,238,.35);
  border-radius: 999px; padding: 2px 8px;
}

.msd-caret { fill: currentColor; opacity: .8; transition: transform .15s ease; }
.msd-caret.up { transform: rotate(180deg); }

.msd-menu{
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 20;
  width: 340px; max-width: 60vw;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 10px 30px var(--shadow);
  display: flex; flex-direction: column;
  overflow: hidden;
}

.msd-actions{
  display:flex; align-items:center; gap:8px;
  padding: 10px; border-bottom: 1px solid var(--border);
}
.chip{
  height: 28px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--card-2);
  color: var(--text); cursor: pointer;
}
.chip.ghost{ background: transparent; }
.chip:disabled{ opacity:.5; cursor:not-allowed; }

.msd-list{
  overflow:auto;
}
.msd-empty{ padding: 12px; }

.msd-item{
  display:flex; align-items:center; gap:10px;
  padding: 10px 12px; cursor:pointer;
  border-bottom: 1px solid rgba(255,255,255,.03);
}
.msd-item:hover{ background: rgba(255,255,255,.03); }
.msd-item:last-child{ border-bottom: none; }
.msd-item.checked .msd-text{ opacity: 1; }

.checkbox{
  width: 18px; height: 18px; border-radius: 6px;
  border: 1px solid var(--border); background: #0c141f;
  display:inline-flex; align-items:center; justify-content:center;
}
.checkbox.on{
  border-color: var(--accent); background: rgba(34,211,238,.15);
}
.checkbox svg { stroke: var(--accent); }

.msd-text{ flex:1; opacity:.95; }
.msd-footer{
  padding: 8px 12px; border-top: 1px solid var(--border);
}

.npiscroll {
  margin-top: 10px;
  flex: 1;
  overflow: auto;
  padding-right: 2px;
  background: #0c141f;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
}

.loadingline{ display: inline-flex; align-items: center; gap: 8px; color: var(--muted); }
`;
