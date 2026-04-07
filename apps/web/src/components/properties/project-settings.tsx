import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@workspace/ui/components/accordion"
import { Button } from "@workspace/ui/components/button"
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
import { testSupabaseConnection } from "@/lib/supabase-management"
import { useMetadataStore } from "@/stores/metadata-store"
import { saveCredential, loadCredential, clearCredential } from "@/storage/session-db"
import type { Project } from "@simetra/core"

type CredentialStatus = "idle" | "saving" | "saved" | "cleared" | "error"
type ConnectionStatus = "idle" | "checking" | "success" | "error"

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

  // Access Token (PAT) — зберігається в IndexedDB, не у файлах проєкту.
  // Credential ID прив'язаний до projectRef Supabase-проєкту.
  const projectRef = project.deployment?.supabase?.projectRef ?? ""
  const credentialId = projectRef
    ? `supabase-access-token:${projectRef}`
    : ""
  const prevCredentialIdRef = useRef(credentialId)

  const [accessToken, setAccessToken] = useState("")
  const [tokenWarning, setTokenWarning] = useState("")
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>("idle")
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle")
  const [connectionMessage, setConnectionMessage] = useState("")

  useEffect(() => {
    if (!credentialId) return
    let stale = false
    loadCredential(credentialId).then((v) => {
      // Захист від гонки: ігноруємо результат якщо credentialId вже змінився
      if (!stale) {
        setAccessToken(v ?? "")
        setCredentialStatus(v ? "saved" : "idle")
        setConnectionStatus("idle")
        setConnectionMessage("")
      }
    })
    return () => {
      stale = true
    }
  }, [credentialId])

  // При зміні projectRef — очищаємо старий credential і скидаємо стан
  useEffect(() => {
    const prev = prevCredentialIdRef.current
    if (prev && prev !== credentialId) {
      void clearCredential(prev)
    }
    prevCredentialIdRef.current = credentialId
  }, [credentialId])

  const handleUpdate = useCallback(
    (updates: Partial<Project>) => {
      updateProject(updates)
    },
    [updateProject],
  )

  const handleProjectRefChange = useCallback(
    (value: string) => {
      const normalizedValue = normalizeSupabaseProjectRef(value)
      // Скидаємо token при зміні ref — новий ref = новий credential
      setAccessToken("")
      setTokenWarning("")
      setCredentialStatus("idle")
      setConnectionStatus("idle")
      setConnectionMessage("")
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

  const handleAccessTokenChange = useCallback(
    async (value: string) => {
      setAccessToken(value)
      setCredentialStatus("saving")
      setConnectionStatus("idle")
      setConnectionMessage("")
      // Базова валідація формату PAT (warning, не блокуємо)
      if (value && !value.startsWith("sbp_")) {
        setTokenWarning("pat")
      } else {
        setTokenWarning("")
      }
      if (!credentialId) {
        setCredentialStatus("idle")
        return
      }
      if (value) {
        const saved = await saveCredential(credentialId, value)
        setCredentialStatus(saved ? "saved" : "error")
      } else {
        const cleared = await clearCredential(credentialId)
        setCredentialStatus(cleared ? "cleared" : "error")
      }
    },
    [credentialId],
  )

  const handleTestConnection = useCallback(async () => {
    if (!projectRef || !accessToken) return

    setConnectionStatus("checking")
    setConnectionMessage("")

    try {
      const result = await testSupabaseConnection(projectRef, accessToken)
      if (result.ok) {
        setConnectionStatus("success")
        setConnectionMessage(
          result.projectName
            ? t("properties.deployment.connectionSuccessWithName", {
                name: result.projectName,
                status:
                  result.status ?? t("properties.deployment.connectionStatusUnknown"),
              })
            : t("properties.deployment.connectionSuccess", {
                status:
                  result.status ?? t("properties.deployment.connectionStatusUnknown"),
              }),
        )
      } else {
        setConnectionStatus("error")
        setConnectionMessage(
          t("properties.deployment.connectionError", {
            error: result.error,
          }),
        )
      }
    } catch (error) {
      setConnectionStatus("error")
      setConnectionMessage(
        t("properties.deployment.connectionError", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }, [accessToken, projectRef, t])

  const deploymentTarget = project.deployment?.target ?? "none"
  const isProjectRefRequired =
    deploymentTarget === "supabase" && projectRef.trim().length === 0
  const canTestConnection = projectRef.trim().length > 0 && accessToken.trim().length > 0

  const credentialStatusMessage = (() => {
    switch (credentialStatus) {
      case "saving":
        return {
          text: t("properties.deployment.credentialSaving"),
          className: "text-[10px] text-muted-foreground",
        }
      case "saved":
        return {
          text: t("properties.deployment.credentialSaved"),
          className: "text-[10px] text-emerald-600",
        }
      case "cleared":
        return {
          text: t("properties.deployment.credentialCleared"),
          className: "text-[10px] text-muted-foreground",
        }
      case "error":
        return {
          text: t("properties.deployment.credentialSaveError"),
          className: "text-[10px] text-destructive",
        }
      default:
        return null
    }
  })()

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
                  // Очищаємо supabase config — не залишаємо прихованих даних
                  handleUpdate({ deployment: { target: newTarget } })
                  if (credentialId) {
                    void clearCredential(credentialId)
                  }
                  setAccessToken("")
                  setTokenWarning("")
                  setCredentialStatus("idle")
                  setConnectionStatus("idle")
                  setConnectionMessage("")
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
              <SettingRow
                label={`${t("properties.deployment.supabaseProjectRef")} *`}
              >
                <div className="space-y-1">
                  <Input
                    aria-invalid={isProjectRefRequired}
                    className={
                      isProjectRefRequired
                        ? "h-7 border-destructive text-xs"
                        : "h-7 text-xs"
                    }
                    placeholder={t(
                      "properties.deployment.supabaseProjectRefPlaceholder",
                    )}
                    value={projectRef}
                    onChange={(e) => handleProjectRefChange(e.target.value)}
                  />
                  {isProjectRefRequired ? (
                    <p className="text-[10px] text-destructive">
                      {t("properties.deployment.supabaseProjectRefRequired")}
                    </p>
                  ) : projectRef ? (
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
              <SettingRow label={t("properties.deployment.supabaseAccessToken")}>
                <div className="space-y-1">
                  <Input
                    className="h-7 text-xs"
                    type="password"
                    disabled={!projectRef}
                    value={accessToken}
                    onChange={(e) => handleAccessTokenChange(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t("properties.deployment.supabaseAccessTokenHint")}
                  </p>
                  {credentialStatusMessage && (
                    <p className={credentialStatusMessage.className}>
                      {credentialStatusMessage.text}
                    </p>
                  )}
                  {tokenWarning === "pat" && (
                    <p className="text-[10px] text-yellow-600">
                      {t("properties.deployment.supabasePatFormatWarning")}
                    </p>
                  )}
                  <p className="text-[10px] text-yellow-600">
                    {t("properties.deployment.supabaseAccessTokenWarning")}
                  </p>
                </div>
              </SettingRow>
              <SettingRow label={t("properties.deployment.connectionCheck") }>
                <div className="space-y-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!canTestConnection || connectionStatus === "checking"}
                    onClick={() => void handleTestConnection()}
                  >
                    {connectionStatus === "checking"
                      ? t("properties.deployment.connectionChecking")
                      : t("properties.deployment.connectionCheckAction")}
                  </Button>
                  {!canTestConnection && (
                    <p className="text-[10px] text-muted-foreground">
                      {t("properties.deployment.connectionCheckHint")}
                    </p>
                  )}
                  {connectionMessage && (
                    <p
                      className={
                        connectionStatus === "success"
                          ? "text-[10px] text-emerald-600"
                          : "text-[10px] text-destructive"
                      }
                    >
                      {connectionMessage}
                    </p>
                  )}
                </div>
              </SettingRow>
            </>
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
