import { existsSync, readFileSync } from 'fs';
import path from 'path';

// --- Config is loaded from a JSON file instead of environment variables ---
//
// Why: env vars have to be re-entered by hand in every platform's dashboard,
// are easy to typo or leave unset, and (on some hosts) aren't visible/editable
// without a redeploy. A committed-nowhere config.json is simpler to reason
// about: it's one file, you can open it and see exactly what's set, and
// updating it doesn't require touching your hosting platform's UI at all.
//
// Looked for in this order — first one found wins:
//   1. ./config.json           — repo root / Docker WORKDIR (local dev, or
//      bind-mounted into the container at runtime: `-v $(pwd)/config.json:/app/config.json`)
//   2. /data/config.json       — a persistent disk mount (e.g. Render Disk).
//      Drop or edit the file there via the platform's shell and it survives
//      redeploys without ever being baked into the image or committed to git.
//
// config.json is gitignored — same role a .env file used to play. Copy
// config.example.json to config.json and fill in real values.
const CONFIG_CANDIDATES = [
  path.join(process.cwd(), 'config.json'),
  '/data/config.json',
];

// Re-read from disk on every call (rather than caching at import time) so
// editing config.json — e.g. switching buildImage, or adjusting
// retentionMinutes — takes effect immediately without restarting the
// process. It's a small sync file read on an infrequently-called path
// (config lookups, not per-upload), so this cost is negligible.
export function loadConfig() {
  for (const p of CONFIG_CANDIDATES) {
    if (existsSync(p)) {
      let raw;
      try {
        raw = readFileSync(p, 'utf-8');
      } catch (err) {
        console.warn(`[apk-builder] Found ${p} but couldn't read it (${err.message}) — trying the next candidate.`);
        continue;
      }
      try {
        return { ...JSON.parse(raw), _source: p };
      } catch (err) {
        throw new Error(`config.json at ${p} is not valid JSON: ${err.message}`);
      }
    }
  }
  return { _source: null };
}

export function configCandidatePaths() {
  return CONFIG_CANDIDATES;
}
