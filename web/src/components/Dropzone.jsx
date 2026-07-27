import { useRef, useState } from 'react';

export default function Dropzone({ selectedFile, onFileSelected, disabled }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(fileList) {
    const file = fileList?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      window.alert('Please select a .zip archive.');
      return;
    }
    onFileSelected(file);
  }

  return (
    <>
      <div
        className={`dropzone${dragging ? ' drag' : ''}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <div className="icon">[ .zip ]</div>
        <div className="primary">Drop your project archive here</div>
        <div className="secondary">or click to browse — package.json required, no android/ios folders</div>
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          disabled={disabled}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
      {selectedFile && (
        <div className="file-name">
          {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(1)} MB)
        </div>
      )}
    </>
  );
}
