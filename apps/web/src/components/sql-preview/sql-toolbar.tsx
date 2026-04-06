import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, Download04Icon } from "@hugeicons/core-free-icons"
import { useDdlStore } from "@/stores/ddl-store"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export function SqlToolbar() {
  const { t } = useTranslation()
  const output = useDdlStore((s) => s.output)

  const handleCopyAll = useCallback(async () => {
    if (!output) return
    const allSql = output.files.map((f) => f.content).join("\n\n")
    await navigator.clipboard.writeText(allSql)
  }, [output])

  const handleDownload = useCallback(() => {
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

  const warningCount = output?.warnings.length ?? 0

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleCopyAll}
            aria-label={t("sqlPreview.copyAll")}
          >
            <HugeiconsIcon
              icon={Copy01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("sqlPreview.copyAll")}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleDownload}
            aria-label={t("sqlPreview.download")}
          >
            <HugeiconsIcon
              icon={Download04Icon}
              strokeWidth={2}
              className="size-4"
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("sqlPreview.download")}
        </TooltipContent>
      </Tooltip>

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
