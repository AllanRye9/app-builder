export default function SidePanel({ title, subtitle, children }) {
  return (
    <div className="side-panel-section">
      <div className="side-panel-title-row">
        <div className="side-panel-title">{title}</div>
        {subtitle && <span className="side-panel-subtitle">{subtitle}</span>}
      </div>
      <div className="side-panel-content">{children}</div>
    </div>
  );
}
