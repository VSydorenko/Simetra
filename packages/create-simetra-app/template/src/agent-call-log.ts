// Приймач події виклику агента (спека П4-F §5.4, Р-F4-9): без налаштувань —
// JSON-рядок у stdout за моделлю даних логів OpenTelemetry; зі змінною
// експортера — OTLP/HTTP JSON через `fetch`, без SDK OpenTelemetry. Подія вже
// без значень даних і тексту входу, тож приймач пише її поля як є.
import type { AgentCallEvent, OnAgentCall } from "simetra/model"

export interface AgentCallLogOptions {
  /** Типово — `process.env`. */
  env?: Record<string, string | undefined>
  /** Транспорт OTLP; типово — глобальний `fetch`. */
  fetch?: typeof fetch
  /** Рядок stdout; типово — `process.stdout`. */
  write?: (line: string) => void
}

const EVENT_NAME = "agent.call"
const SCOPE = "simetra"
// INFO моделі даних OpenTelemetry: подія — спостереження, а не збій
const SEVERITY = { text: "INFO", number: 9 }
// Збій експорту не має тримати проміси без кінця, коли колектор завис
const EXPORT_TIMEOUT_MS = 10_000

type Attribute = string | number

function attributes(event: AgentCallEvent): [string, Attribute][] {
  const pairs: [string, Attribute | undefined][] = [
    ["agent.tool", event.tool],
    ["agent.input_hash", event.inputHash],
    ["agent.status", event.status],
    ["agent.error_code", event.errorCode],
    ["agent.rows", event.rows],
    ["agent.duration_ms", event.durationMs],
    ["user.id", event.sub],
    ["agent.actor", event.actor],
    ["agent.pin", event.pin],
  ]
  return pairs.filter((p): p is [string, Attribute] => p[1] !== undefined)
}

// Час моделі даних — наносекунди Unix рядком: число втратило б точність
const unixNano = (iso: string): string =>
  (BigInt(Date.parse(iso)) * 1_000_000n).toString()

/** Кінцева точка логів OTLP/HTTP за змінними OpenTelemetry; без них — `undefined`. */
export function otlpLogsEndpoint(
  env: Record<string, string | undefined>
): string | undefined {
  const logs = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
  if (logs) return logs
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (base) return `${base.replace(/\/+$/, "")}/v1/logs`
  return undefined
}

function stdoutRecord(event: AgentCallEvent, service: string): string {
  return JSON.stringify({
    Timestamp: unixNano(event.time),
    ObservedTimestamp: unixNano(new Date().toISOString()),
    SeverityText: SEVERITY.text,
    SeverityNumber: SEVERITY.number,
    EventName: EVENT_NAME,
    Resource: { "service.name": service },
    InstrumentationScope: { Name: SCOPE },
    Attributes: Object.fromEntries(attributes(event)),
  })
}

function otlpBody(event: AgentCallEvent, service: string): string {
  // Цілі числа OTLP JSON — рядком (int64 у відображенні protobuf на JSON)
  const value = (v: Attribute) =>
    typeof v === "number" ? { intValue: String(v) } : { stringValue: v }
  return JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: value(service) }],
        },
        scopeLogs: [
          {
            scope: { name: SCOPE },
            logRecords: [
              {
                timeUnixNano: unixNano(event.time),
                observedTimeUnixNano: unixNano(new Date().toISOString()),
                severityNumber: SEVERITY.number,
                severityText: SEVERITY.text,
                eventName: EVENT_NAME,
                attributes: attributes(event).map(([key, v]) => ({
                  key,
                  value: value(v),
                })),
              },
            ],
          },
        ],
      },
    ],
  })
}

/** Приймач події виклику агента шаблону. */
export function createAgentCallLog(o: AgentCallLogOptions = {}): OnAgentCall {
  const env = o.env ?? process.env
  const endpoint = otlpLogsEndpoint(env)
  // Типове ім'я сервісу за специфікацією OpenTelemetry
  const service = env.OTEL_SERVICE_NAME?.trim() || "unknown_service"
  if (endpoint === undefined) {
    const write =
      o.write ?? ((line: string) => void process.stdout.write(`${line}\n`))
    return (event) => write(stdoutRecord(event, service))
  }
  const send = o.fetch ?? fetch
  return async (event) => {
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: otlpBody(event, service),
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      })
      // Тіло відповіді не потрібне, але має бути прочитане: інакше з'єднання
      // лишається зайнятим
      await response.body?.cancel()
      if (!response.ok)
        console.error(
          "[simetra] agent call export failed with status",
          response.status
        )
    } catch (error) {
      // Збій експорту не ламає виклику; подія в журнал помилок не йде
      console.error(
        "[simetra] agent call export failed",
        error instanceof Error ? error.name : "error"
      )
    }
  }
}
