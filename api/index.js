// Vercel Node.js Serverless Function entrypoint. Vercel auto-detects any
// file under /api and calls its default export as an (req, res) handler
// per request — this just re-exports the same Express app that
// server/index.js runs directly on Render/Railway/Fly/plain Docker/etc.
// (server/index.js itself detects the Vercel environment and skips
// calling app.listen(), since Vercel calls this handler per-request
// instead of running a long-lived process).
//
// IMPORTANT CAVEATS for Vercel specifically — see the "Deploying
// elsewhere" section of the README:
//   - Only /tmp is writable, and it is NOT guaranteed to persist between
//     invocations/cold starts, so uploaded zips, built APKs, and job
//     status tracked by this app can disappear between requests. Fine for
//     kicking the tyres; not fine for real use without wiring in external
//     storage (e.g. Vercel Blob or S3) — not included here.
//   - Vercel's default request body size limit is smaller than the
//     200MB this app allows for project zips on a real server.
//   - There's no way to attach a persistent Disk the way Render's
//     render.yaml does, so DATA_DIR falls back to the OS temp dir
//     automatically on Vercel.
export { default } from '../server/index.js';
