import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { saveSession, loadSession, clearSession } from '../storage/session-db'
import { projectModelSchema } from '@simetra/core'

const MINIMAL_MODEL = projectModelSchema.parse({
  project: { name: 'TestProject' },
})

beforeEach(async () => {
  // Очистити IndexedDB між тестами
  await clearSession()
})

describe('session-db: origin persistence', () => {
  it('saveSession persists origin, loadSession returns it', async () => {
    await saveSession(null, MINIMAL_MODEL, 1, 'zip-import')
    const session = await loadSession()

    expect(session).not.toBeNull()
    expect(session!.origin).toBe('zip-import')
  })

  it('saveSession with directory origin', async () => {
    // handle is null in test env (FileSystemDirectoryHandle not available)
    await saveSession(null, MINIMAL_MODEL, 1, 'directory')
    const session = await loadSession()

    expect(session).not.toBeNull()
    expect(session!.origin).toBe('directory')
  })

  it('saveSession without origin — backward compatibility', async () => {
    await saveSession(null, MINIMAL_MODEL, 1)
    const session = await loadSession()

    expect(session).not.toBeNull()
    expect(session!.origin).toBeUndefined()
  })

  it('session model persists correctly', async () => {
    await saveSession(null, MINIMAL_MODEL, 42, 'zip-import')
    const session = await loadSession()

    expect(session!.projectModel.project.name).toBe('TestProject')
    expect(session!.lastSavedVersion).toBe(42)
  })
})
