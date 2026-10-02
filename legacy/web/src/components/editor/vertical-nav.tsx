import { useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { cn } from "@workspace/ui/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import type { SectionDef } from "./section-config"

interface VerticalNavProps {
  sections: SectionDef[]
  activeSection: string
  onSectionChange: (sectionId: string) => void
}

/**
 * Вертикальна навігація секцій обʼєкта.
 * Замінює горизонтальні shadcn Tabs на sidebar зліва від контенту.
 * Keyboard: ArrowUp/ArrowDown для навігації, Home/End для першої/останньої.
 */
export function VerticalNav({
  sections,
  activeSection,
  onSectionChange,
}: VerticalNavProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const currentIdx = sections.findIndex((s) => s.id === activeSection)
      if (currentIdx === -1) return

      let nextIdx: number | null = null
      if (e.key === "ArrowDown") {
        nextIdx = currentIdx < sections.length - 1 ? currentIdx + 1 : 0
      } else if (e.key === "ArrowUp") {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : sections.length - 1
      } else if (e.key === "Home") {
        nextIdx = 0
      } else if (e.key === "End") {
        nextIdx = sections.length - 1
      }

      if (nextIdx !== null) {
        e.preventDefault()
        onSectionChange(sections[nextIdx].id)
        const buttons =
          navRef.current?.querySelectorAll<HTMLButtonElement>("button")
        buttons?.[nextIdx]?.focus()
      }
    },
    [sections, activeSection, onSectionChange]
  )

  return (
    <ScrollArea className="h-full w-40 shrink-0 border-r border-border">
      <nav
        ref={navRef}
        aria-label={t("metadata.section.main")}
        className="flex flex-col gap-0.5 p-1.5"
        onKeyDown={handleKeyDown}
      >
        {sections.map((section) => {
          const isActive = section.id === activeSection
          return (
            <button
              key={section.id}
              aria-current={isActive ? "true" : undefined}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive
                  ? "border-l-2 border-l-primary bg-accent font-medium text-accent-foreground"
                  : "border-l-2 border-l-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              onClick={() => onSectionChange(section.id)}
            >
              <HugeiconsIcon
                icon={section.icon}
                size={14}
                className="shrink-0"
              />
              <span className="truncate">{t(section.labelKey)}</span>
            </button>
          )
        })}
      </nav>
    </ScrollArea>
  )
}
