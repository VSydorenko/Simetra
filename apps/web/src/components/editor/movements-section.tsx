import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { HugeiconsIcon } from "@hugeicons/react"
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons"
import type {
  MetadataKind,
  MetadataObject,
  MetadataRef,
  PostingValidation,
} from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { RegisterPickerDialog } from "./register-picker-dialog"

interface MovementsSectionProps {
  kind: MetadataKind
  objectName: string
  object: MetadataObject
}

type DocumentObject = Extract<MetadataObject, { kind: "Document" }>

export function MovementsSection({
  kind,
  objectName,
  object,
}: MovementsSectionProps) {
  const { t } = useTranslation()
  const updateObject = useMetadataStore((s) => s.updateObject)

  const doc = object as DocumentObject
  const registerMovements = useMemo(
    () => doc.registerMovements ?? [],
    [doc.registerMovements],
  )

  // Posting секція — структурна або boolean
  const postingData =
    typeof doc.posting === "object" && doc.posting !== null ? doc.posting : null
  const validations = postingData?.validations ?? []

  // --- Register picker dialog ---
  const [pickerOpen, setPickerOpen] = useState(false)

  const handleAddRegisters = useCallback(
    (refs: MetadataRef[]) => {
      const existing = new Set(
        registerMovements.map((r) => `${r.kind}/${r.name}`),
      )
      const newRefs = refs.filter(
        (r) => !existing.has(`${r.kind}/${r.name}`),
      )
      if (newRefs.length === 0) return

      const updated = [...registerMovements, ...newRefs]
      updateObject(kind, objectName, {
        registerMovements: updated,
      } as Partial<MetadataObject>)
    },
    [registerMovements, kind, objectName, updateObject],
  )

  const handleRemoveRegister = useCallback(
    (ref: MetadataRef) => {
      const updatedRegs = registerMovements.filter(
        (r) => !(r.kind === ref.kind && r.name === ref.name),
      )

      // Атомарне оновлення: registerMovements + posting за один виклик
      const patch: Record<string, unknown> = {
        registerMovements: updatedRegs,
      }
      if (postingData) {
        patch.posting = {
          movements: postingData.movements.filter(
            (m) =>
              !(m.register.kind === ref.kind && m.register.name === ref.name),
          ),
          validations: postingData.validations.filter(
            (v) =>
              !(v.register.kind === ref.kind && v.register.name === ref.name),
          ),
        }
      }
      updateObject(kind, objectName, patch as Partial<MetadataObject>)
    },
    [registerMovements, kind, objectName, updateObject, postingData],
  )

  // --- Validations ---
  const handleAddValidation = useCallback(() => {
    if (registerMovements.length === 0) return
    const firstReg = registerMovements[0]
    const template: PostingValidation = {
      type: "NonNegativeBalance" as const,
      register: { kind: firstReg.kind, name: firstReg.name },
      dimensions: [],
      resource: "",
      message: { uk: "", en: "" },
      applyTo: "Expense" as const,
    }
    const current = postingData ?? { movements: [], validations: [] }
    updateObject(kind, objectName, {
      posting: {
        ...current,
        validations: [...current.validations, template],
      },
    } as Partial<MetadataObject>)
  }, [registerMovements, kind, objectName, updateObject, postingData])

  const handleRemoveValidation = useCallback(
    (index: number) => {
      if (!postingData) return
      const updated = postingData.validations.filter((_, i) => i !== index)
      updateObject(kind, objectName, {
        posting: { ...postingData, validations: updated },
      } as Partial<MetadataObject>)
    },
    [kind, objectName, updateObject, postingData],
  )

  // Знаходимо movement info для кожного регістру
  const movementInfoMap = useMemo(() => {
    if (!postingData) return new Map<string, { movementType: string; source: string }>()
    const map = new Map<string, { movementType: string; source: string }>()
    for (const m of postingData.movements) {
      map.set(`${m.register.kind}/${m.register.name}`, {
        movementType: m.movementType,
        source: m.source,
      })
    }
    return map
  }, [postingData])

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {/* Таблиця регістрів для рухів */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">
              {t("properties.registerMovements")}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setPickerOpen(true)}
              >
                <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1" />
                {t("action.add")}
              </Button>
            </div>
          </div>

          <RegisterMovementsTable
            registerMovements={registerMovements}
            movementInfoMap={movementInfoMap}
            onRemove={handleRemoveRegister}
          />
        </div>

        {/* Таблиця валідацій */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">
              {t("movements.validations", "Валідації")}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={registerMovements.length === 0}
              onClick={handleAddValidation}
            >
              <HugeiconsIcon icon={Add01Icon} size={14} className="mr-1" />
              {t("action.add")}
            </Button>
          </div>
          {validations.length > 0 ? (
            <ValidationsTable
              validations={validations}
              onRemove={handleRemoveValidation}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("movements.noValidations", "Немає валідацій")}
            </p>
          )}
        </div>
      </div>

      <RegisterPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingRefs={registerMovements}
        onSave={handleAddRegisters}
      />
    </ScrollArea>
  )
}

function RegisterMovementsTable({
  registerMovements,
  movementInfoMap,
  onRemove,
}: {
  registerMovements: MetadataRef[]
  movementInfoMap: Map<string, { movementType: string; source: string }>
  onRemove: (ref: MetadataRef) => void
}) {
  const { t } = useTranslation()

  if (registerMovements.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("movements.noRegisters", "Немає регістрів для рухів")}
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="h-7 text-xs">
            {t("movements.register", "Регістр")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.movementType", "Тип руху")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.source", "Джерело")}
          </TableHead>
          <TableHead className="h-7 w-10 text-xs" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {registerMovements.map((ref) => {
          const info = movementInfoMap.get(`${ref.kind}/${ref.name}`)
          return (
            <TableRow key={`${ref.kind}/${ref.name}`}>
              <TableCell className="py-1 text-xs font-mono">
                {ref.name}
              </TableCell>
              <TableCell className="py-1 text-xs">
                {info?.movementType ?? "—"}
              </TableCell>
              <TableCell className="py-1 text-xs">
                {info?.source ?? "—"}
              </TableCell>
              <TableCell className="py-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-destructive hover:text-destructive"
                  onClick={() => onRemove(ref)}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={12} />
                </Button>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function ValidationsTable({
  validations,
  onRemove,
}: {
  validations: PostingValidation[]
  onRemove: (index: number) => void
}) {
  const { t } = useTranslation()

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="h-7 text-xs">
            {t("movements.register", "Регістр")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.dimensions", "Виміри")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.resource", "Ресурс")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.message", "Повідомлення")}
          </TableHead>
          <TableHead className="h-7 w-10 text-xs" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {validations.map((v, index) => (
          <TableRow key={index}>
            <TableCell className="py-1 text-xs font-mono">
              {v.register.name}
            </TableCell>
            <TableCell className="py-1 text-xs">
              {v.dimensions.join(", ")}
            </TableCell>
            <TableCell className="py-1 text-xs">{v.resource}</TableCell>
            <TableCell className="py-1 text-xs">
              {v.message?.uk ?? v.message?.en ?? "—"}
            </TableCell>
            <TableCell className="py-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-destructive hover:text-destructive"
                onClick={() => onRemove(index)}
              >
                <HugeiconsIcon icon={Delete02Icon} size={12} />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
