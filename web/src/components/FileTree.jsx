import { useState } from 'react';

// Depth 0 (project root contents) opens automatically so the overview is
// visible immediately; anything nested past that stays collapsed until
// clicked, which is what keeps a big project from turning into a wall of
// rows the moment the archive is read.
const AUTO_OPEN_DEPTH = 1;

export default function FileTree({ nodes, depth = 0 }) {
  return (
    <ul className="ft-list" role="tree">
      {nodes.map((node, i) => (
        <FileTreeNode key={node.path} node={node} depth={depth} index={i} />
      ))}
    </ul>
  );
}

function FileTreeNode({ node, depth, index }) {
  const isDir = node.type === 'dir';
  const [open, setOpen] = useState(isDir && depth < AUTO_OPEN_DEPTH);

  return (
    <li
      className="ft-row"
      style={{ '--i': index }}
      role="treeitem"
      aria-expanded={isDir ? open : undefined}
    >
      <div
        className={`ft-line${node.flagged ? ' ft-flagged' : ''}${node.marker === 'entry' ? ' ft-entry' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
        onClick={() => isDir && setOpen((o) => !o)}
        role={isDir ? 'button' : undefined}
        tabIndex={isDir ? 0 : undefined}
        onKeyDown={(e) => {
          if (isDir && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen((o) => !o); }
        }}
      >
        {isDir ? (
          <span className={`ft-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
        ) : (
          <span className="ft-caret ft-caret-spacer" aria-hidden="true" />
        )}
        <span className="ft-glyph" aria-hidden="true">
          {isDir ? <FolderGlyph open={open} /> : <FileGlyph name={node.name} />}
        </span>
        <span className="ft-name">{node.name}</span>
        {node.marker === 'entry' && <span className="ft-badge ft-badge-entry">project root</span>}
        {node.marker === 'skipped' && <span className="ft-badge ft-badge-skip">ignored on upload</span>}
        {node.flagged && <span className="ft-badge ft-badge-flag">not allowed</span>}
      </div>

      {isDir && node.children.length > 0 && (
        <div className={`ft-children-wrap${open ? ' open' : ''}`}>
          <div className="ft-children">
            <FileTree nodes={node.children} depth={depth + 1} />
          </div>
        </div>
      )}
    </li>
  );
}

function FolderGlyph({ open }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {open ? (
        <path d="M1.5 4.5h4l1.2 1.4H14a.5.5 0 0 1 .49.6l-.9 6a.5.5 0 0 1-.49.4H2.4a.5.5 0 0 1-.5-.43L1 5a.5.5 0 0 1 .5-.57Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      ) : (
        <path d="M1.5 3.5h4l1.3 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5v-8.5a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      )}
    </svg>
  );
}

const EXT_COLOR = {
  json: 'var(--copper)',
  gradle: 'var(--copper)',
  kts: 'var(--copper)',
  kt: 'var(--violet)',
  java: 'var(--violet)',
  xml: 'var(--violet)',
  js: 'var(--teal)',
  jsx: 'var(--teal)',
  ts: 'var(--teal)',
  tsx: 'var(--teal)',
};

function FileGlyph({ name }) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const color = EXT_COLOR[ext] || 'var(--faint)';
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ color }}>
      <path d="M3.5 1.5h6l3 3v10a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5v-12.5a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}
