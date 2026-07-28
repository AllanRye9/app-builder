export default function ErrorBanner({ message }) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert">
      <span className="error-box-glyph" aria-hidden="true">!</span>
      {message}
    </div>
  );
}
