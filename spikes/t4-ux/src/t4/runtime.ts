// Тримач рантайму: одне ядро на суб'єкта. Зміна суб'єкта = dispose старого
// ядра до того, як новий суб'єкт щось побачить (сценарій 8).
import { createCoreSession, itemSpec, type CoreSession } from '../core'
import { hostSource } from './source'
import type { SnapshotMeta } from './ssr'

export function createCore(subject: string): CoreSession {
  return createCoreSession({ subject, source: hostSource(subject), objects: [itemSpec], releaseDelayMs: 1000 })
}

export class RuntimeHolder {
  private current: CoreSession | null = null
  /** Тотожність гідрованого SSR-знімка (лише на клієнті, до звірки). */
  snapshotMeta: SnapshotMeta | null = null
  /** Причина винятку безпеки, яку показує UI. */
  securityReason: string | null = null
  /** Версія прав сесії, з якою сервер рендерить знімок. */
  rightsVersion = 0
  private listeners = new Set<() => void>()

  get core(): CoreSession | null {
    return this.current
  }

  ensure(subject: string | null): CoreSession | null {
    if (this.current && this.current.subject === subject && !this.current.closed) return this.current
    this.replace(subject ? createCore(subject) : null)
    return this.current
  }

  replace(next: CoreSession | null) {
    const prev = this.current
    this.current = next
    prev?.dispose('subject-changed')
    for (const l of [...this.listeners]) l()
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot = () => this.current
}
