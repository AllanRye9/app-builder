import BrandMark from './BrandMark.jsx';

export default function IntroModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel intro-modal" role="dialog" aria-modal="true" aria-label="Welcome to apkit" onClick={(e) => e.stopPropagation()}>
        <div className="intro-brand">
          <BrandMark size={26} />
          <span>apkit</span>
        </div>
        <h2 className="intro-title">Turn a project into an APK in three steps</h2>

        <ol className="intro-steps">
          <li>
            <span className="intro-step-num">1</span>
            <div>
              <div className="intro-step-title">Drop a .zip</div>
              <div className="intro-step-sub">A React/Vite project (Capacitor), a React Native project, a native Kotlin/Java Gradle project, or a Flutter (Dart) project — several at once is fine.</div>
            </div>
          </li>
          <li>
            <span className="intro-step-num">2</span>
            <div>
              <div className="intro-step-title">Confirm Android permissions</div>
              <div className="intro-step-sub">A pop-up lets you check off anything the app needs before the build actually starts.</div>
            </div>
          </li>
          <li>
            <span className="intro-step-num">3</span>
            <div>
              <div className="intro-step-title">Download your APK</div>
              <div className="intro-step-sub">Watch it build live, then grab the installable APK the moment it's ready. If something fails, a help panel opens automatically.</div>
            </div>
          </li>
        </ol>

        <button type="button" className="modal-btn-primary intro-close" onClick={onClose}>Let's go</button>
      </div>
    </div>
  );
}
