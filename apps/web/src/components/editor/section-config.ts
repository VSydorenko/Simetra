import type { IconSvgElement } from "@hugeicons/react"
import {
  InformationCircleIcon,
  Database02Icon,
  HashtagIcon,
  Exchange01Icon,
  Menu01Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import type { MetadataKind } from "@simetra/core"

/** Визначення секції вертикальної навігації */
export interface SectionDef {
  id: string
  labelKey: string
  icon: IconSvgElement
}

/** Декларативний конфіг секцій per kind — single point of change */
export const SECTION_CONFIG: Record<MetadataKind, SectionDef[]> = {
  Catalog: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "data", labelKey: "metadata.section.data", icon: Database02Icon },
    {
      id: "numbering",
      labelKey: "metadata.section.numbering",
      icon: HashtagIcon,
    },
    {
      id: "settings",
      labelKey: "metadata.section.settings",
      icon: Settings02Icon,
    },
  ],
  Document: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "data", labelKey: "metadata.section.data", icon: Database02Icon },
    {
      id: "numbering",
      labelKey: "metadata.section.numbering",
      icon: HashtagIcon,
    },
    {
      id: "movements",
      labelKey: "metadata.section.movements",
      icon: Exchange01Icon,
    },
    {
      id: "settings",
      labelKey: "metadata.section.settings",
      icon: Settings02Icon,
    },
  ],
  Enumeration: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "values", labelKey: "metadata.section.values", icon: Menu01Icon },
  ],
  InformationRegister: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "data", labelKey: "metadata.section.data", icon: Database02Icon },
    {
      id: "settings",
      labelKey: "metadata.section.settings",
      icon: Settings02Icon,
    },
  ],
  AccumulationRegister: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "data", labelKey: "metadata.section.data", icon: Database02Icon },
    {
      id: "settings",
      labelKey: "metadata.section.settings",
      icon: Settings02Icon,
    },
  ],
  Constant: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
  ],
  CustomTable: [
    {
      id: "main",
      labelKey: "metadata.section.main",
      icon: InformationCircleIcon,
    },
    { id: "data", labelKey: "metadata.section.data", icon: Database02Icon },
    {
      id: "settings",
      labelKey: "metadata.section.settings",
      icon: Settings02Icon,
    },
  ],
}
