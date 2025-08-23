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
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL param" });

  try {
    //Check if temp file exists already
    if (fs.existsSync(TEMP_FILE) && String(force) !== "1") {
      return res.json({ success: true, path: TEMP_FILE, cached: true });
    }

    await decompressToDisk(url, TEMP_FILE);
    res.json({ success: true, path: TEMP_FILE });
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

// server.js
app.get("/api/filter-by-code", async (req, res) => {
  console.log("Looking for decompressed file at:", TEMP_FILE);

  const { digitCode, debug } = req.query;
  const DEBUG = String(debug) === "1";

  if (!fs.existsSync(TEMP_FILE)) {
    return res.status(404).json({ error: "Decompressed file not found." });
  }

  // Helpful: log file size up front
  try {
    const { size } = fs.statSync(TEMP_FILE);
    if (DEBUG) console.log(`[DBG] File size: ${size.toLocaleString()} bytes`);
  } catch {}

  // Regex will catch number or string: "billing_code": 27658  OR  "billing_code": "27658"
  const billingRegex = new RegExp(`"billing_code"\\s*:\\s*"?${digitCode}"?`);

  const stream = fs.createReadStream(TEMP_FILE, { encoding: "utf8" });
  const lineReader = createInterface({ input: stream, crlfDelay: Infinity });

  // State for skipping the huge top-level provider_references
  let skippingTopProviderArray = false;
  let topProviderBracketDepth = 0;

  // State for entering/iterating the in_network array
  let sawInNetworkKey = false;
  let inInNetworkArray = false;
  let inNetworkBracketDepth = 0;

  // Buffer exactly one object at a time inside in_network
  let capturingObject = false;
  let objBuf = "";
  let objBraceDepth = 0;

  // Progress counters
  let lineNo = 0;
  let bytesSeen = 0;
  let objectsStarted = 0;
  let objectsCompleted = 0;
  let parsedObjects = 0;
  let parsedWithBillingCode = 0;

  let matchObj = null;

  function count(str, re) {
    const m = str.match(re);
    return m ? m.length : 0;
  }

  function safeSnippet(s, n = 160) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + " …(trunc)…" : s;
  }

  function collectProviderRefsFromMatch(o) {
    const out = new Set();
    const rates = Array.isArray(o?.negotiated_rates) ? o.negotiated_rates : [];
    for (const r of rates) {
      const refs = r?.provider_references;
      if (Array.isArray(refs)) for (const id of refs) out.add(id);
    }
    return Array.from(out);
  }

  lineReader.on("line", (line) => {
    if (matchObj) return; // we still read until 'close', but skip work

    lineNo++;
    bytesSeen += Buffer.byteLength(line, "utf8") + 1; // +1 for newline

    // 1) If we are skipping the massive top-level provider_references array, keep balancing [] until closed
    if (skippingTopProviderArray) {
      topProviderBracketDepth += count(line, /\[/g);
      topProviderBracketDepth -= count(line, /]/g);
      if (topProviderBracketDepth <= 0) {
        skippingTopProviderArray = false;
        topProviderBracketDepth = 0;
        if (DEBUG) console.log(`[DBG] ✅ Finished skipping top-level provider_references at line ${lineNo}`);
      }
      return;
    }

    // 2) Detect top-level "provider_references" and start skipping its array (NO buffering)
    if (!inInNetworkArray && !sawInNetworkKey && line.includes('"provider_references"')) {
      const keyIdx = line.indexOf('"provider_references"');
      const openIdx = line.indexOf("[", keyIdx);
      if (openIdx !== -1) {
        skippingTopProviderArray = true;
        const slice = line.slice(openIdx);
        topProviderBracketDepth = count(slice, /\[/g) - count(slice, /]/g);
        if (DEBUG) {
          console.log(`[DBG] ▶️ Skipping top-level provider_references at line ${lineNo}; init depth=${topProviderBracketDepth}`);
        }
        if (topProviderBracketDepth <= 0) {
          skippingTopProviderArray = false;
          topProviderBracketDepth = 0;
          if (DEBUG) console.log(`[DBG] ✅ provider_references closed on same line ${lineNo}`);
        }
      }
      return;
    }

    // 3) Detect the "in_network" key
    if (!sawInNetworkKey && line.includes('"in_network"')) {
      sawInNetworkKey = true;
      if (DEBUG) console.log(`[DBG] 🔎 Found 'in_network' key at line ${lineNo}`);
    }

    // 4) If we’re not yet inside in_network, look for its opening '['
    if (!inInNetworkArray && sawInNetworkKey) {
      const openIdx = line.indexOf("[");
      if (openIdx !== -1) {
        inInNetworkArray = true;
        const slice = line.slice(openIdx);
        inNetworkBracketDepth = count(slice, /\[/g) - count(slice, /]/g);
        if (DEBUG) console.log(`[DBG] 📂 Entered in_network array at line ${lineNo}; init depth=${inNetworkBracketDepth}`);
        if (inNetworkBracketDepth <= 0) {
          // Empty array case
          if (DEBUG) console.log(`[DBG] ⚠️ in_network array closed immediately (empty) at line ${lineNo}`);
          inInNetworkArray = false;
          sawInNetworkKey = false;
          inNetworkBracketDepth = 0;
        }
      }
      return;
    }

    // 5) If we are inside in_network and currently buffering one object
    if (inInNetworkArray && capturingObject) {
      objBuf += line + "\n";
      objBraceDepth += count(line, /{/g);
      objBraceDepth -= count(line, /}/g);

      if (objBraceDepth <= 0) {
        objectsCompleted++;
        if (DEBUG && objectsCompleted % 50 === 0) {
          console.log(`[DBG] 📦 Completed object #${objectsCompleted} at line ${lineNo}`);
        }

        // Completed one object text; check billing_code and parse
        let isCandidate = billingRegex.test(objBuf);
        if (isCandidate) {
          try {
            const parsed = JSON.parse(objBuf);
            parsedObjects++;
            const hasBilling = parsed?.billing_code !== undefined;
            if (hasBilling) parsedWithBillingCode++;
            if (DEBUG) {
              console.log(`[DBG] 🎯 Candidate matched regex at line ${lineNo}; billing_code=${parsed.billing_code}`);
            }
            // Compare as strings to cover number vs string cases
            if (String(parsed.billing_code) === String(digitCode)) {
              matchObj = parsed;
              if (DEBUG) {
                console.log(`[DBG] ✅ Exact match for billing_code=${digitCode} at object #${objectsCompleted}`);
                console.log(`[DBG]    name=${parsed?.name ?? "(none)"}; negotiated_rates=${Array.isArray(parsed?.negotiated_rates) ? parsed.negotiated_rates.length : 0}`);
              }
            }
          } catch (e) {
            // Regex matched but parse failed; log short snippet for diagnostics
            console.error(`[DBG] ❌ Failed to parse candidate object at line ${lineNo}: ${e.message}`);
            if (DEBUG) console.log(`[DBG]    Snippet: ${safeSnippet(objBuf)}`);
          }
        } else if (DEBUG && objectsCompleted % 200 === 0) {
          // Periodic peek into objects to confirm we’re seeing billing_code fields
          const hasBillingTxt = objBuf.includes('"billing_code"');
          console.log(`[DBG] 🔭 Peek object #${objectsCompleted}: has "billing_code" text? ${hasBillingTxt}`);
        }

        // Reset for next object
        objBuf = "";
        objBraceDepth = 0;
        capturingObject = false;
      }
      return;
    }

    // 6) If we are inside in_network but not currently buffering an object, look for object start
    if (inInNetworkArray && !capturingObject) {
      const objOpenIdx = line.indexOf("{");
      if (objOpenIdx !== -1) {
        capturingObject = true;
        objBuf = line.slice(objOpenIdx) + "\n";
        objBraceDepth = count(objBuf, /{/g) - count(objBuf, /}/g);
        objectsStarted++;
        if (DEBUG && objectsStarted % 50 === 0) {
          console.log(`[DBG] 📝 Started object #${objectsStarted} at line ${lineNo}; obj depth=${objBraceDepth}`);
        }

        // Handle single-line object case
        if (objBraceDepth <= 0) {
          objectsCompleted++;
          try {
            const parsed = JSON.parse(objBuf);
            parsedObjects++;
            const hasBilling = parsed?.billing_code !== undefined;
            if (hasBilling) parsedWithBillingCode++;
            if (String(parsed.billing_code) === String(digitCode)) {
              matchObj = parsed;
              if (DEBUG) console.log(`[DBG] ✅ Exact match (single-line object) for billing_code=${digitCode} at line ${lineNo}`);
            }
          } catch (e) {
            console.error(`[DBG] ❌ Parse error on single-line object at line ${lineNo}: ${e.message}`);
            if (DEBUG) console.log(`[DBG]    Snippet: ${safeSnippet(objBuf)}`);
          }
          objBuf = "";
          objBraceDepth = 0;
          capturingObject = false;
        }
        return;
      }

      // No object start on this line; track if in_network array ends here
      inNetworkBracketDepth += count(line, /\[/g);
      inNetworkBracketDepth -= count(line, /]/g);
      if (inNetworkBracketDepth <= 0) {
        if (DEBUG) console.log(`[DBG] 📁 Exited in_network array at line ${lineNo}`);
        inInNetworkArray = false;
        sawInNetworkKey = false;
        inNetworkBracketDepth = 0;
      }
    }
  });

  lineReader.on("close", () => {
    if (!matchObj) {
      // Give a helpful summary in logs when we miss
      console.log(`[DBG] ❌ No match for billing_code=${digitCode}. Summary:`);
      console.log(`[DBG]     lines=${lineNo.toLocaleString()}, bytes≈${bytesSeen.toLocaleString()}`);
      console.log(`[DBG]     objectsStarted=${objectsStarted}, objectsCompleted=${objectsCompleted}`);
      console.log(`[DBG]     parsedObjects=${parsedObjects}, parsedWithBillingCode=${parsedWithBillingCode}`);
      return res.status(404).json({
        error: "Digit code not found in in_network",
        debug: DEBUG ? {
          lines: lineNo,
          bytesSeen,
          objectsStarted,
          objectsCompleted,
          parsedObjects,
          parsedWithBillingCode,
        } : undefined,
      });
    }

    // Return the full matched object (includes negotiated_rates + per-rate provider_references)
    const flatProviderRefs = collectProviderRefsFromMatch(matchObj);
    if (DEBUG) {
      console.log(`[DBG] ✅ Returning match for billing_code=${digitCode}; provider_ref_count=${flatProviderRefs.length}`);
    }
    return res.json({
      match: matchObj,
      provider_references: flatProviderRefs, // convenience: flattened IDs
    });
  });

  lineReader.on("error", (e) => {
    console.error("Read error:", e);
    res.status(500).json({ error: e.message });
  });
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
