// Regex-guessed file-path-looking tokens pulled out of the error text/log
// tail, so callers can offer one-click chips / red tree highlighting
// instead of making the person hunt for the exact path themselves. Purely
// a convenience — a manual path field / full tree browse covers anything
// this misses. The leading `\/?` is deliberate: without it, an absolute
// path like "/home/build/.../Foo.kt" would match starting at "home",
// losing the leading slash before toProjectRelative() below ever gets a
// chance to recognize it as absolute.
const PATH_PATTERN = /\/?[\w][\w.\-/]*\.(?:kt|kts|java|xml|gradle|json|dart|ya?ml|properties|pro|cfg|jsx?|tsx?)\b/g;

// Known top-level source directories across the project types this app
// builds (Capacitor/web, native Android, Flutter). A build tool's own
// error output often reports an *absolute* container path (e.g.
// "/home/build/jobs/<id>/project/app/src/main/kotlin/Foo.kt") rather than
// one relative to the project root the file-editor API expects. The
// frontend has no way to know the server's absolute jobs-root prefix
// (it's configurable per deployment — see config.py's JOB_ROOT), so the
// only safe move for an absolute-looking path is to look for one of these
// familiar directory names appearing *later* in the path and keep only
// from there onward. Applied only to paths already identified as
// absolute — never to an already-relative match — so a normal relative
// mention like "app/src/main/...Kt" is trusted as-is rather than risking
// an over-eager cut at its own first "src/" segment.
const PROJECT_ROOT_MARKERS = ['app/', 'src/', 'lib/', 'android/', 'ios/', 'assets/', 'test/'];

export function toProjectRelative(rawPath) {
  const cleaned = rawPath.replace(/^\.\/+/, '');
  if (!cleaned.startsWith('/')) {
    return cleaned; // already relative-looking — trust it as-is
  }
  for (const marker of PROJECT_ROOT_MARKERS) {
    const idx = cleaned.lastIndexOf(`/${marker}`);
    if (idx !== -1) return cleaned.slice(idx + 1);
  }
  // No recognizable project-relative anchor in this absolute path — don't
  // guess wrong; a bad chip/highlight that's wrong is worse than one fewer.
  return null;
}

// Pulls up to `limit` distinct, plausible project-relative file paths out
// of an error message + log tail. Shared by the quick-fix chip list
// (ErrorAssistant) and the full project-tree red-highlighting
// (ProjectEditorModal) so both agree on exactly which files look
// implicated in a given failure.
export function guessCandidatePaths(errorContext, limit = 6) {
  if (!errorContext) return [];
  const haystack = [errorContext.errorMessage, ...(errorContext.logTail || [])].join('\n');
  const found = haystack.match(PATH_PATTERN) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    if (raw.startsWith('http') || raw.startsWith('//')) continue;
    const path = toProjectRelative(raw);
    if (!path || path.length > 140 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

// True if a project-tree path (e.g. "app/src/main/AndroidManifest.xml")
// matches one of the guessed candidate paths closely enough to mark it as
// implicated in the error. Exact match first; falls back to a suffix
// match in either direction so a slightly different root prefix (e.g. the
// tree API returning paths rooted one level differently than the log
// text) still lines up rather than silently missing the highlight.
export function isPathImplicated(treePath, candidatePaths) {
  if (!treePath || !candidatePaths || candidatePaths.length === 0) return false;
  for (const candidate of candidatePaths) {
    if (treePath === candidate) return true;
    if (treePath.endsWith(`/${candidate}`)) return true;
    if (candidate.endsWith(`/${treePath}`)) return true;
  }
  return false;
}
