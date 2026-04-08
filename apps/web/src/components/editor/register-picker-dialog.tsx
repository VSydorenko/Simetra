import { useCallback, useMemo, useState } from "react"
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
import type { MetadataKind, MetadataRef } from "@simetra/core"
import { isPostingCompatible } from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { computeKindCheckedStates } from "@/lib/kind-checked-states"
import { MetadataObjectTreeSelector } from "./metadata-object-tree-selector"

const REGISTER_KINDS: readonly MetadataKind[] = [
  "AccumulationRegister",
  "InformationRegister",
]

interface RegisterPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  documentRef: MetadataRef
  /** Вже додані регістри (для pre-check) */
  existingRefs: MetadataRef[]
  /** Callback при Save — повертає обрані MetadataRef[] */
  onSave: (refs: MetadataRef[]) => void
}

export function RegisterPickerDialog({
  open,
  onOpenChange,
  documentRef,
  existingRefs,
  onSave,
}: RegisterPickerDialogProps) {
  const handleCancel = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const [revisionKey, setRevisionKey] = useState(0)
  const handleOpen = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        handleCancel()
      } else {
        setRevisionKey((k) => k + 1)
      }
    },
    [handleCancel]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <RegisterPickerBody
            key={revisionKey}
            documentRef={documentRef}
            existingRefs={existingRefs}
            onSave={onSave}
            onCancel={handleCancel}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RegisterPickerBody({
  documentRef,
  existingRefs,
  onSave,
  onCancel,
}: {
  documentRef: MetadataRef
  existingRefs: MetadataRef[]
  onSave: (refs: MetadataRef[]) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const model = useMetadataStore((s) => s.model)

  // Фільтруємо несумісні регістри щоб вони не зʼявлялись у picker
  const filteredModel = useMemo(
    () => ({
      ...model,
      informationRegisters: model.informationRegisters.filter((register) =>
        isPostingCompatible(register, { recorder: documentRef }).compatible
      ),
      accumulationRegisters: model.accumulationRegisters.filter((register) =>
        isPostingCompatible(register, { recorder: documentRef }).compatible
      ),
    }),
    [documentRef, model]
  )

  // Local draft — починаємо з existingRefs (pre-checked)
  const [selectedRefs, setSelectedRefs] = useState<MetadataRef[]>(() =>
    structuredClone(existingRefs)
  )
  const [searchQuery, setSearchQuery] = useState("")

  const selectedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const ref of selectedRefs) {
      ids.add(`ref/${ref.kind}/${ref.name}`)
    }
    return ids
  }, [selectedRefs])

  const kindCheckedStates = useMemo(
    () => computeKindCheckedStates(filteredModel, REGISTER_KINDS, selectedRefs),
    [filteredModel, selectedRefs]
  )

  const handleSelectTarget = useCallback((ref: MetadataRef) => {
    setSelectedRefs((prev) => {
      const exists = prev.some(
        (r) => r.kind === ref.kind && r.name === ref.name
      )
      if (exists) {
        return prev.filter((r) => !(r.kind === ref.kind && r.name === ref.name))
      }
      return [...prev, ref]
    })
  }, [])

  const handleToggleKindGroup = useCallback(
    (kind: MetadataKind) => {
      const modelKey = KIND_TO_KEY[kind]
      const objects = (filteredModel[modelKey] as { name: string }[]) ?? []
      const kindTargets: MetadataRef[] = objects.map((obj) => ({
        kind,
        name: obj.name,
      }))

      setSelectedRefs((prev) => {
        const allSelected = kindTargets.every((kt) =>
          prev.some((r) => r.kind === kt.kind && r.name === kt.name)
        )
        if (allSelected) {
          return prev.filter(
            (r) =>
              !kindTargets.some(
                (kt) => kt.kind === r.kind && kt.name === r.name
              )
          )
        }
        const toAdd = kindTargets.filter(
          (kt) => !prev.some((r) => r.kind === kt.kind && r.name === kt.name)
        )
        return [...prev, ...toAdd]
      })
    },
    [filteredModel]
  )

  const isDirty = useMemo(() => {
    if (selectedRefs.length !== existingRefs.length) return true
    const existingSet = new Set(existingRefs.map((r) => `${r.kind}/${r.name}`))
    return selectedRefs.some((r) => !existingSet.has(`${r.kind}/${r.name}`))
  }, [selectedRefs, existingRefs])

  const handleSave = useCallback(() => {
    onSave(selectedRefs)
    onCancel()
  }, [selectedRefs, onSave, onCancel])

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {t("movements.pickRegisters", "Вибір регістрів")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("movements.pickRegisters", "Вибір регістрів")}
        </DialogDescription>
      </DialogHeader>

      <MetadataObjectTreeSelector
        model={filteredModel}
        allowedKinds={REGISTER_KINDS}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedIds={selectedIds}
        mode="checkbox"
        includePrimitives={false}
        onSelectTarget={handleSelectTarget}
        onToggleKindGroup={handleToggleKindGroup}
        kindCheckedStates={kindCheckedStates}
        height={320}
      />

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("action.cancel")}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!isDirty}>
          {t("action.save")}
        </Button>
      </DialogFooter>
    </>
  )
}
