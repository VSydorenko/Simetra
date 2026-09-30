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
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command"
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
    [onOpenChange]
  )

  // Перенаправити фокус у Command list для keyboard navigation
  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      if (references.length > 0) {
        e.preventDefault()
        const cmd = (e.currentTarget as HTMLElement).querySelector(
          '[data-slot="command"]'
        )
        if (cmd instanceof HTMLElement) cmd.focus()
      }
    },
    [references.length]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={handleOpenAutoFocus}
      >
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
          <Command
            className="rounded-none bg-transparent p-0"
            shouldFilter={false}
            tabIndex={-1}
          >
            <CommandList className="max-h-64">
              <CommandEmpty>{t("dialog.whereUsedEmpty")}</CommandEmpty>
              {references.map((ref) => {
                const icon = KIND_ICONS[ref.from.kind]
                const colorClass = KIND_COLORS[ref.from.kind]
                const fmt = formatReference(ref)
                const fieldDisplay = fmt.fieldName
                  ? fmt.tabularSectionName
                    ? `${fmt.tabularSectionName}.${fmt.fieldName}`
                    : fmt.fieldName
                  : null
                return (
                  <CommandItem
                    key={`${ref.from.kind}/${ref.from.name}/${ref.referenceKind}/${ref.fieldName ?? ""}/${ref.tabularSectionName ?? ""}`}
                    onSelect={() => handleNavigate(ref)}
                    className="gap-2"
                  >
                    <HugeiconsIcon
                      icon={icon}
                      size={12}
                      className={colorClass}
                    />
                    <span className="font-mono text-xs">{ref.from.name}</span>
                    {fieldDisplay && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {fieldDisplay}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t(`referenceKind.${ref.referenceKind}`, {
                        defaultValue: ref.referenceKind,
                      })}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
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
