'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { PORT, DOCKER_IMAGE, MAX_CONCURRENT_BUILDS, MAX_UPLOAD_BYTES, CORS_ORIGIN } = require('./config');
const apiRouter = require('./routes');

const app = express();

// Allows the browser-side React app to call this API from a different
// origin than the one serving it — the split needed to host the frontend on
// Vercel/Netlify/any static host while this worker (which needs a real
// Docker daemon) runs elsewhere. CORS_ORIGIN defaults to '*'; set it to the
// frontend's exact origin once you know it, to stop other sites from being
// able to call this worker from a user's browser.
const corsOrigins = CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((o) => o.trim());
app.use(cors({ origin: corsOrigins }));

// The React app is built to web/dist (see web/package.json + root Dockerfile)
// and served as static assets alongside the API. When the frontend is
// deployed separately (see above), this static serving is simply unused —
// people hit the frontend's own host and its API calls land here via CORS.
app.use(express.static(path.join(__dirname, '..', 'web', 'dist')));
app.use(express.json());
app.use('/api', apiRouter);

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Archive exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`APK builder listening on http://localhost:${PORT}`);
  console.log(`Docker image: ${DOCKER_IMAGE} | max concurrent builds: ${MAX_CONCURRENT_BUILDS}`);
});
