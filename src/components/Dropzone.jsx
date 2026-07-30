import { useRef, useState } from 'react';

export default function Dropzone({ onFilesSelected }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState('');

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
    if (zips.length === 0) {
      setRejected('Only .zip archives are accepted.');
      return;
    }
    setRejected('');
    onFilesSelected(zips);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div>
      <div
        className={`dropzone${dragging ? ' drag' : ''}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        role="button"
        tabIndex={0}
        aria-label="Add project archives"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <div className="dropzone-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 4v11m0-11 4 4m-4-4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="dropzone-copy">
          <div className="dropzone-primary">Drop project archives here</div>
          <div className="dropzone-secondary">or click to browse — one .zip per project, several at once is fine. package.json required, no android/ios folders.</div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {rejected && <div className="dropzone-reject">{rejected}</div>}
    </div>
  );
}
