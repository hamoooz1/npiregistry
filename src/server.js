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

  const { digitCode } = req.query;

  if (!fs.existsSync(TEMP_FILE)) {
    return res.status(404).json({ error: "Decompressed file not found." });
  }

  const lineReader = createInterface({
    input: fs.createReadStream(TEMP_FILE),
  });

  let match = null;
  let providerReferences = [];

  lineReader.on("line", (line) => {
    if (match) return;

    if (line.includes('"billing_code"') && line.includes(`"${digitCode}"`)) {
      match = line;
    }

    if (line.includes('"provider_references"')) {
      const m = line.match(/"provider_references"\s*:\s*(\[.*?\])/);
      if (m) providerReferences = JSON.parse(m[1]);
    }
  });

  lineReader.on("close", () => {
    if (!match) return res.status(404).json({ error: "Digit code not found" });

    try {
      const parsed = JSON.parse(match);
      return res.json({ match: parsed, provider_references: providerReferences });
    } catch (e) {
      return res.status(500).json({ error: "Failed to parse JSON" });
    }
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


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
