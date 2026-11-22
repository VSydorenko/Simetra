import pg from "pg"
import { buildRuntimeCatalog } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { fromS3Client, type FileStore } from "simetra/server"
import {
  ORG_SCOPE_KIND,
  PROJECT_FILE,
  createRunBucket,
  emptyAndDeleteRunBucket,
  runTag,
  s3Of,
  testStack,
  type Layer,
} from "../../../simetra/test/support"
import {
  heldResource,
  seedMarker,
  seedRuntimeActor,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"
import { REQUEST_ROLE } from "./command-runtime.support"
import {
  ATTACHMENT_READER_ID,
  ATTACHMENT_WRITER_ID,
  storageModel,
} from "./storage-sql.support"

/**
 * Спільне середовище DB-тестів сховища файлів: модель, база з рантайм-логіном,
 * користувачі з правом і без, бакет `run-<тег>` прогону. Профіль визначає
 * стек: Garage на `postgres`, S3 Supabase на `supabase`.
 */

export interface Env {
  url: string
  owner: pg.Client
  catalog: RuntimeCatalog
  pool: pg.Pool
  files: FileStore
  /** Структурний клієнт бакета прогону: для маркера й об'єктів поза портом. */
  s3: ReturnType<typeof s3Of>
  bucket: string
  /** Користувач з `create` будь-якого обсягу й його організація. */
  writer: { org: string; user: string; session: SessionClaims }
  /** Користувач лише з `read`: права `create` немає. */
  reader: { org: string; user: string; session: SessionClaims }
}

/**
 * Вид скоупу `org` з `onRootDelete: "cascade"`: видалення кореня знімає рядки
 * виду каскадом платформи (спека П2 §6), як це роблять застосунки.
 */
export const ORG_ROOT_CASCADE: Layer = {
  [PROJECT_FILE]: {
    scopeKinds: [{ ...ORG_SCOPE_KIND, onRootDelete: "cascade" }],
  },
}

/** Модель сховища, база, роль рантайму й бакет `run-<тег>` прогону на стеку профілю. */
export const heldStorageEnv = (...layers: Layer[]) =>
  heldResource<Env>(async (use) => {
    const model = await storageModel(...layers)
    const stack = testStack()
    const bucket = `run-${runTag()}`
    // Garage — через адмінку, Supabase — S3 `CreateBucket` (Р14)
    if (stack.garageAdminUrl === null)
      await s3Of(stack).createBucket({ Bucket: bucket })
    else await createRunBucket(runTag(), stack, fetch)
    let failure: { error: unknown } | undefined
    try {
      await withModelTarget(model, async (url) => {
        const owner = new pg.Client({ connectionString: url })
        await owner.connect()
        try {
          await seedMarker(owner, model.hash)
          const writer = await seedRuntimeActor(owner, [ATTACHMENT_WRITER_ID])
          const reader = await seedRuntimeActor(owner, [ATTACHMENT_READER_ID])
          await withRuntimeLogin(
            url,
            [PLATFORM_ROLES.command, REQUEST_ROLE],
            async (login) => {
              const pool = new pg.Pool({ connectionString: login })
              try {
                await use({
                  url,
                  owner,
                  catalog: buildRuntimeCatalog(model),
                  pool,
                  files: fromS3Client(s3Of(stack), bucket),
                  s3: s3Of(stack),
                  bucket,
                  writer: { ...writer, session: sessionOf(writer.user) },
                  reader: { ...reader, session: sessionOf(reader.user) },
                })
              } finally {
                await pool.end()
              }
            },
            "runtime_files"
          )
        } finally {
          await owner.end()
        }
      })
    } catch (error) {
      failure = { error }
    }
    // Бакет прогону лишає сторож, але свої об'єкти тест прибирає сам. Збій
    // прибирання не підміняє помилку самого сценарію: її ми й кидаємо
    try {
      await emptyAndDeleteRunBucket(runTag(), stack, { fetch })
    } catch (cleanup) {
      if (failure === undefined) throw cleanup
      console.error("the run bucket was not emptied:", cleanup)
    }
    if (failure !== undefined) throw failure.error
  })
