import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Delete02Icon,
  ArrowUp01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons"
import { validateTechnicalName } from "@/lib/validate-technical-name"
import { useMetadataStore } from "@/stores/metadata-store"

interface EnumValue {
  name: string
  displayName?: { uk?: string; en?: string }
  order?: number
}

interface EnumValuesEditorProps {
  objectName: string
  values: EnumValue[]
}

export function EnumValuesEditor({
  objectName,
  values,
}: EnumValuesEditorProps) {
  const { t } = useTranslation()
  const [selectedRow, setSelectedRow] = useState<string | null>(null)
  const { addEnumValue, removeEnumValue, reorderEnumValues } =
    useMetadataStore()

  const handleAdd = useCallback(() => {
    let i = 1
    const existing = new Set(values.map((v) => v.name))
    while (existing.has(`Value${i}`)) i++
    addEnumValue(objectName, { name: `Value${i}`, order: values.length })
  }, [objectName, values, addEnumValue])

  const handleRemove = useCallback(() => {
    if (!selectedRow) return
    removeEnumValue(objectName, selectedRow)
    setSelectedRow(null)
  }, [objectName, selectedRow, removeEnumValue])

  const handleMove = useCallback(
    (direction: "up" | "down") => {
      if (!selectedRow) return
      const idx = values.findIndex((v) => v.name === selectedRow)
      if (idx === -1) return
      const newIdx = direction === "up" ? idx - 1 : idx + 1
      if (newIdx < 0 || newIdx >= values.length) return
      reorderEnumValues(objectName, idx, newIdx)
    },
    [objectName, selectedRow, values, reorderEnumValues]
  )

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-green-600 hover:text-green-600"
              aria-label={t("editor.addValue")}
              onClick={handleAdd}
            >
              <HugeiconsIcon
                icon={Add01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("editor.addValue")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-destructive hover:text-destructive"
              aria-label={t("editor.deleteSelected")}
              disabled={!selectedRow}
              onClick={handleRemove}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("editor.deleteSelected")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-blue-500 hover:text-blue-500"
              aria-label={t("editor.moveUp")}
              disabled={!selectedRow}
              onClick={() => handleMove("up")}
            >
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("editor.moveUp")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-blue-500 hover:text-blue-500"
              aria-label={t("editor.moveDown")}
              disabled={!selectedRow}
              onClick={() => handleMove("down")}
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("editor.moveDown")}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1">
        <Table>
          <TableHeader>
            <TableRow className="h-7">
              <TableHead
                className="h-7 px-2 text-xs font-medium"
                style={{ width: 160 }}
              >
                {t("metadata.field.name")}
              </TableHead>
              <TableHead
                className="h-7 px-2 text-xs font-medium"
                style={{ width: 180 }}
              >
                {t("editor.displayNameUk")}
              </TableHead>
              <TableHead
                className="h-7 px-2 text-xs font-medium"
                style={{ width: 180 }}
              >
                {t("editor.displayNameEn")}
              </TableHead>
              <TableHead
                className="h-7 px-2 text-xs font-medium"
                style={{ width: 80 }}
              >
                {t("editor.order")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {values.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-20 text-center text-xs text-muted-foreground"
                >
                  {t("editor.emptyValues")}
                </TableCell>
              </TableRow>
            ) : (
              values.map((value) => (
                <EnumValueRow
                  key={value.name}
                  value={value}
                  objectName={objectName}
                  isSelected={selectedRow === value.name}
                  onSelect={() => setSelectedRow(value.name)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

/** Рядок значення enum з commit-on-blur патерном */
function EnumValueRow({
  value,
  objectName,
  isSelected,
  onSelect,
}: {
  value: EnumValue
  objectName: string
  isSelected: boolean
  onSelect: () => void
}) {
  const { updateEnumValue } = useMetadataStore()
  const [nameDraft, setNameDraft] = useState(value.name)
  const [ukDraft, setUkDraft] = useState(value.displayName?.uk ?? "")
  const [enDraft, setEnDraft] = useState(value.displayName?.en ?? "")
  const [nameError, setNameError] = useState<string | null>(null)

  const commitName = () => {
    const trimmed = nameDraft.trim()
    if (trimmed === value.name) {
      setNameDraft(value.name)
      setNameError(null)
      return true
    }

    const validationError = validateTechnicalName(trimmed, "PascalCase")
    if (validationError) {
      setNameError(validationError)
      return false
    }

    const errors = updateEnumValue(objectName, value.name, { name: trimmed })
    if (errors) {
      setNameError(
        errors.find((issue) => issue.path === "values.name")?.message ??
          errors.find((issue) => issue.path === "name")?.message ??
          errors[0]?.message ??
          t("validation.renameFailed")
      )
      return false
    }

    setNameError(null)
    return true
  }

  const commitDisplayName = (lang: "uk" | "en") => {
    const draft = lang === "uk" ? ukDraft : enDraft
    const current = value.displayName?.[lang] ?? ""
    if (draft !== current) {
      updateEnumValue(objectName, value.name, {
        displayName: { ...value.displayName, [lang]: draft },
      })
    }
  }

  return (
    <TableRow
      className={cn("h-8 cursor-pointer", isSelected && "bg-accent")}
      onClick={onSelect}
    >
      <TableCell className="px-2 py-0.5">
        <div className="space-y-1">
          <Input
            className="h-6 border-none bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-1"
            value={nameDraft}
            aria-invalid={nameError ? "true" : "false"}
            onChange={(e) => {
              setNameDraft(e.target.value)
              if (nameError) setNameError(null)
            }}
            onBlur={() => {
              commitName()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (commitName()) {
                  ;(e.target as HTMLInputElement).blur()
                } else {
                  e.preventDefault()
                }
              } else if (e.key === "Escape") {
                setNameDraft(value.name)
                setNameError(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
          />
          {nameError ? (
            <p className="text-[11px] text-destructive">{nameError}</p>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="px-2 py-0.5">
        <Input
          className="h-6 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={ukDraft}
          placeholder="uk"
          onChange={(e) => setUkDraft(e.target.value)}
          onBlur={() => commitDisplayName("uk")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          }}
        />
      </TableCell>
      <TableCell className="px-2 py-0.5">
        <Input
          className="h-6 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={enDraft}
          placeholder="en"
          onChange={(e) => setEnDraft(e.target.value)}
          onBlur={() => commitDisplayName("en")}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          }}
        />
      </TableCell>
      <TableCell className="px-2 py-0.5">
        <Input
          type="number"
          className="h-6 w-16 border-none bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
          value={value.order ?? ""}
          onChange={(e) => {
            const order = parseInt(e.target.value, 10)
            if (!isNaN(order)) {
              updateEnumValue(objectName, value.name, { order })
            }
          }}
        />
      </TableCell>
    </TableRow>
  )
}
