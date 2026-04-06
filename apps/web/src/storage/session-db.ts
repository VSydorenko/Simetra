import { openDB, type IDBPDatabase } from "idb"
import type { ProjectModel } from "@simetra/core"

// Структура IndexedDB для session persistence
interface SessionData {
  projectHandle: FileSystemDirectoryHandle | null
  projectModel: ProjectModel
  lastSavedVersion: number
  savedAt: number
  origin?: string // "directory" | "zip-import" — тільки persistable origins
}

interface DraftData {
  model: ProjectModel
  version: number
  savedAt: number
}

// Захищені облікові дані — зберігаються окремо від проєктних файлів
interface CredentialData {
  value: string
  savedAt: number
}

interface SimetraSessionDB {
  session: {
    key: string
    value: SessionData
  }
  drafts: {
    key: string
    value: DraftData
  }
  credentials: {
    key: string
    value: CredentialData
  }
}

const DB_NAME = "simetra-session"
const DB_VERSION = 2
const SESSION_KEY = "current"
const DRAFT_KEY = "current"

/** Перевірка доступності IndexedDB */
function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined"
}

let dbPromise: Promise<IDBPDatabase<SimetraSessionDB>> | null = null

function getDb(): Promise<IDBPDatabase<SimetraSessionDB>> | null {
  if (!isIndexedDBAvailable()) return null
  if (!dbPromise) {
    dbPromise = openDB<SimetraSessionDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("session")) {
          db.createObjectStore("session")
        }
        if (!db.objectStoreNames.contains("drafts")) {
          db.createObjectStore("drafts")
        }
        if (!db.objectStoreNames.contains("credentials")) {
          db.createObjectStore("credentials")
        }
      },
    })
  }
  return dbPromise
}

/** Зберегти поточну сесію (handle + model + version) */
export async function saveSession(
  handle: FileSystemDirectoryHandle | null,
  model: ProjectModel,
  version: number,
  origin?: string
): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.put(
      "session",
      {
        projectHandle: handle,
        projectModel: model,
        lastSavedVersion: version,
        savedAt: Date.now(),
        ...(origin && { origin }),
      },
      SESSION_KEY
    )
  } catch {
    // Graceful degradation — quota exceeded, private mode тощо
  }
}

/** Завантажити збережену сесію або null */
export async function loadSession(): Promise<SessionData | null> {
  try {
    const dbP = getDb()
    if (!dbP) return null
    const db = await dbP
    const data = await db.get("session", SESSION_KEY)
    return data ?? null
  } catch {
    return null
  }
}

/** Видалити сесію */
export async function clearSession(): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.delete("session", SESSION_KEY)
  } catch {
    // Graceful degradation
  }
}

/** Зберегти draft для crash recovery */
export async function saveDraft(
  model: ProjectModel,
  version: number
): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.put(
      "drafts",
      {
        model,
        version,
        savedAt: Date.now(),
      },
      DRAFT_KEY
    )
  } catch {
    // Graceful degradation
  }
}

/** Завантажити draft або null */
export async function loadDraft(): Promise<DraftData | null> {
  try {
    const dbP = getDb()
    if (!dbP) return null
    const db = await dbP
    const data = await db.get("drafts", DRAFT_KEY)
    return data ?? null
  } catch {
    return null
  }
}

/** Видалити draft */
export async function clearDraft(): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.delete("drafts", DRAFT_KEY)
  } catch {
    // Graceful degradation
  }
}

/** Зберегти облікові дані за ідентифікатором (API key тощо) */
export async function saveCredential(id: string, value: string): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.put("credentials", { value, savedAt: Date.now() }, id)
  } catch {
    // Graceful degradation
  }
}

/** Завантажити облікові дані за ідентифікатором або null */
export async function loadCredential(id: string): Promise<string | null> {
  try {
    const dbP = getDb()
    if (!dbP) return null
    const db = await dbP
    const data = await db.get("credentials", id)
    return data?.value ?? null
  } catch {
    return null
  }
}

/** Видалити облікові дані за ідентифікатором */
export async function clearCredential(id: string): Promise<void> {
  try {
    const dbP = getDb()
    if (!dbP) return
    const db = await dbP
    await db.delete("credentials", id)
  } catch {
    // Graceful degradation
  }
}
