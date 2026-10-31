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
.sieve-hive-runs { display: flex; flex-wrap: wrap; gap: 4px; }
.sieve-hive-goal { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.sieve-hive-status { font-weight: 600; }
.sieve-hive-status[data-status="running"], .sieve-hive-status[data-status="wrapping-up"] { color: var(--dsw-alias-label-primary); }
.sieve-hive-status[data-status="failed"], .sieve-hive-status[data-status="timed-out"], .sieve-hive-status[data-status="stalled"], .sieve-hive-status[data-status="not-started"] { color: var(--dsw-alias-state-error-primary); }
.sieve-hive-tag { padding: 0 6px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sieve-hive-bees { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.sieve-hive-bee { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2); }
.sieve-hive-text { margin: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.sieve-hive-stage { position: relative; width: 100%; overflow: hidden; }
.sieve-hive-stage > svg { position: absolute; left: 0; top: 0; }
.sieve-hive-line { fill: none; stroke: var(--dsw-alias-label-tertiary); }
.sieve-hive-line[data-kind="correction"] { stroke: var(--dsw-alias-label-primary); }
.sieve-hive-line[data-kind="conflict"] { stroke: var(--dsw-alias-state-error-primary); stroke-dasharray: 4 3; }
.sieve-hive-hit { fill: none; stroke: transparent; stroke-width: 10px; pointer-events: stroke; }
.sieve-hive-arrow { fill: var(--dsw-alias-label-tertiary); }
.sieve-hive-bar { stroke: var(--dsw-alias-label-primary); stroke-width: 2px; }
.sieve-hive-node { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
.sieve-hive-avatar { display: flex; align-items: center; justify-content: center; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.sieve-hive-avatar[data-status="running"], .sieve-hive-avatar[data-status="wrapping-up"] { border-color: var(--dsw-alias-label-primary); }
.sieve-hive-avatar[data-status="failed"], .sieve-hive-avatar[data-status="timed-out"], .sieve-hive-avatar[data-status="stalled"] { border-color: var(--dsw-alias-state-error-primary); }
.sieve-hive-node-name { max-width: 100%; font-weight: 600; overflow-wrap: anywhere; }
.sieve-hive-node-status, .sieve-hive-node-counts { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 14px; }
.sieve-hive-legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; padding: 0; list-style: none; color: var(--dsw-alias-label-secondary); }
.sieve-hive-legend li { display: flex; align-items: center; gap: 4px; }
.sieve-hive-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.sieve-hive-list li { display: flex; flex-direction: column; gap: 2px; padding-bottom: 6px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.sieve-hive-route { font-weight: 600; }
.sieve-hive-kind { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.sieve-hive-list li[data-passed="false"] .sieve-hive-route { color: var(--dsw-alias-label-tertiary); }
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
