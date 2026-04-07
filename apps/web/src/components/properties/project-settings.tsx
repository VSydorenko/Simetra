import { useCallback } from "react"
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
import { normalizeSupabaseProjectRef } from "@/lib/normalize-supabase-project-ref"
import { useMetadataStore } from "@/stores/metadata-store"
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

  const projectRef = project.deployment?.supabase?.projectRef ?? ""

  const handleUpdate = useCallback(
    (updates: Partial<Project>) => {
      updateProject(updates)
    },
    [updateProject],
  )

  const handleProjectRefChange = useCallback(
    (value: string) => {
      const normalizedValue = normalizeSupabaseProjectRef(value)
      handleUpdate({
        deployment: {
          ...project.deployment,
          target: "supabase",
          supabase: { projectRef: normalizedValue },
        },
      })
    },
    [handleUpdate, project.deployment],
  )

  const deploymentTarget = project.deployment?.target ?? "none"

  const supabaseSqlEditorUrl = projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/sql/new`
    : ""
  const supabaseTableEditorUrl = projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/editor`
    : ""

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
                  handleUpdate({ deployment: { target: newTarget } })
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
              <SettingRow label={t("properties.deployment.supabaseProjectRef")}>
                <div className="space-y-1">
                  <Input
                    className="h-7 text-xs"
                    placeholder={t(
                      "properties.deployment.supabaseProjectRefPlaceholder",
                    )}
                    value={projectRef}
                    onChange={(e) => handleProjectRefChange(e.target.value)}
                  />
                  {projectRef ? (
                    <p className="text-[10px] text-muted-foreground">
                      {t("properties.deployment.supabaseDerivedUrl", {
                        ref: projectRef,
                      })}
                    </p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      {t("properties.deployment.supabaseProjectRefHint")}
                    </p>
                  )}
                </div>
              </SettingRow>
              <div className="space-y-1 px-1">
                <div className="flex gap-2">
                  <a
                    href={supabaseSqlEditorUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`text-[10px] underline ${projectRef ? "text-primary" : "pointer-events-none text-muted-foreground"}`}
                    aria-disabled={!projectRef}
                  >
                    {t("properties.deployment.supabaseOpenSqlEditor")}
                  </a>
                  <a
                    href={supabaseTableEditorUrl || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`text-[10px] underline ${projectRef ? "text-primary" : "pointer-events-none text-muted-foreground"}`}
                    aria-disabled={!projectRef}
                  >
                    {t("properties.deployment.supabaseOpenTableEditor")}
                  </a>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("properties.deployment.supabaseApplyHint")}
                </p>
              </div>
            </>
          )}

          {deploymentTarget === "manual" && (
            <div className="px-1">
              <p className="text-[10px] text-muted-foreground">
                {t("properties.deployment.manualApplyHint")}
              </p>
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
