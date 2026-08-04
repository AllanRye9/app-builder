export default function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert" title={message}>
      <span className="error-box-glyph" aria-hidden="true">!</span>
      <span className="error-box-text">{message}</span>
    </div>
  );
}
