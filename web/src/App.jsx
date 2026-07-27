import { useState } from 'react';
import Dropzone from './components/Dropzone.jsx';
import Pipeline from './components/Pipeline.jsx';
import LogPanel from './components/LogPanel.jsx';
import DownloadCard from './components/DownloadCard.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { uploadZip, streamLogs } from './api.js';

const IDLE = 'idle';
const RUNNING = 'running';
const DONE_SUCCESS = 'success';
const DONE_FAILED = 'failed';

export default function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [phase, setPhase] = useState(IDLE); // idle | running | success | failed
  const [stage, setStage] = useState('validating');
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState(null);

  const isBuilding = phase === RUNNING;

  async function startBuild() {
    if (!selectedFile) return;

    setPhase(RUNNING);
    setError('');
    setLogs([]);
    setStage('validating');
    setJobId(null);

    let id;
    try {
      id = await uploadZip(selectedFile);
    } catch (err) {
      setError(err.message);
      setPhase(DONE_FAILED);
      return;
    }

    setJobId(id);
    streamLogs(id, {
      onLog: (line) => setLogs((prev) => [...prev, line]),
      onStatus: ({ status }) => {
        if (status === 'queued') setStage('queued');
        if (status === 'building') setStage('building');
      },
      onDone: ({ status, error: doneError }) => {
        if (status === 'success') {
          setStage('success');
          setPhase(DONE_SUCCESS);
        } else {
          setPhase(DONE_FAILED);
          setError(doneError || 'Build failed. See the log above for details.');
        }
      },
    });
  }

  return (
    <main className="app-main">
      <header className="app-header">
        <div className="eyebrow"><span className="dot" />apk-builder</div>
        <h1>Turn a React project into an APK</h1>
        <p className="sub">
          Upload a .zip of a plain React (or Capacitor-ready) project. It's built inside an
          isolated, disposable Docker container with a pre-configured Android SDK — nothing runs
          on your machine.
        </p>
      </header>

      <div className="card">
        <Dropzone
          selectedFile={selectedFile}
          disabled={isBuilding}
          onFileSelected={(file) => {
            setSelectedFile(file);
            setPhase(IDLE);
            setError('');
            setLogs([]);
          }}
        />

        <button
          className="build-btn"
          disabled={!selectedFile || isBuilding}
          onClick={startBuild}
        >
          {isBuilding ? 'Building…' : 'Build APK'}
        </button>

        {phase !== IDLE && (
          <Pipeline activeStage={stage} failed={phase === DONE_FAILED} />
        )}

        {logs.length > 0 && <LogPanel lines={logs} live={isBuilding} />}

        <ErrorBanner message={phase === DONE_FAILED ? error : ''} />

        {phase === DONE_SUCCESS && jobId && <DownloadCard jobId={jobId} />}
      </div>

      <footer className="app-footer">
        Builds run with capped CPU/memory in an ephemeral container that's destroyed after each job.
      </footer>
    </main>
  );
}
