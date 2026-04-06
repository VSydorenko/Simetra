import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { useDdlStore } from "@/stores/ddl-store"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { SqlFileTree } from "./sql-file-tree"
import { SqlViewer } from "./sql-viewer"
import { SqlToolbar } from "./sql-toolbar"

export function SqlPreviewPanel() {
  const { t } = useTranslation()
  const output = useDdlStore((s) => s.output)
  const generationError = useDdlStore((s) => s.generationError)
  const validationErrors = useDdlStore((s) => s.validationErrors)
  const clearValidationErrors = useDdlStore((s) => s.clearValidationErrors)
  const generateDdlForce = useDdlStore((s) => s.generateDdlForce)

  if (validationErrors.length > 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4">
        <div className="max-w-lg">
          <p className="text-sm font-medium text-destructive">
            {t("sqlPreview.validationErrors")}
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {validationErrors.map((e, i) => (
              <li key={i}>
                {"\u2022"} {e}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" size="sm" onClick={clearValidationErrors}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                generateDdlForce()
                clearValidationErrors()
              }}
            >
              {t("sqlPreview.generateAnyway")}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (generationError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-destructive">
            {t("sqlPreview.generationError")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {generationError}
          </p>
        </div>
      </div>
    )
  }

  if (!output) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("sqlPreview.noOutput")}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <SqlToolbar />
      {output.warnings.length > 0 && (
        <Collapsible defaultOpen={false}>
          <CollapsibleTrigger className="flex w-full items-center gap-1 border-b border-border bg-warning/5 px-3 py-1 text-xs text-warning hover:bg-warning/10">
            <span>⚠</span>
            <span>
              {t("sqlPreview.warningCount", { count: output.warnings.length })}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-b border-border bg-warning/5 px-3 py-2">
              <ul className="space-y-0.5 text-xs text-warning">
                {output.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-1 overflow-hidden">
        {output.files.length > 1 && (
          <div className="w-52 shrink-0 overflow-auto border-r border-border">
            <SqlFileTree files={output.files} />
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <SqlViewer />
        </div>
      </div>
    </div>
  )
}
