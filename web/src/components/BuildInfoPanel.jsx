import { useState } from 'react';
import StructureGuide from './StructureGuide.jsx';
import PermissionsPicker from './PermissionsPicker.jsx';

export default function BuildInfoPanel({ permissions, onPermissionsChange }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="info-panel">
      <button type="button" className="info-panel-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`log-toggle-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
        Project structure guide &amp; Android permissions
        {permissions.length > 0 && <span className="permissions-count">{permissions.length} permission{permissions.length === 1 ? '' : 's'} selected</span>}
      </button>

      {open && (
        <div className="info-panel-body">
          <div className="info-panel-col">
            <div className="info-panel-col-title">Project structure guide</div>
            <StructureGuide />
          </div>
          <div className="info-panel-rule" aria-hidden="true" />
          <div className="info-panel-col">
            <div className="info-panel-col-title">Android permissions</div>
            <PermissionsPicker selected={permissions} onChange={onPermissionsChange} />
          </div>
        </div>
      )}
    </div>
  );
}
