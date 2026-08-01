// Vercel Node.js Serverless Function entrypoint. Vercel auto-detects any
// file under /api and calls its default export as an (req, res) handler
// per request — this just re-exports the same Express app that
// server/index.js runs directly on a VPS/local machine/plain Docker/etc.
//
// **NOT FUNCTIONAL FOR ACTUAL BUILDS**: this app now runs each build in a
// locally-launched Docker container (server/dockerBuild.js shells out to
// the `docker` CLI). Vercel Functions have no Docker daemon reachable from
// them at all, under any configuration — so /api/config will report
// dockerAvailable: false and every upload will be rejected. This file is
// left in place (it won't crash on deploy) in case only the static
// dashboard shell is useful to you, but for real use, run server/index.js
// directly on a host that has Docker installed — see the README.
export { default } from '../server/index.js';
