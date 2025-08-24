import express from "express";
import fetch from "node-fetch";
import { load } from "cheerio";
import zlib from "zlib";
import { createInterface } from "readline";
import { pipeline } from "stream";
import { promisify } from "util";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";

const TEMP_FILE = path.join("/tmp", "decompressed.json");
const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 3001;

async function decompressToDisk(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status}`);
  }
  // Ensure the output directory exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const gunzip = zlib.createGunzip();
  const destStream = fs.createWriteStream(outputPath);
  await streamPipeline(res.body, gunzip, destStream);
}

app.get("/api/decompress", async (req, res) => {
  const { url, force } = req.query; // <-- define force
  if (!url) return res.status(400).json({ error: "Missing URL param" });

  try {
    if (fs.existsSync(TEMP_FILE) && String(force) !== "1") {
      return res.json({ success: true, path: TEMP_FILE, cached: true });
    }

    await decompressToDisk(url, TEMP_FILE);
    res.json({ success: true, path: TEMP_FILE, cached: false });
  } catch (e) {
    console.error("Decompression failed:", e);
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/proxy-index", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://app0004702110a5prdnc868.blob.core.windows.net/")) {
    return res.status(400).json({ error: "Invalid or missing URL" });
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch index JSON" });
    }

    const json = await response.json();
    res.json(json); // pass back the real JSON from Azure
  } catch (err) {
    console.error("Proxy fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/filter-by-code", async (req, res) => {
  console.log("Looking for decompressed file at:", TEMP_FILE);

  const { digitCode, debug, first } = req.query;
  const DEBUG = String(debug) === "1";
  const USE_FIRST = String(first) === "1";

  // Only require numeric code when NOT using first=1
  if (!USE_FIRST && !/^\d+$/.test(String(digitCode || ""))) {
    return res.status(400).json({ error: "digitCode must be numeric" });
  }
  if (!fs.existsSync(TEMP_FILE)) {
    return res.status(404).json({ error: "Decompressed file not found." });
  }

  const TOKEN = '"in_network"';
  const CHUNK = 8 * 1024 * 1024;

  // --- Phase 1: find "in_network" byte offset (robust across chunk boundaries) ---
  if (DEBUG) console.log('[DBG] Locating "in_network"…');
  let offset = -1;
  {
    const s = fs.createReadStream(TEMP_FILE, { highWaterMark: CHUNK });
    let base = 0, tail = "";
    await new Promise((resolve, reject) => {
      s.on("data", (buf) => {
        const prevTailBytes = Buffer.byteLength(tail, "utf8");
        const text = tail + buf.toString("utf8");
        const idx = text.indexOf(TOKEN);
        if (idx !== -1 && offset === -1) {
          offset = base - prevTailBytes + idx;
          s.destroy();
          return;
        }
        tail = text.slice(-64);
        base += Buffer.byteLength(text, "utf8") - Buffer.byteLength(tail, "utf8");
      });
      s.on("close", resolve);
      s.on("error", reject);
    });
  }
  if (offset === -1) {
    if (DEBUG) console.log("[DBG] 'in_network' not found");
    return res.status(404).json({ error: "'in_network' not found in file" });
  }
  if (DEBUG) console.log(`[DBG] Found "in_network" at byte ${offset.toLocaleString()}`);

  // --- Phase 2: start at token, find '[' then iterate objects ---
  const stream = fs.createReadStream(TEMP_FILE, { start: offset, highWaterMark: CHUNK });

  let inString = false, escaped = false;
  let foundArray = false, arrayDepth = 0;
  let capturing = false, objBuf = "", objDepth = 0;

  function flattenProviderRefs(parsed) {
    const flat = [];
    if (Array.isArray(parsed?.negotiated_rates)) {
      const seen = new Set();
      for (const r of parsed.negotiated_rates) {
        if (Array.isArray(r?.provider_references)) {
          for (const id of r.provider_references) {
            if (!seen.has(id)) { seen.add(id); flat.push(id); }
          }
        }
      }
    }
    return flat;
  }

  function tryReturn(parsed) {
    if (USE_FIRST) {
      const flatRefs = flattenProviderRefs(parsed);
      if (DEBUG) console.log(`[DBG] ✅ Returning FIRST object (billing_code=${parsed?.billing_code})`);
      stream.destroy();
      return { match: parsed, provider_references: flatRefs };
    }
    if (String(parsed?.billing_code) === String(digitCode)) {
      const flatRefs = flattenProviderRefs(parsed);
      if (DEBUG) console.log(`[DBG] ✅ Match billing_code=${digitCode}`);
      stream.destroy();
      return { match: parsed, provider_references: flatRefs };
    }
    return null;
  }

  function feed(ch) {
    // If we're currently capturing an object, ALWAYS append the char first,
    // then update string/brace state. This preserves all quotes.
    if (capturing) {
      objBuf += ch;

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') { inString = true; escaped = false; }
        else if (ch === "{") objDepth++;
        else if (ch === "}") objDepth--;
      }

      if (!inString && objDepth === 0) {
        // Completed one object — parse and maybe return
        try {
          const parsed = JSON.parse(objBuf);
          const maybe = tryReturn(parsed);
          if (maybe) return maybe;
        } catch (e) {
          if (DEBUG) {
            console.log("[DBG] Object parse error (ignored):", e.message);
            console.log("[DBG]   head:", objBuf.slice(0, 120).replace(/\n/g, "\\n"));
          }
        }
        // reset for next object
        capturing = false;
        objBuf = "";
      }
      return null;
    }

    // Not capturing yet: manage string state only for locating the array open
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      return null;
    } else {
      if (ch === '"') { inString = true; escaped = false; return null; }
    }

    if (!foundArray) {
      if (ch === "[") { foundArray = true; arrayDepth = 1; }
      return null;
    }

    // Inside the in_network array but not inside an object yet
    if (ch === "{") { capturing = true; objBuf = "{"; objDepth = 1; return null; }
    if (ch === "[") { arrayDepth++; return null; }
    if (ch === "]") { arrayDepth--; return null; }

    return null;
  }

  let result = null;
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length && !result; i++) {
        const maybe = feed(text[i]);
        if (maybe) { result = maybe; break; }
        // If we’ve exited the array and aren’t capturing, we can stop
        if (foundArray && arrayDepth === 0 && !capturing) {
          stream.destroy();
          break;
        }
      }
    });
    stream.on("close", resolve);
    stream.on("error", reject);
  });

  if (!result) {
    if (DEBUG) console.log("[DBG] ❌ No object returned; end of in_network");
    return res.status(404).json({
      error: USE_FIRST ? "in_network is empty" : "Digit code not found in in_network",
    });
  }

  return res.json(result);
});

app.get("/api/get-index-url", async (req, res) => {
  try {
    const response = await fetch("https://www.bcbstx.com/member/machine-readable-files");
    const html = await response.text();
    const $ = load(html);

    const link = $("a")
      .filter((_, el) => $(el).text().trim() === "Review Machine Readable Files")
      .attr("href");

    if (!link) {
      return res.status(404).json({ error: "Could not find the link." });
    }

    const fullUrl = new URL(link, "https://www.bcbstx.com").href;
    res.json({ indexUrl: fullUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to retrieve index URL" });
  }
});

app.get("/api/fetch-gz", async (req, res) => {
  const url = req.query.url;
  if (!url || !url.endsWith(".json.gz")) {
    return res.status(400).json({ error: "Invalid .gz URL" });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: "Failed to fetch file" });
    }

    res.setHeader("Content-Type", "application/json");

    // Pipe Azure .gz stream → decompress → response
    await streamPipeline(
      response.body,
      zlib.createGunzip(),
      res
    );
  } catch (err) {
    console.error("Proxy streaming error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/decompressed-meta", (req, res) => {
  try {
    if (!fs.existsSync(TEMP_FILE)) {
      return res.status(404).json({ exists: false });
    }
    const st = fs.statSync(TEMP_FILE);
    return res.json({ exists: true, size: st.size, mtimeMs: st.mtimeMs, path: TEMP_FILE });
  } catch (e) {
    console.error("meta error:", e);
    return res.status(500).json({ error: e.message });
  }
});


// GET /api/provider-npis?ids=400.1227337,400.141759&debug=1
app.get("/api/provider-npis", async (req, res) => {
  const { ids = "", debug } = req.query;
  const DEBUG = String(debug) === "1";

  if (!fs.existsSync(TEMP_FILE)) {
    return res.status(404).json({ error: "Decompressed file not found." });
  }

  // normalize requested IDs as strings (we'll compare by string)
  const requested = new Set(
    String(ids)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  );
  if (requested.size === 0) {
    return res.status(400).json({ error: "Provide ids query param (comma-separated)." });
  }

  const TOKEN = '"provider_references"';
  const CHUNK = 8 * 1024 * 1024;

  if (DEBUG) {
    console.log(`[DBG] provider-npis: looking for ${requested.size} id(s): ${Array.from(requested).slice(0,5).join(", ")}${requested.size>5?" …":""}`);
  }

  // --- Phase 1: find "provider_references" token offset ---
  let offset = -1;
  {
    const s = fs.createReadStream(TEMP_FILE, { highWaterMark: CHUNK });
    let base = 0, tail = "";
    await new Promise((resolve, reject) => {
      s.on("data", (buf) => {
        const prevTailBytes = Buffer.byteLength(tail, "utf8");
        const text = tail + buf.toString("utf8");
        const idx = text.indexOf(TOKEN);
        if (idx !== -1 && offset === -1) {
          offset = base - prevTailBytes + idx;
          s.destroy();
          return;
        }
        tail = text.slice(-64);
        base += Buffer.byteLength(text, "utf8") - Buffer.byteLength(tail, "utf8");
      });
      s.on("close", resolve);
      s.on("error", reject);
    });
  }
  if (offset === -1) {
    if (DEBUG) console.log("[DBG] provider-npis: 'provider_references' not found");
    return res.status(404).json({ error: "'provider_references' not found in file" });
  }
  if (DEBUG) console.log(`[DBG] provider-npis: found token at byte ${offset.toLocaleString()}`);

  // --- Phase 2: stream the array and capture objects one-by-one ---
  const stream = fs.createReadStream(TEMP_FILE, { start: offset, highWaterMark: CHUNK });

  let inString = false, escaped = false;
  let foundArray = false, arrayDepth = 0;
  let capturing = false, objBuf = "", objDepth = 0;

  const results = {}; // by_id: { "<id>": { provider_group_id: "<id>", npis: [ ... ] } }
  let remaining = new Set(requested);

  function appendNPIs(obj) {
    const k = String(obj?.provider_group_id);
    if (!k) return;
    const dest = results[k] || { provider_group_id: k, npis: [] };
    const seen = new Set(dest.npis);
    const groups = Array.isArray(obj?.provider_groups) ? obj.provider_groups : [];
    for (const g of groups) {
      const npis = Array.isArray(g?.npi) ? g.npi : [];
      for (const n of npis) {
        if (!seen.has(n)) { seen.add(n); dest.npis.push(n); }
      }
    }
    results[k] = dest;
  }

  function feed(ch) {
    // If capturing an object, append char first, then update state
    if (capturing) {
      objBuf += ch;

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') { inString = true; escaped = false; }
        else if (ch === "{") objDepth++;
        else if (ch === "}") objDepth--;
      }

      if (!inString && objDepth === 0) {
        try {
          const parsed = JSON.parse(objBuf);
          const idStr = String(parsed?.provider_group_id);
          if (remaining.has(idStr)) {
            appendNPIs(parsed);
            remaining.delete(idStr);
            if (DEBUG) console.log(`[DBG] provider-npis: found id ${idStr}, remaining=${remaining.size}`);
            if (remaining.size === 0) {
              stream.destroy(); // we have all requested
              return true;
            }
          }
        } catch (e) {
          if (DEBUG) {
            console.log("[DBG] provider-npis: parse error (ignored):", e.message);
            console.log("[DBG]   head:", objBuf.slice(0, 100).replace(/\n/g, "\\n"));
          }
        }
        // reset for next object
        capturing = false;
        objBuf = "";
      }
      return false;
    }

    // not capturing: handle string state for array detection
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      return false;
    } else {
      if (ch === '"') { inString = true; escaped = false; return false; }
    }

    if (!foundArray) {
      if (ch === "[") { foundArray = true; arrayDepth = 1; }
      return false;
    }

    // once inside the array:
    if (ch === "{") { capturing = true; objBuf = "{" ; objDepth = 1; return false; }
    if (ch === "[") { arrayDepth++; return false; }
    if (ch === "]") { arrayDepth--; return false; }

    return false;
  }

  let completedEarly = false;
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i++) {
        if (feed(text[i])) { completedEarly = true; break; }
        if (foundArray && arrayDepth === 0 && !capturing) { // end of array
          stream.destroy();
          break;
        }
      }
    });
    stream.on("close", resolve);
    stream.on("error", reject);
  });

  const found = Object.keys(results);
  const missing = Array.from(requested).filter(id => !results[id]);

  if (DEBUG) {
    console.log(`[DBG] provider-npis: done. found=${found.length}, missing=${missing.length}, earlyStop=${completedEarly}`);
  }

  return res.json({ by_id: results, found, missing });
});

// GET /api/npi?number=1234567890
app.get("/api/npi", async (req, res) => {
  const number = String(req.query.number || "").trim();
  if (!/^\d{10}$/.test(number)) {
    return res.status(400).json({ error: "number must be a 10-digit NPI" });
  }
  try {
    const url = `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${number}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const body = await r.text(); // pass-through (and better error text)
    res.status(r.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(body);
  } catch (e) {
    return res.status(502).json({ error: `Upstream error: ${e.message}` });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
