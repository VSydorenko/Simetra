import { useCallback, useRef, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea, ScrollBar } from '@workspace/ui/components/scroll-area'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@workspace/ui/components/context-menu'
import { Badge } from '@workspace/ui/components/badge'
import { cn } from '@workspace/ui/lib/utils'
import { useUiStore, type TabItem } from '../../stores/ui-store'

/** Поріг вертикального зміщення (px) для detach вкладки при drag */
const DETACH_THRESHOLD_Y = 40

/** Вкладка в TabBar — одиночний елемент */
function Tab({
  tab,
  isActive,
  isDirty,
}: {
  tab: TabItem
  isActive: boolean
  isDirty?: boolean
}) {
  const { t } = useTranslation()
  const {
    setActiveTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToRight,
    pinTab,
    unpinTab,
    detachTab,
  } = useUiStore()
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)

  const handleClick = useCallback(() => {
    setActiveTab(tab.id)
  }, [setActiveTab, tab.id])

  const handleMiddleClick = useCallback(
    (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(tab.id)
      }
    },
    [closeTab, tab.id],
  )

  const handleClose = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation()
      closeTab(tab.id)
    },
    [closeTab, tab.id],
  )

  // --- Drag-to-detach: відстежуємо вертикальне зміщення ---
  const handleDragStart = useCallback(
    (e: MouseEvent) => {
      // Ігноруємо якщо натиснута кнопка закриття або не лівий клік
      if (e.button !== 0) return
      dragStartRef.current = { x: e.clientX, y: e.clientY }

      const handleMouseMove = (ev: globalThis.MouseEvent) => {
        if (!dragStartRef.current) return
        const dy = Math.abs(ev.clientY - dragStartRef.current.y)
        if (dy > DETACH_THRESHOLD_Y) {
          // Перевищено поріг — detach вкладку у floating window
          dragStartRef.current = null
          document.removeEventListener('mousemove', handleMouseMove)
          document.removeEventListener('mouseup', handleMouseUp)
          detachTab(tab.id)
        }
      }

      const handleMouseUp = () => {
        dragStartRef.current = null
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [detachTab, tab.id],
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          tabIndex={0}
          aria-selected={isActive}
          className={cn(
            'group flex h-8 min-w-0 max-w-48 shrink-0 cursor-pointer items-center gap-1.5',
            'border-r border-border px-2 text-xs outline-none',
            'transition-colors hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
            isActive && 'bg-background shadow-sm',
            !isActive && 'bg-muted/30',
          )}
          onClick={handleClick}
          onMouseDown={(e) => {
            handleMiddleClick(e)
            handleDragStart(e)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              handleClick()
            }
          }}
        >
          {/* Іконка pinned */}
          {tab.isPinned && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              ●
            </span>
          )}

          {/* Тип обʼєкта — компактний badge */}
          <Badge
            variant="outline"
            className="shrink-0 px-1 py-0 text-[9px] leading-tight"
          >
            {t(`metadata.kind.${tab.objectRef.kind}`)}
          </Badge>

          {/* Імʼя обʼєкта */}
          <span className="min-w-0 truncate font-mono text-xs">
            {tab.objectRef.name}
          </span>

          {/* Dirty indicator */}
          {isDirty && (
            <span className="shrink-0 text-xs text-amber-500">*</span>
          )}

          {/* Кнопка закриття */}
          <button
            type="button"
            className={cn(
              'ml-auto shrink-0 rounded-sm p-0.5',
              'text-muted-foreground hover:bg-destructive/20 hover:text-destructive',
              'opacity-0 group-hover:opacity-100',
              isActive && 'opacity-100',
            )}
            onClick={handleClose}
            aria-label={t('tabs.close')}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => closeTab(tab.id)}>
          {t('tabs.close')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => closeOtherTabs(tab.id)}>
          {t('tabs.closeOthers')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => closeTabsToRight(tab.id)}>
          {t('tabs.closeToRight')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => closeAllTabs()}>
          {t('tabs.closeAll')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {tab.isPinned ? (
          <ContextMenuItem onSelect={() => unpinTab(tab.id)}>
            {t('tabs.unpin')}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => pinTab(tab.id)}>
            {t('tabs.pin')}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => detachTab(tab.id)}>
          {t('tabs.detach')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** TabBar — горизонтальний рядок вкладок у верхній частині центральної панелі */
export function TabBar() {
  const { openTabs, activeTabId } = useUiStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  if (openTabs.length === 0) return null

  return (
    <div className="flex h-8 shrink-0 border-b border-border bg-muted/50">
      <ScrollArea className="w-full" ref={scrollRef}>
        <div role="tablist" className="flex h-8">
          {openTabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" className="h-1" />
      </ScrollArea>
    </div>
  )
}
