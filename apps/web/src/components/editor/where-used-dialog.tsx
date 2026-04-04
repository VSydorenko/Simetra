import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { HugeiconsIcon } from "@hugeicons/react"
import type { Reference } from "@simetra/core"
import { formatReference } from "@simetra/core"
import { KIND_ICONS, KIND_COLORS } from "@/lib/metadata-icons"
import { useUiStore } from "@/stores/ui-store"

interface WhereUsedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  objectName: string
  references: Reference[]
}

export function WhereUsedDialog({
  open,
  onOpenChange,
  objectName,
  references,
}: WhereUsedDialogProps) {
  const { t } = useTranslation()

  const handleNavigate = useCallback(
    (ref: Reference) => {
      useUiStore.getState().focusEntity(ref.from)
      onOpenChange(false)
    },
    [onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t("dialog.whereUsedTitle", { name: objectName })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialog.whereUsedTitle", { name: objectName })}
          </DialogDescription>
        </DialogHeader>

        {references.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("dialog.whereUsedEmpty")}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-1 pr-3 font-medium">
                    {t("dialog.whereUsedObject")}
                  </th>
                  <th className="pb-1 pr-3 font-medium">
                    {t("dialog.whereUsedField")}
                  </th>
                  <th className="pb-1 font-medium">
                    {t("dialog.whereUsedRefKind")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {references.map((ref, i) => {
                  const icon = KIND_ICONS[ref.from.kind]
                  const colorClass = KIND_COLORS[ref.from.kind]
                  return (
                    <tr
                      key={i}
                      className="cursor-pointer border-b border-border/50 hover:bg-accent/50"
                      onClick={() => handleNavigate(ref)}
                    >
                      <td className="flex items-center gap-1.5 py-1.5 pr-3">
                        {icon && (
                          <HugeiconsIcon
                            icon={icon}
                            size={12}
                            className={colorClass}
                          />
                        )}
                        <span className="font-mono">{ref.from.name}</span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                        {formatReference(ref)}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {ref.referenceKind}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("action.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
