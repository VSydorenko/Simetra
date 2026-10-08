import type { IconSvgElement } from "@hugeicons/react"
import {
  BookOpen02Icon,
  File02Icon,
  Menu01Icon,
  Database02Icon,
  ChartHistogramIcon,
  Settings02Icon,
  GridTableIcon,
  Layers01Icon,
  RulerIcon,
  Calculator01Icon,
  Table01Icon,
  Tag01Icon,
  TextFontIcon,
  TextAlignLeftIcon,
  HashtagIcon,
  Tick01Icon,
  Calendar03Icon,
  Key01Icon,
  Attachment01Icon,
  Link04Icon,
  TextIcon,
} from "@hugeicons/core-free-icons"
import type { MetadataKind } from "@simetra/core"

/** Маппінг MetadataKind → іконка hugeicons */
export const KIND_ICONS: Record<MetadataKind, IconSvgElement> = {
  Catalog: BookOpen02Icon,
  Document: File02Icon,
  Enumeration: Menu01Icon,
  InformationRegister: Database02Icon,
  AccumulationRegister: ChartHistogramIcon,
  Constant: Settings02Icon,
  CustomTable: GridTableIcon,
}

/** Іконки для структурних груп у дереві метаданих */
export const GROUP_ICONS: Record<string, IconSvgElement> = {
  attributes: Layers01Icon,
  dimensions: RulerIcon,
  resources: Calculator01Icon,
  tabularSections: Table01Icon,
  values: Tag01Icon,
  forms: TextIcon,
}

/** Іконки для типів полів */
export const FIELD_TYPE_ICONS: Record<string, IconSvgElement> = {
  String: TextFontIcon,
  Text: TextAlignLeftIcon,
  Integer: HashtagIcon,
  Numeric: HashtagIcon,
  Boolean: Tick01Icon,
  Date: Calendar03Icon,
  DateTime: Calendar03Icon,
  UUID: Key01Icon,
  Binary: Attachment01Icon,
  Ref: Link04Icon,
}

/** Іконка за замовчуванням для невідомого типу поля */
export const DEFAULT_FIELD_ICON: IconSvgElement = TextFontIcon

/** Маппінг MetadataKind → Tailwind CSS клас кольору тексту */
export const KIND_COLORS: Record<MetadataKind, string> = {
  Catalog: "text-kind-catalog",
  Document: "text-kind-document",
  Enumeration: "text-kind-enum",
  InformationRegister: "text-kind-info-reg",
  AccumulationRegister: "text-kind-acc-reg",
  Constant: "text-kind-constant",
  CustomTable: "text-kind-custom",
}

/** Маппінг MetadataKind → Tailwind CSS клас фону badge з opacity */
export const KIND_BADGE_CLASSES: Record<MetadataKind, string> = {
  Catalog: "bg-kind-catalog/15 text-kind-catalog border-kind-catalog/25",
  Document: "bg-kind-document/15 text-kind-document border-kind-document/25",
  Enumeration: "bg-kind-enum/15 text-kind-enum border-kind-enum/25",
  InformationRegister:
    "bg-kind-info-reg/15 text-kind-info-reg border-kind-info-reg/25",
  AccumulationRegister:
    "bg-kind-acc-reg/15 text-kind-acc-reg border-kind-acc-reg/25",
  Constant: "bg-kind-constant/15 text-kind-constant border-kind-constant/25",
  CustomTable: "bg-kind-custom/15 text-kind-custom border-kind-custom/25",
}
