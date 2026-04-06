export interface SupabaseConnectionSuccess {
  ok: true
  projectName: string | null
  status: string | null
}

export interface SupabaseConnectionFailure {
  ok: false
  error: string
}

export type SupabaseConnectionResult =
  | SupabaseConnectionSuccess
  | SupabaseConnectionFailure

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const candidate = payload as Record<string, unknown>
  const message =
    candidate.message ?? candidate.error_description ?? candidate.error

  return typeof message === 'string' ? message : null
}

export async function testSupabaseConnection(
  projectRef: string,
  accessToken: string,
): Promise<SupabaseConnectionResult> {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  const text = await response.text()
  const payload = text ? safeParseJson(text) : null

  if (!response.ok) {
    return {
      ok: false,
      error:
        readErrorMessage(payload) ??
        `HTTP ${response.status}${text ? `: ${text}` : ''}`,
    }
  }

  const data = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : null

  return {
    ok: true,
    projectName: typeof data?.name === 'string' ? data.name : null,
    status: typeof data?.status === 'string' ? data.status : null,
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}