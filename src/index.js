'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { PORT, MAX_CONCURRENT_BUILDS, MAX_UPLOAD_BYTES, CORS_ORIGIN } = require('./config');
const apiRouter = require('./routes');

const app = express();

// CORS_ORIGIN only matters if the frontend is ever split out from this
// service and hosted separately — by default this same service serves both
// the dashboard and the API, so cross-origin requests aren't the normal
// case. Defaults to '*' since there's no auth/cookies here to leak.
const corsOrigins = CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((o) => o.trim());
app.use(cors({ origin: corsOrigins }));

// The React app is built to web/dist (see web/package.json + the root
// Dockerfile) and served as static assets alongside the API from this same
// container.
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
  console.log(`Max concurrent builds: ${MAX_CONCURRENT_BUILDS}`);
});
