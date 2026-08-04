import { useMemo } from 'react';
import { marked } from 'marked';
import guideMd from '../content/structureGuide.md?raw';

marked.setOptions({ gfm: true, breaks: false });

export default function StructureGuide() {
  const html = useMemo(() => marked.parse(guideMd), []);

  return (
    <div
      className="markdown-body guide-markdown"
      // guideMd is static, author-controlled content bundled at build time
      // (not user input), so this is safe without a separate sanitize pass.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
