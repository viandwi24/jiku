export function parseBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.toLowerCase().trim()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
  }
  return undefined
}
