import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { compile } from "simetra/compiler"
import {
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLAN_FORMAT,
  PLATFORM_VERSION,
  planFileName,
  serializePlan,
  stampPlan,
  type CatalogFingerprint,
  type FingerprintSection,
  type PlanArtifact,
} from "simetra/schema"
import { readMetadataDir } from "../../io/metadata-dir"
import { createPgDeltaEngine } from "../../schema-engine"

export const fingerprint = (): CatalogFingerprint => ({
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((s) => [s, "a".repeat(64)])
  ) as Record<FingerprintSection, string>,
})

/** Факти сервера, які план прочитав з цілі. */
export const SERVER: PlanArtifact["server"] = {
  major: 17,
  encoding: "UTF8",
  collate: "C.UTF-8",
  ctype: "C.UTF-8",
  localeProvider: "c",
  locale: null,
  collationVersion: null,
}

/** Чинний план без кроків для еталонних метаданих у `plans/` кореня. */
export async function writePlan(
  dir: string,
  promotion: PlanArtifact["promotion"] = null,
  provider: "supabase" | "postgres" = "supabase"
): Promise<{ file: string; artifact: PlanArtifact }> {
  const model = (await compile(await readMetadataDir(dir))).model
  if (model === undefined) throw new Error("reference metadata must compile")
  const artifact = await stampPlan({
    format: PLAN_FORMAT,
    platformVersion: PLATFORM_VERSION,
    engine: createPgDeltaEngine().identity,
    fingerprintVersion: FINGERPRINT_VERSION,
    fromHash: null,
    toHash: model.hash,
    scope: { schemas: ["app"], provider },
    targetFingerprint: fingerprint(),
    desiredFingerprint: fingerprint(),
    steps: [],
    requiredPermissions: [],
    drift: null,
    role: "postgres",
    server: SERVER,
    ledgerHead: null,
    locks: [],
    implicitLocks: [],
    providerLocks: [],
    foreignKeys: { subjects: [], live: [] },
    preamble: [],
    revalidationSearchPath: '"$user", public',
    plpgsqlCheck: "transient",
    platformFunctions: [],
    desiredInvalid: [],
    promotion,
    environment: { defaultPrivileges: [] },
    resultCatalog: { tables: [], enumTypes: [], units: [] },
  })
  const file = `plans/${planFileName(null, model.hash)}`
  const path = join(dirname(dir), file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializePlan(artifact))
  return { file, artifact }
}
