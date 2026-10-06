/** Locale-independent number text, so the panel renders the same in every test and browser. */

/** Integer with comma thousands separators. */
export function count(value: number): string {
  const sign = value < 0 ? '-' : ''
  return sign + String(Math.round(Math.abs(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** A share in [0, 1] as a percentage with one decimal. */
export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}
