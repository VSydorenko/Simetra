import http from "node:http"
import type { AddressInfo } from "node:net"
import type { AgentCallEvent } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAgentCallLog, otlpLogsEndpoint } from "../src/agent-call-log"

const EVENT: AgentCallEvent = {
  time: "2026-11-25T10:00:00.123Z",
  durationMs: 42,
  tool: "read",
  inputHash: "ab".repeat(32),
  status: "error",
  errorCode: "command.denied",
  rows: 3,
  sub: "00000000-0000-4000-8000-000000000001",
  actor: "https://client.test/cimd.json",
  pin: "00000000-0000-4000-8000-000000000042",
}
const NANOS = "1795600800123000000"

afterEach(() => vi.restoreAllMocks())

describe("otlpLogsEndpoint", () => {
  it.each([
    [{}, undefined],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" }, "http://c:4318/v1/logs"],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/" },
      "http://c:4318/v1/logs",
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://l:9/custom",
      },
      "http://l:9/custom",
    ],
    [{ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: " " }, undefined],
  ])("%j → %s", (env, expected) => {
    expect(otlpLogsEndpoint(env)).toBe(expected)
  })
})

describe("stdout without an exporter", () => {
  it("writes one JSON line in the OpenTelemetry logs data model", () => {
    const lines: string[] = []
    const sink = createAgentCallLog({
      env: { OTEL_SERVICE_NAME: "my-app" },
      write: (line) => lines.push(line),
    })
    void sink(EVENT)
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!)
    expect(record).toMatchObject({
      Timestamp: NANOS,
      SeverityText: "INFO",
      SeverityNumber: 9,
      EventName: "agent.call",
      Resource: { "service.name": "my-app" },
      InstrumentationScope: { Name: "simetra" },
      Attributes: {
        "agent.tool": "read",
        "agent.input_hash": "ab".repeat(32),
        "agent.status": "error",
        "agent.error_code": "command.denied",
        "agent.rows": 3,
        "agent.duration_ms": 42,
        "user.id": "00000000-0000-4000-8000-000000000001",
        "agent.actor": "https://client.test/cimd.json",
        "agent.pin": "00000000-0000-4000-8000-000000000042",
      },
    })
    expect(typeof record.ObservedTimestamp).toBe("string")
  })

  it("leaves out absent optional fields and names the unknown service", () => {
    const lines: string[] = []
    const sink = createAgentCallLog({ env: {}, write: (l) => lines.push(l) })
    void sink({
      time: EVENT.time,
      durationMs: 1,
      tool: "describe",
      inputHash: EVENT.inputHash,
      status: "ok",
      sub: EVENT.sub,
      actor: EVENT.actor,
    })
    const record = JSON.parse(lines[0]!)
    expect(Object.keys(record.Attributes).sort()).toEqual([
      "agent.actor",
      "agent.duration_ms",
      "agent.input_hash",
      "agent.status",
      "agent.tool",
      "user.id",
    ])
    expect(record.Resource).toEqual({ "service.name": "unknown_service" })
  })
})

/** Локальний колектор OTLP/HTTP: запам'ятовує запити, відповідає `status`. */
async function collector(status = 200) {
  const received: { url: string; type: string; body: unknown }[] = []
  const server = http.createServer((req, res) => {
    let text = ""
    req.on("data", (c: Buffer) => (text += c.toString()))
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        type: req.headers["content-type"] ?? "",
        body: JSON.parse(text),
      })
      res.statusCode = status
      res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

describe("OTLP/HTTP with an exporter", () => {
  it("posts one OTLP JSON log record to /v1/logs and writes nothing to stdout", async () => {
    const c = await collector()
    try {
      const write = vi.fn()
      const sink = createAgentCallLog({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: c.base },
        write,
      })
      await sink(EVENT)
      expect(write).not.toHaveBeenCalled()
      expect(c.received).toHaveLength(1)
      const [request] = c.received
      expect(request!.url).toBe("/v1/logs")
      expect(request!.type).toBe("application/json")
      expect(request!.body).toEqual({
        resourceLogs: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "unknown_service" },
                },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "simetra" },
                logRecords: [
                  {
                    timeUnixNano: NANOS,
                    observedTimeUnixNano: expect.any(String),
                    severityNumber: 9,
                    severityText: "INFO",
                    eventName: "agent.call",
                    attributes: [
                      {
                        key: "agent.tool",
                        value: { stringValue: "read" },
                      },
                      {
                        key: "agent.input_hash",
                        value: { stringValue: "ab".repeat(32) },
                      },
                      {
                        key: "agent.status",
                        value: { stringValue: "error" },
                      },
                      {
                        key: "agent.error_code",
                        value: { stringValue: "command.denied" },
                      },
                      { key: "agent.rows", value: { intValue: "3" } },
                      {
                        key: "agent.duration_ms",
                        value: { intValue: "42" },
                      },
                      {
                        key: "user.id",
                        value: { stringValue: EVENT.sub },
                      },
                      {
                        key: "agent.actor",
                        value: { stringValue: EVENT.actor },
                      },
                      {
                        key: "agent.pin",
                        value: { stringValue: EVENT.pin },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      })
    } finally {
      await c.close()
    }
  })

  it("a failed export resolves and logs no event data", async () => {
    const c = await collector(500)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(
        createAgentCallLog({
          env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${c.base}/x` },
        })(EVENT)
      ).resolves.toBeUndefined()
      expect(c.received).toHaveLength(1)
    } finally {
      await c.close()
    }
    // Закритий колектор: збій з'єднання теж не відмова
    await expect(
      createAgentCallLog({
        env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${c.base}/x` },
      })(EVENT)
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(2)
    const logged = JSON.stringify(error.mock.calls)
    for (const value of [EVENT.sub, EVENT.inputHash, EVENT.actor])
      expect(logged).not.toContain(value)
  })
})
