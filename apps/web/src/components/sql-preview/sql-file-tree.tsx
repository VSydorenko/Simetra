import { useTranslation } from "react-i18next"
import { cn } from "@workspace/ui/lib/utils"
import { useDdlStore } from "@/stores/ddl-store"
import type { GeneratedFile } from "@simetra/generator-api"
import { HugeiconsIcon } from "@hugeicons/react"
import { Download04Icon } from "@hugeicons/core-free-icons"

interface SqlFileTreeProps {
  files: GeneratedFile[]
}

function downloadFile(file: GeneratedFile) {
  const blob = new Blob([file.content], { type: "application/sql" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = file.path
  a.click()
  URL.revokeObjectURL(url)
}

export function SqlFileTree({ files }: SqlFileTreeProps) {
  const { t } = useTranslation()
  const selectedFilePath = useDdlStore((s) => s.selectedFilePath)
  const selectFile = useDdlStore((s) => s.selectFile)

  return (
    <div className="py-1">
      {files.map((file) => (
        <div
          key={file.path}
          className={cn(
            "flex w-full items-center gap-1.5 px-3 py-1 text-xs",
            "transition-colors hover:bg-accent/50",
            selectedFilePath === file.path &&
              "bg-accent text-accent-foreground",
          )}
        >
          <button
            type="button"
            className="flex-1 truncate text-left font-mono"
            onClick={() => selectFile(file.path)}
          >
            {file.path}
          </button>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 [div:hover>&]:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              downloadFile(file)
            }}
            aria-label={t("sqlPreview.download") + ` ${file.path}`}
          >
            <HugeiconsIcon
              icon={Download04Icon}
              strokeWidth={2}
              className="size-3"
            />
          </button>
        </div>
      ))}
    </div>
  )
}
