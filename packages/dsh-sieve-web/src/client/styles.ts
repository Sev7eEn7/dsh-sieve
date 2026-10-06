/**
 * Panel styles. DSH's own plugins compile CSS Modules in their shared build
 * preset; this bundle is built outside that preset, so the sheet is plain text
 * under one class prefix, mounted for the plugin's lifetime. Only theme alias
 * tokens are used, so light and dark follow the active theme.
 */

/** Marks the style element so a reload replaces rather than duplicates it. */
export const STYLE_ID = 'dsh-sieve-web'

export const CSS = `
.sieve-panel {
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.sieve-header { display: flex; align-items: center; gap: 8px; }
.sieve-title { flex: 1; font-size: 14px; line-height: 20px; font-weight: 600; }
.sieve-notice { padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.sieve-error { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.sieve-error-text { margin: 0; color: var(--dsw-alias-state-error-primary); }
.sieve-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 0; }
.sieve-metric { padding: 10px 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2); cursor: help; }
.sieve-metric dt { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.sieve-metric dd { margin: 4px 0 0; font-size: 18px; line-height: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sieve-metric dd.sieve-metric-sub { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-weight: 400; }
.sieve-section { display: flex; flex-direction: column; gap: 8px; }
.sieve-section h3 { margin: 0; font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.sieve-detail { margin: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.sieve-key { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2); }
.sieve-key-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.sieve-key-name { font-weight: 600; }
.sieve-key-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; }
.sieve-key-form > :first-child { flex: 1 1 160px; min-width: 0; }
.sieve-footnote { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
`

/**
 * Mount the sheet into a document.
 * @param doc - the page document.
 * @returns removes the sheet.
 */
export function mountStyles(doc: Document): () => void {
  doc.head.querySelector(`style[data-plugin="${STYLE_ID}"]`)?.remove()
  const tag = doc.createElement('style')
  tag.dataset['plugin'] = STYLE_ID
  tag.textContent = CSS
  doc.head.appendChild(tag)
  return () => { tag.remove() }
}
