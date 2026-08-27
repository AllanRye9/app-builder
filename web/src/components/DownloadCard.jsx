import { downloadUrl } from '../api.js';

export default function DownloadCard({ jobId, filename, compact }) {
  return (
    <a className={`download-btn${compact ? ' download-btn-compact' : ''}`} href={downloadUrl(jobId)} download>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4v11m0-11 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" transform="rotate(180 12 9.5)" />
        <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {compact ? 'Download' : 'Download APK'}
      {!compact && <span className="download-hint">{filename?.replace(/\.zip$/i, '') || 'app'}.apk</span>}
    </a>
  );
}
