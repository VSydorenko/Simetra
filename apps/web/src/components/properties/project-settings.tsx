import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useMetadataStore } from "@/stores/metadata-store"
import { saveCredential, loadCredential, clearCredential } from "@/storage/session-db"
import type { Project } from "@simetra/core"

function SettingRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr] items-center gap-2">
      <Label className="truncate text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  )
}

export function ProjectSettings() {
  const { t } = useTranslation()
  const project = useMetadataStore((s) => s.model.project)
  const updateProject = useMetadataStore((s) => s.updateProject)

  // API key — зберігається в IndexedDB, не у файлах проєкту.
  // Credential ID прив'язаний до URL Supabase-проєкту, а не до назви метаданих:
  // якщо URL відсутній — fallback на project.name (до першого збереження URL).
  const supabaseProjectUrl = project.deployment?.supabase?.projectUrl ?? ""
  const credentialId = supabaseProjectUrl
    ? `supabase-api-key:${supabaseProjectUrl}`
    : `supabase-api-key:name:${project.name}`

  const [supabaseApiKey, setSupabaseApiKey] = useState("")

  useEffect(() => {
    loadCredential(credentialId).then((v) => setSupabaseApiKey(v ?? ""))
  }, [credentialId])

  const handleApiKeyChange = useCallback(
    async (value: string) => {
      setSupabaseApiKey(value)
      if (value) {
        await saveCredential(credentialId, value)
      } else {
        await clearCredential(credentialId)
      }
    },
    [credentialId]
  )

  const handleUpdate = useCallback(
    (updates: Partial<Project>) => {
      updateProject(updates)
    },
    [updateProject]
  )

  const deploymentTarget = project.deployment?.target ?? "none"

  return (
    <Accordion
      type="multiple"
      defaultValue={["general", "database", "generation"]}
      className="w-full"
    >
      {/* Основні */}
      <AccordionItem value="general">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t("properties.group.general")}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t("project.name")}>
            <Input
              className="h-7 text-xs"
              value={project.name}
              onChange={(e) => handleUpdate({ name: e.target.value })}
            />
          </SettingRow>
          <SettingRow label={t("editor.displayNameUk")}>
            <Input
              className="h-7 text-xs"
              value={project.displayName?.uk ?? ""}
              onChange={(e) =>
                handleUpdate({
                  displayName: {
                    ...project.displayName,
                    uk: e.target.value || undefined,
                  },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t("editor.displayNameEn")}>
            <Input
              className="h-7 text-xs"
              value={project.displayName?.en ?? ""}
              onChange={(e) =>
                handleUpdate({
                  displayName: {
                    ...project.displayName,
                    en: e.target.value || undefined,
                  },
                })
              }
            />
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Database */}
      <AccordionItem value="database">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t("properties.group.database")}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t("properties.database.target")}>
            <Input
              className="h-7 text-xs"
              value={project.database.target}
              readOnly
              disabled
            />
          </SettingRow>
          <SettingRow label={t("properties.database.schema")}>
            <Input
              className="h-7 text-xs"
              value={project.database.schema}
              onChange={(e) =>
                handleUpdate({
                  database: { ...project.database, schema: e.target.value },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t("properties.database.namingConvention")}>
            <Select
              value={project.database.namingConvention}
              onValueChange={(v) =>
                handleUpdate({
                  database: {
                    ...project.database,
                    namingConvention: v as "snake_case" | "camelCase",
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="snake_case" className="text-xs">
                  snake_case
                </SelectItem>
                <SelectItem value="camelCase" className="text-xs">
                  camelCase
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Generation */}
      <AccordionItem value="generation">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t("properties.group.generation")}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t("properties.generation.tablePrefix")}>
            <Input
              className="h-7 text-xs"
              value={project.generation.tablePrefix}
              onChange={(e) =>
                handleUpdate({
                  generation: {
                    ...project.generation,
                    tablePrefix: e.target.value,
                  },
                })
              }
            />
          </SettingRow>
          <SettingRow label={t("properties.generation.enumStrategy")}>
            <Select
              value={project.generation.enumStrategy}
              onValueChange={(v) =>
                handleUpdate({
                  generation: {
                    ...project.generation,
                    enumStrategy: v as "pgEnum" | "lookupTable",
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pgEnum" className="text-xs">
                  pgEnum
                </SelectItem>
                <SelectItem value="lookupTable" className="text-xs">
                  lookupTable
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label={t("properties.generation.constantsStrategy")}>
            <Select
              value={project.generation.constantsStrategy}
              onValueChange={(v) =>
                handleUpdate({
                  generation: {
                    ...project.generation,
                    constantsStrategy: v as "singleTable" | "separateTables",
                  },
                })
              }
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="singleTable" className="text-xs">
                  singleTable
                </SelectItem>
                <SelectItem value="separateTables" className="text-xs">
                  separateTables
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </AccordionContent>
      </AccordionItem>

      {/* Deployment */}
      <AccordionItem value="deployment">
        <AccordionTrigger className="px-3 py-2 text-xs font-medium">
          {t("properties.deployment.title")}
        </AccordionTrigger>
        <AccordionContent className="space-y-2 px-3 pb-3">
          <SettingRow label={t("properties.deployment.target")}>
            <Select
              value={deploymentTarget}
              onValueChange={(v) => {
                const newTarget = v as "supabase" | "manual" | "none"
                if (newTarget !== "supabase") {
                  // Очищаємо supabase config — не залишаємо прихованих даних
                  handleUpdate({ deployment: { target: newTarget } })
                  void clearCredential(credentialId)
                  setSupabaseApiKey("")
                } else {
                  handleUpdate({
                    deployment: { ...project.deployment, target: newTarget },
                  })
                }
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">
                  {t("properties.deployment.targetNone")}
                </SelectItem>
                <SelectItem value="supabase" className="text-xs">
                  {t("properties.deployment.targetSupabase")}
                </SelectItem>
                <SelectItem value="manual" className="text-xs">
                  {t("properties.deployment.targetManual")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          {deploymentTarget === "supabase" && (
            <>
              <SettingRow label={t("properties.deployment.supabaseProjectUrl")}>
                <Input
                  className="h-7 text-xs"
                  placeholder={t("properties.deployment.supabaseUrlPlaceholder")}
                  value={project.deployment?.supabase?.projectUrl ?? ""}
                  onChange={(e) =>
                    handleUpdate({
                      deployment: {
                        ...project.deployment,
                        target: "supabase",
                        supabase: { projectUrl: e.target.value },
                      },
                    })
                  }
                />
              </SettingRow>
              <SettingRow label={t("properties.deployment.supabaseApiKey")}>
                <div className="space-y-1">
                  <Input
                    className="h-7 text-xs"
                    type="password"
                    value={supabaseApiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t("properties.deployment.supabaseApiKeyHint")}
                  </p>
                </div>
              </SettingRow>
            </>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
