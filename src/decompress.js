// decompress.js
import fs from "fs";
import fetch from "node-fetch";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

export async function decompressToDisk(url, outputPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);

  await streamPipeline(
    res.body,
    zlib.createGunzip(),
    fs.createWriteStream(outputPath)
  );
}
