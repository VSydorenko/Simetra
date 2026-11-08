// Тримач рантайму: одне ядро на суб'єкта. Зміна суб'єкта = dispose старого
// ядра до того, як новий суб'єкт щось побачить (сценарій 8).
import { createFakeCore } from '../core/fake-core'
import type { CoreSession } from '../core/types'

export class RuntimeHolder {
  private current: CoreSession | null = null
  private listeners = new Set<() => void>()

  get core(): CoreSession | null {
    return this.current
  }

  /** Ставить ядро суб'єкта; старе ядро іншого суб'єкта закривається першим. */
  ensure(subject: string | null): CoreSession | null {
    if (this.current && this.current.subject === subject) return this.current
    this.replace(subject ? createFakeCore(subject) : null)
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
