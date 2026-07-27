'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { PORT, DOCKER_IMAGE, MAX_CONCURRENT_BUILDS, MAX_UPLOAD_BYTES } = require('./config');
const apiRouter = require('./routes');

const app = express();

// The React app is built to web/dist (see web/package.json + root Dockerfile)
// and served as static assets alongside the API.
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
