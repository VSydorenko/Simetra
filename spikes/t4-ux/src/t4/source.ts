// Порт CoreSource ядра над серверними функціями хоста. Відповідь чужого
// суб'єкта — відмова session-changed: ядро її не застосує.
import type { CoreSource } from "../core"
import { CommandFailure } from "../../../../packages/simetra/src/model/index"
import { readRows, runOps } from "../server/fns"

export function hostSource(subject: string): CoreSource {
  const unwrap = <T>(
    res:
      | { subject: string; ok: true; value: T }
      | { subject: string; ok: false; error: any }
  ): T => {
    if (res.subject !== subject)
      throw new CommandFailure({
        code: "command.unauthenticated",
        reason: "session-changed",
      } as any)
    if (!res.ok) throw new CommandFailure(res.error)
    return res.value
  }
  return {
    read: async (query, signal) =>
      unwrap(
        await traced("readRows", () => readRows({ data: query, signal } as any))
      ),
    run: async (operations, signal) =>
      unwrap(
        await traced("runOps", () =>
          runOps({ data: [...operations], signal } as any)
        )
      ),
  }
}

/** Журнал викликів серверних функцій на клієнті (у прод-збірці URL непрозорі). */
export function traced<T>(name: string, call: () => Promise<T>): Promise<T> {
  if (typeof window !== "undefined")
    ((window as any).__t4Fns ??= []).push({ name, t: performance.now() })
  return call()
}
