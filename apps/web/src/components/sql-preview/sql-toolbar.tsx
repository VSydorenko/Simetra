import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Download04Icon, FolderZipIcon } from "@hugeicons/core-free-icons"
import { useDdlStore } from "@/stores/ddl-store"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export function SqlToolbar() {
  const { t } = useTranslation()
  const output = useDdlStore((s) => s.output)
  const selectedFilePath = useDdlStore((s) => s.selectedFilePath)

  const isMultiFile = (output?.files.length ?? 0) > 1

  // Знайти вміст вибраного файлу
  const selectedFile =
    output?.files.find((f) => f.path === selectedFilePath) ?? output?.files[0]

  const handleCopy = useCallback(async () => {
    if (!output) return
    if (isMultiFile && selectedFile) {
      await navigator.clipboard.writeText(selectedFile.content)
    } else {
      const allSql = output.files.map((f) => f.content).join("\n\n")
      await navigator.clipboard.writeText(allSql)
    }
  }, [output, isMultiFile, selectedFile])

  const handleDownload = useCallback(() => {
    if (!output) return
    if (isMultiFile && selectedFile) {
      const blob = new Blob([selectedFile.content], { type: "application/sql" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = selectedFile.path
      a.click()
      URL.revokeObjectURL(url)
    } else {
      const allSql = output.files.map((f) => f.content).join("\n\n")
      const blob = new Blob([allSql], { type: "application/sql" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "schema.sql"
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [output, isMultiFile, selectedFile])

  const handleDownloadAll = useCallback(() => {
    if (!output) return
    const allSql = output.files.map((f) => f.content).join("\n\n")
    const blob = new Blob([allSql], { type: "application/sql" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "schema.sql"
    a.click()
    URL.revokeObjectURL(url)
  }, [output])

  const copyLabel = isMultiFile ? t("sqlPreview.copyFile") : t("sqlPreview.copyAll")
  const downloadLabel = isMultiFile
    ? t("sqlPreview.downloadFile")
    : t("sqlPreview.download")

  const warningCount = output?.warnings.length ?? 0

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleCopy}
            aria-label={copyLabel}
          >
            <HugeiconsIcon
              icon={Copy01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{copyLabel}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleDownload}
            aria-label={downloadLabel}
          >
            <HugeiconsIcon
              icon={Download04Icon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {downloadLabel}
        </TooltipContent>
      </Tooltip>

      {isMultiFile && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handleDownloadAll}
              aria-label={t("sqlPreview.downloadAll")}
            >
              <HugeiconsIcon
                icon={FolderZipIcon}
                strokeWidth={2}
                className="size-4"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("sqlPreview.downloadAll")}
          </TooltipContent>
        </Tooltip>
      )}

      {warningCount > 0 && (
        <Badge
          variant="outline"
          className="ml-2 border-warning/30 text-warning"
        >
          {t("sqlPreview.warningCount", { count: warningCount })}
        </Badge>
      )}
    </div>
  )
}
