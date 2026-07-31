// Vercel-only build step. Vercel Functions have no persistent writable
// filesystem to drop a config.json onto (see api/index.js), so its
// dashboard's Environment Variables are the only practical place to enter
// secrets when deploying there. This script bridges the gap once, at build
// time: it reads those variables and writes them into config.json, which
// then gets bundled alongside the function (see vercel.json's
// `includeFiles`). The running server itself (server/config.js) only ever
// reads config.json — it has no knowledge of, or dependency on, env vars.
//
// Not used by Render/Docker/local dev — those write config.json directly
// (see config.example.json) and never run this script.
import { existsSync, writeFileSync } from 'fs';

const fields = {
  githubToken: process.env.GITHUB_TOKEN,
  githubOwner: process.env.GITHUB_OWNER,
  githubRepo: process.env.GITHUB_REPO,
  callbackSecret: process.env.CALLBACK_SECRET,
};

if (existsSync('./config.json')) {
  console.log('[generate-config] config.json already exists in the repo — leaving it as-is.');
  process.exit(0);
}

// Always write the file, even if empty — Vercel's `includeFiles` references
// config.json unconditionally, so it needs to exist for the build to
// succeed. An empty/partial one just means /api/config will report the
// missing fields, same as any other misconfigured deployment.
writeFileSync('./config.json', JSON.stringify(fields, null, 2));
console.log(
  Object.values(fields).some(Boolean)
    ? '[generate-config] Wrote config.json from Vercel build environment variables.'
    : '[generate-config] No GITHUB_*/CALLBACK_SECRET build env vars set — wrote an empty config.json.'
);
