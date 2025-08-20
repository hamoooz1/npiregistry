import express from "express";
import fetch from "node-fetch";
import { load  } from "cheerio";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 3001;

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
