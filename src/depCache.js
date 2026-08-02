'use strict';

// ---------------------------------------------------------------------------
// Content-addressed node_modules cache.
//
// The problem this solves: NPM_CACHE_DIR (config.js) already stops npm from
// re-downloading tarballs it's fetched before, but `npm ci` still spends
// real wall-clock time every single build re-extracting and re-linking the
// whole dependency tree from that cache. In this service, an enormous
// fraction of uploads share the exact same package-lock.json — the same
// React/Vite/Capacitor starter template rebuilt over and over, or the same
// project re-uploaded after a small source-code tweak that never touched
// dependencies at all. For every one of those, the "install" step is pure
// waste: the resulting node_modules tree is byte-for-byte identical to one
// already sitting on disk from a previous job.
//
// The fix: key a cache entry by a hash of whatever actually determines the
// resulting tree (the lockfile contents, plus the Node/npm major version and
// the Capacitor major this service pins — see fingerprint() below). Before
// running `npm ci`, check whether that exact hash has a cached node_modules
// already. If so, hardlink it straight into the project — no network, no
// resolution, no extraction, just directory-tree cloning at the filesystem
// level (near-instant, and consumes ~0 extra disk since hardlinks share the
// underlying inodes with the cached copy).
//
// This is intentionally scoped to "identical lockfile" rather than trying to
// do partial/incremental dependency diffing — that's what `npm ci` itself
// already does well once dependencies *do* change (an update to only the
// npm cache, not a full internet re-fetch, care of NPM_CACHE_DIR). This
// cache's whole job is to skip the redundant re-link when nothing changed
// at all, which is the common case here.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DEP_CACHE_DIR, DEP_CACHE_MAX_ENTRIES } = require('./config');

fs.mkdirSync(DEP_CACHE_DIR, { recursive: true });

// process.version / CAPACITOR_MAJOR are folded into the hash so a Node
// upgrade or a change to the pinned Capacitor major (both of which can
// change what a resolved tree looks like, e.g. native postinstall output)
// naturally invalidates old entries instead of silently reusing a tree that
// was built under different conditions — this is the "update when there's
// a mismatch" half of the strategy, done by construction rather than by
// remembering to bump some cache-buster manually.
function fingerprint(projectDir) {
  const lockPath = fs.existsSync(path.join(projectDir, 'package-lock.json'))
    ? path.join(projectDir, 'package-lock.json')
    : path.join(projectDir, 'package.json');
  if (!fs.existsSync(lockPath)) return null;

  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(lockPath));
  hash.update(`|node:${process.version}`);
  hash.update(`|capacitor:${process.env.CAPACITOR_MAJOR || '7'}`);
  hash.update(`|source:${path.basename(lockPath)}`);
  return hash.digest('hex').slice(0, 24);
}

function entryDir(hash) {
  return path.join(DEP_CACHE_DIR, hash);
}

function entryModulesDir(hash) {
  return path.join(entryDir(hash), 'node_modules');
}

// `cp -al` (GNU coreutils, present in the debian-based build image) hardlinks
// every file instead of copying bytes — a multi-hundred-MB node_modules
// tree restores in a fraction of a second and costs ~0 additional disk,
// since both the cache entry and the project's copy point at the same
// inodes. Falls back to a real recursive copy (slower, but still far
// cheaper than a full npm ci) if `cp` isn't available for some reason, e.g.
// a non-Linux dev environment running this service directly.
function hardlinkTree(src, dest) {
  const result = spawnSync('cp', ['-al', src, dest], { stdio: 'ignore' });
  if (!result.error && result.status === 0) return true;
  try {
    fs.cpSync(src, dest, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// Returns true if a cached node_modules for this hash was found and linked
// into projectDir/node_modules — the caller can then skip `npm ci` entirely.
function restore(hash, projectDir) {
  const src = entryModulesDir(hash);
  if (!fs.existsSync(src)) return false;

  const dest = path.join(projectDir, 'node_modules');
  fs.rmSync(dest, { recursive: true, force: true });
  const ok = hardlinkTree(src, dest);
  if (ok) touch(hash);
  return ok;
}

// Called after a real `npm ci`/`npm install` succeeds, to make that result
// available to the next job that hashes the same lockfile. Writes to a
// staging dir first and renames into place atomically, so a build that
// crashes mid-save (or two jobs finishing the same hash concurrently) can
// never leave a half-written, corrupt cache entry for the next job to
// hardlink from.
function save(hash, projectDir) {
  const src = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(src)) return false;

  const dir = entryDir(hash);
  const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const ok = hardlinkTree(src, path.join(staging, 'node_modules'));
  if (!ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  touch(hash);
  evictOldest();
  return true;
}

function touch(hash) {
  try {
    fs.utimesSync(entryDir(hash), new Date(), new Date());
  } catch {
    // Entry may not exist yet on a fresh save() — harmless, save() sets its
    // own mtime implicitly by creating the directory just after this.
  }
}

// Simple LRU by directory mtime — good enough at this scale (single digit
// to low tens of entries) without needing a separate metadata file to keep
// in sync.
function evictOldest() {
  let entries;
  try {
    entries = fs.readdirSync(DEP_CACHE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.includes('.staging-'))
      .map((e) => {
        const p = path.join(DEP_CACHE_DIR, e.name);
        return { p, mtime: fs.statSync(p).mtimeMs };
      });
  } catch {
    return;
  }
  if (entries.length <= DEP_CACHE_MAX_ENTRIES) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  const toRemove = entries.slice(0, entries.length - DEP_CACHE_MAX_ENTRIES);
  for (const e of toRemove) fs.rm(e.p, { recursive: true, force: true }, () => {});
}

module.exports = { fingerprint, restore, save };
