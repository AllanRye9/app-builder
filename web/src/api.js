import { getToken } from './lib/auth.js';

// By default this dashboard and the API are served from the same service
// service, so this stays same-origin (VITE_API_BASE_URL unset). If you ever
// split the frontend out to a separate static host, set VITE_API_BASE_URL to
// this service's full URL and set CORS_ORIGIN on the server (src/config.js)
// to the frontend's origin.
const PRIMARY_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

// Alternate backend, tried only if the primary base above is genuinely
// unreachable (fetch() throws — DNS failure, connection refused, CORS
// preflight rejection). Whichever base a request actually succeeds against
// is remembered in `activeApiBase` so subsequent calls for the same job
// (log streaming, download) go straight to the right host instead of
// re-probing the primary first every time.
const FALLBACK_API_BASE = 'https://app-builder-gray.vercel.app';
let activeApiBase = PRIMARY_API_BASE;

// Tries `activeApiBase` first; if the request can't even reach that host,
// retries once against whichever of PRIMARY_API_BASE/FALLBACK_API_BASE it
// didn't just try. Returns the successful Response and updates
// `activeApiBase` to match, or re-throws the original network error if
// neither base is reachable.
async function fetchWithFallback(path, init) {
  const token = getToken();
  const withAuth = token
    ? { ...init, headers: { ...(init && init.headers), Authorization: `Bearer ${token}` } }
    : init;
  try {
    const res = await fetch(`${activeApiBase}${path}`, withAuth);
    return res;
  } catch (primaryErr) {
    const otherBase = activeApiBase === FALLBACK_API_BASE ? PRIMARY_API_BASE : FALLBACK_API_BASE;
    if (otherBase === activeApiBase) throw primaryErr; // nothing else to try
    try {
      const res = await fetch(`${otherBase}${path}`, withAuth);
      activeApiBase = otherBase; // this base works — stick with it going forward
      return res;
    } catch {
      throw primaryErr; // report the original failure; both bases are down
    }
  }
}

async function parseJsonResponse(res, fallbackMessage) {
  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`${fallbackMessage} (server returned HTTP ${res.status}, not JSON).`);
  }
  if (!res.ok) {
    throw new Error(data.error || data.detail || `${fallbackMessage} (HTTP ${res.status}).`);
  }
  return data;
}

// The whole site requires an account (see auth.py) — these three are the
// only endpoints besides /api/health reachable without a token.
export async function signup(email, password) {
  const res = await fetchWithFallback('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonResponse(res, 'Could not create account');
}

export async function login(email, password) {
  const res = await fetchWithFallback('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return parseJsonResponse(res, 'Could not sign in');
}

export async function logout() {
  try {
    await fetchWithFallback('/api/auth/logout', { method: 'POST' });
  } catch {
    // Best-effort — the token is cleared client-side regardless (see
    // AuthGate.jsx), so a network hiccup here doesn't strand the person
    // in a signed-in-looking-but-not state.
  }
}

export async function fetchMe() {
  const res = await fetchWithFallback('/api/auth/me');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.user;
}

export async function uploadZip(file, permissions = []) {
  const formData = new FormData();
  formData.append('zip', file);
  // Permissions are the uploader's call — the server never adds any of its
  // own (see src/buildRunner.js). An empty selection means "leave the
  // manifest exactly as the project has it."
  if (permissions.length > 0) {
    formData.append('permissions', JSON.stringify(permissions));
  }

  let res;
  try {
    res = await fetchWithFallback('/api/upload', { method: 'POST', body: formData });
  } catch {
    // Neither the primary base nor the fallback could be reached at all.
    throw new Error(
      PRIMARY_API_BASE
        ? `Can't reach the build worker at ${PRIMARY_API_BASE} (or the fallback at ${FALLBACK_API_BASE}). Check VITE_API_BASE_URL and that a worker is running.`
        : `Can't reach the API (tried this origin and the fallback at ${FALLBACK_API_BASE}). If the frontend is deployed separately from the backend, set VITE_API_BASE_URL to the backend's URL.`
    );
  }

  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // Response wasn't JSON at all — almost always means something in front
    // of the Express app answered instead of it: a reverse proxy's own 413
    // error page (body too large — see README's client_max_body_size note),
    // or, if API_BASE is unset/wrong on a split deployment, this request
    // landing on a host with no backend at all (e.g. a static-only host's own 404 page).
    throw new Error(
      `Upload failed: server returned HTTP ${res.status} ${res.statusText} (not JSON) — ` +
      (res.status === 413
        ? "the file is likely being rejected by a reverse proxy before reaching the app; check its max body size."
        : `check that ${activeApiBase || 'the API'} is actually the build worker, not just a static host.`)
    );
  }

  if (!res.ok) {
    throw new Error(data.error || `Upload failed: server returned HTTP ${res.status} ${res.statusText}.`);
  }
  return data.jobId;
}

export function streamLogs(jobId, { onLog, onNotice, onStatus, onQueue, onStep, onDone }) {
  // Uses whichever base the upload for this job actually succeeded
  // against (see fetchWithFallback above) rather than re-probing here —
  // EventSource has no built-in concept of "try this other host instead".
  // Token goes as a query param, not a header — EventSource can't attach
  // custom headers; app/auth.py's require_auth accepts either.
  const token = getToken();
  const tokenQs = token ? `?token=${encodeURIComponent(token)}` : '';
  const source = new EventSource(`${activeApiBase}/api/logs/${jobId}/stream${tokenQs}`);

  source.onmessage = (e) => {
    onLog?.(JSON.parse(e.data));
  };

  source.addEventListener('notice', (e) => {
    onNotice?.(JSON.parse(e.data));
  });

  source.addEventListener('status', (e) => {
    onStatus?.(JSON.parse(e.data));
  });

  source.addEventListener('queue', (e) => {
    onQueue?.(JSON.parse(e.data));
  });

  // Fine-grained progress within the 'building' stage — see setStep() in
  // src/jobStore.js. Distinct from 'status', which only carries the 4 big
  // macro stages the Pipeline stepper shows.
  source.addEventListener('step', (e) => {
    onStep?.(JSON.parse(e.data));
  });

  source.addEventListener('done', (e) => {
    onDone?.(JSON.parse(e.data));
    source.close();
  });

  // EventSource auto-retries on transient errors; if the job already
  // finished this fires as a harmless close, so there's nothing to do here.
  source.onerror = () => {};

  return () => source.close();
}

export function downloadUrl(jobId) {
  // Same reasoning as streamLogs above — a plain <a href> download can't
  // attach an Authorization header either.
  const token = getToken();
  const tokenQs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${activeApiBase}/api/download/${jobId}${tokenQs}`;
}

// Powers the standing status bar (SystemStatusBar.jsx) — a single,
// always-visible read on real container capacity (active/queued builds,
// memory headroom) rather than something only inferable per-job.
export async function fetchSystemStatus() {
  const res = await fetchWithFallback('/api/system');
  if (!res.ok) throw new Error(`System status request failed: HTTP ${res.status}`);
  return res.json();
}

// Records this browser as a unique visitor (deduped server-side by IP) and
// returns the fresh totals in the same round trip. Meant to be called once
// per app load, not on every render.
export async function pingVisitor() {
  const res = await fetchWithFallback('/api/visitors/ping', { method: 'POST' });
  if (!res.ok) throw new Error(`Visitor ping failed: HTTP ${res.status}`);
  return res.json();
}

// Read-only refresh of the same totals, for periodic polling without
// counting as another visit.
export async function fetchVisitorStats() {
  const res = await fetchWithFallback('/api/visitors/stats');
  if (!res.ok) throw new Error(`Visitor stats request failed: HTTP ${res.status}`);
  return res.json();
}

// Powers the error side panel (components/ErrorAssistant.jsx). `context`
// carries whatever's known about the failed build (filename, project
// type, error message, tail of the log); `history` is the running
// question/answer thread so follow-ups have context. See app/assist.py
// for the AI-vs-fallback split — this call never knows or cares which one
// answered beyond the `source` field in the response.
export async function askAssistant(question, context, history) {
  const res = await fetchWithFallback('/api/assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, context, history }),
  });
  return parseJsonResponse(res, 'Could not reach the assistant');
}
