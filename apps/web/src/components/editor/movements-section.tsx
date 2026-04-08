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
import { Add01Icon, Delete02Icon, Edit02Icon } from "@hugeicons/core-free-icons"
import type {
  MetadataKind,
  MetadataObject,
  MetadataRef,
  PostingMovement,
  PostingValidation,
} from "@simetra/core"
import { useMetadataStore } from "@/stores/metadata-store"
import { RegisterPickerDialog } from "./register-picker-dialog"
import { MovementConstructorDialog } from "./movement-constructor-dialog"

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
  const storeUpdateMovement = useMetadataStore((s) => s.updateMovement)
  const storeAddPostingValidation = useMetadataStore(
    (s) => s.addPostingValidation,
  )
  const storeRemovePostingValidation = useMetadataStore(
    (s) => s.removePostingValidation,
  )

  const doc = object as DocumentObject
  const registerMovements = useMemo(
    () => doc.registerMovements ?? [],
    [doc.registerMovements]
  )

  // Posting секція — optional object
  const postingData =
    typeof doc.posting === "object" && doc.posting !== null ? doc.posting : null
  const validations = postingData?.validations ?? []

  // --- Register picker dialog ---
  const [pickerOpen, setPickerOpen] = useState(false)

  // --- Movement constructor dialog ---
  const [constructorOpen, setConstructorOpen] = useState(false)
  const [selectedRegisterRef, setSelectedRegisterRef] =
    useState<MetadataRef | null>(null)

  const selectedMovement = useMemo(() => {
    if (!selectedRegisterRef || !postingData) return null
    return (
      postingData.movements.find(
        (m) =>
          m.register.kind === selectedRegisterRef.kind &&
          m.register.name === selectedRegisterRef.name
      ) ?? null
    )
  }, [selectedRegisterRef, postingData])

  const handleOpenConstructor = useCallback((ref: MetadataRef) => {
    setSelectedRegisterRef(ref)
    setConstructorOpen(true)
  }, [])

  const handleSaveMovement = useCallback(
    (movement: PostingMovement) => {
      return storeUpdateMovement(objectName, movement.register, movement)
    },
    [objectName, storeUpdateMovement],
  )

  const handleAddRegisters = useCallback(
    (refs: MetadataRef[]) => {
      const existing = new Set(
        registerMovements.map((r) => `${r.kind}/${r.name}`)
      )
      const newRefs = refs.filter((r) => !existing.has(`${r.kind}/${r.name}`))
      if (newRefs.length === 0) return

      const updated = [...registerMovements, ...newRefs]
      updateObject(kind, objectName, {
        registerMovements: updated,
      } as Partial<MetadataObject>)
    },
    [registerMovements, kind, objectName, updateObject]
  )

  const handleRemoveRegister = useCallback(
    (ref: MetadataRef) => {
      const updatedRegs = registerMovements.filter(
        (r) => !(r.kind === ref.kind && r.name === ref.name),
      )
      // Sync posting ↔ registerMovements тепер обробляється в store
      updateObject(kind, objectName, {
        registerMovements: updatedRegs,
      } as Partial<MetadataObject>)
    },
    [registerMovements, kind, objectName, updateObject],
  )

  // --- Validations ---
  const model = useMetadataStore((s) => s.model)

  const handleAddValidation = useCallback(() => {
    if (registerMovements.length === 0) return
    const firstReg = registerMovements[0]

    // Знаходимо регістр для отримання першого resource та dimensions
    const register =
      firstReg.kind === 'AccumulationRegister'
        ? model.accumulationRegisters.find((r) => r.name === firstReg.name)
        : model.informationRegisters.find((r) => r.name === firstReg.name)

    const firstResource = register?.resources?.[0]?.name ?? 'amount'
    const firstDimensions = register?.dimensions?.map((d) => d.name) ?? []

    const template: PostingValidation = {
      type: "NonNegativeBalance" as const,
      register: {
        kind: firstReg.kind as 'AccumulationRegister' | 'InformationRegister',
        name: firstReg.name,
      },
      dimensions: firstDimensions,
      resource: firstResource,
      message: { uk: "Недостатній залишок", en: "Insufficient balance" },
      applyTo: "Expense" as const,
    }
    storeAddPostingValidation(objectName, template)
  }, [registerMovements, objectName, storeAddPostingValidation, model])

  const handleRemoveValidation = useCallback(
    (index: number) => {
      storeRemovePostingValidation(objectName, index)
    },
    [objectName, storeRemovePostingValidation],
  )

  // Знаходимо movement info для кожного регістру
  const movementInfoMap = useMemo(() => {
    if (!postingData)
      return new Map<string, { movementType: string; source: string }>()
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
            onOpenConstructor={handleOpenConstructor}
          />
        </div>

        {/* Таблиця валідацій */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium">
              {t("movements.validations")}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={registerMovements.length === 0 || !postingData?.movements?.length}
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
              {t("movements.noValidations")}
            </p>
          )}
        </div>
      </div>

      <RegisterPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        documentRef={{ kind: "Document", name: objectName }}
        existingRefs={registerMovements}
        onSave={handleAddRegisters}
      />

      {selectedRegisterRef && (
        <MovementConstructorDialog
          open={constructorOpen}
          onOpenChange={setConstructorOpen}
          registerRef={selectedRegisterRef}
          document={doc}
          existingMovement={selectedMovement}
          onSave={handleSaveMovement}
        />
      )}
    </ScrollArea>
  )
}

function RegisterMovementsTable({
  registerMovements,
  movementInfoMap,
  onRemove,
  onOpenConstructor,
}: {
  registerMovements: MetadataRef[]
  movementInfoMap: Map<string, { movementType: string; source: string }>
  onRemove: (ref: MetadataRef) => void
  onOpenConstructor: (ref: MetadataRef) => void
}) {
  const { t } = useTranslation()

  if (registerMovements.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("movements.noRegisters")}
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="h-7 text-xs">
            {t("movements.register")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.movementType")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.source")}
          </TableHead>
          <TableHead className="h-7 w-10 text-xs" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {registerMovements.map((ref) => {
          const info = movementInfoMap.get(`${ref.kind}/${ref.name}`)
          return (
            <TableRow key={`${ref.kind}/${ref.name}`}>
              <TableCell className="py-1 font-mono text-xs">
                {ref.name}
              </TableCell>
              <TableCell className="py-1 text-xs">
                {info?.movementType ?? "—"}
              </TableCell>
              <TableCell className="py-1 text-xs">
                {info?.source ?? "—"}
              </TableCell>
              <TableCell className="py-1">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0"
                    title={t("movements.constructor")}
                    aria-label={t("movements.constructor")}
                    onClick={() => onOpenConstructor(ref)}
                  >
                    <HugeiconsIcon icon={Edit02Icon} size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-destructive hover:text-destructive"
                    aria-label={t("action.delete")}
                    onClick={() => onRemove(ref)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={12} />
                  </Button>
                </div>
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
            {t("movements.register")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.dimensions")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.resource")}
          </TableHead>
          <TableHead className="h-7 text-xs">
            {t("movements.message")}
          </TableHead>
          <TableHead className="h-7 w-10 text-xs" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {validations.map((v, index) => (
          <TableRow key={index}>
            <TableCell className="py-1 font-mono text-xs">
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
