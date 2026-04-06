const SUPABASE_HOST_PATTERN = /^([a-z0-9-]+)\.supabase\.co$/i

function extractRefFromHost(host: string): string | null {
  const match = host.match(SUPABASE_HOST_PATTERN)
  return match?.[1] ?? null
}

export function normalizeSupabaseProjectRef(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""

  const directHostRef = extractRefFromHost(trimmed.replace(/\/$/, ""))
  if (directHostRef) {
    return directHostRef
  }

  const normalizedInput = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  try {
    const url = new URL(normalizedInput)
    const ref = extractRefFromHost(url.hostname)
    return ref ?? trimmed
  } catch {
    return trimmed
  }
}