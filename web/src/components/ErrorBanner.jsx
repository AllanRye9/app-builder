export default function ErrorBanner({ message, exitCode }) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert" title={message}>
      <span className="error-box-glyph" aria-hidden="true">!</span>
      <span className="error-box-text">
        {message}
        {exitCode != null && <span className="error-box-exit"> (exit code {exitCode})</span>}
      </span>
    </div>
  );
}
