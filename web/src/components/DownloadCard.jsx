import { downloadUrl } from '../api.js';

export default function DownloadCard({ jobId }) {
  return (
    <div className="download-row">
      <a className="download-btn" href={downloadUrl(jobId)}>
        Download app.apk
      </a>
    </div>
  );
}
