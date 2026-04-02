import { useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { Rnd } from 'react-rnd'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@workspace/ui/components/context-menu'
import { cn } from '@workspace/ui/lib/utils'
import { HugeiconsIcon } from '@hugeicons/react'
import { useUiStore, type FloatingWindow as FloatingWindowType } from '../../stores/ui-store'
import { ObjectEditor } from '../editor/object-editor'
import { KIND_ICONS, KIND_COLORS } from '../../lib/metadata-icons'

/** Поріг Y-координати (px) — якщо вікно перетягнуто вище цього значення, attach як вкладку */
const ATTACH_THRESHOLD_Y = 10

/** Title bar кнопка */
function TitleBarButton({
  onClick,
  label,
  children,
  variant = 'default',
}: {
  onClick: (e: ReactMouseEvent) => void
  label: string
  children: React.ReactNode
  variant?: 'default' | 'close'
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
        'transition-colors',
        variant === 'close'
          ? 'hover:bg-destructive hover:text-destructive-foreground'
          : 'hover:bg-accent',
      )}
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </button>
  )
}

/** Іконка для minimize */
function MinimizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 5h6" />
    </svg>
  )
}

/** Іконка для maximize */
function MaximizeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" />
    </svg>
  )
}

/** Іконка для restore */
function RestoreIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="3" width="5.5" height="5.5" rx="0.5" />
      <path d="M4 3V2h5v5h-1" />
    </svg>
  )
}

/** Іконка для close */
function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 2l6 6M8 2l-6 6" />
    </svg>
  )
}

/** Окреме floating window */
export function FloatingWindow({ window }: { window: FloatingWindowType }) {
  const { t } = useTranslation()
  const {
    focusWindow,
    closeWindow,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    moveWindow,
    resizeWindow,
    attachWindow,
  } = useUiStore()

  const handleMouseDown = useCallback(() => {
    focusWindow(window.id)
  }, [focusWindow, window.id])

  const handleMinimize = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation()
      minimizeWindow(window.id)
    },
    [minimizeWindow, window.id],
  )

  const handleMaximizeRestore = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation()
      if (window.isMaximized) {
        restoreWindow(window.id)
      } else {
        maximizeWindow(window.id)
      }
    },
    [maximizeWindow, restoreWindow, window.id, window.isMaximized],
  )

  const handleClose = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation()
      closeWindow(window.id)
    },
    [closeWindow, window.id],
  )

  // Мінімізовані вікна рендеряться у Taskbar, не тут
  if (window.isMinimized) return null

  return (
    <Rnd
      position={window.isMaximized ? { x: 0, y: 0 } : window.position}
      size={
        window.isMaximized
          ? { width: '100%', height: '100%' }
          : window.size
      }
      minWidth={300}
      minHeight={200}
      bounds="parent"
      disableDragging={window.isMaximized}
      enableResizing={!window.isMaximized}
      dragHandleClassName="floating-window-drag-handle"
      style={{ zIndex: window.zIndex }}
      onDragStop={(_e, d) => {
        // Якщо перетягнуто до верху контейнера — attach як вкладку
        if (d.y <= ATTACH_THRESHOLD_Y) {
          attachWindow(window.id)
          return
        }
        moveWindow(window.id, { x: d.x, y: d.y })
      }}
      onResizeStop={(_e, _dir, ref, _delta, position) => {
        resizeWindow(window.id, {
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
        moveWindow(window.id, position)
      }}
      onMouseDown={handleMouseDown}
      className="absolute"
    >
      <div
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-md border border-border',
          'bg-background shadow-lg',
        )}
      >
        {/* Title bar */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                'floating-window-drag-handle',
                'flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-border',
                'bg-muted/70 px-2 active:cursor-grabbing',
              )}
              onDoubleClick={() =>
                window.isMaximized
                  ? restoreWindow(window.id)
                  : maximizeWindow(window.id)
              }
            >
              {/* Іконка типу */}
              <HugeiconsIcon
                icon={KIND_ICONS[window.objectRef.kind]}
                size={14}
                className={cn('shrink-0', KIND_COLORS[window.objectRef.kind])}
              />

              {/* Імʼя обʼєкта */}
              <span className="min-w-0 truncate font-mono text-xs">
                {window.objectRef.name}
              </span>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Title bar кнопки */}
              <div className="flex items-center gap-0.5">
                <TitleBarButton
                  onClick={handleMinimize}
                  label={t('floatingWindow.minimize')}
                >
                  <MinimizeIcon />
                </TitleBarButton>
                <TitleBarButton
                  onClick={handleMaximizeRestore}
                  label={
                    window.isMaximized
                      ? t('floatingWindow.restore')
                      : t('floatingWindow.maximize')
                  }
                >
                  {window.isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
                </TitleBarButton>
                <TitleBarButton
                  onClick={handleClose}
                  label={t('floatingWindow.close')}
                  variant="close"
                >
                  <CloseIcon />
                </TitleBarButton>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => attachWindow(window.id)}>
              {t('floatingWindow.attach')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => minimizeWindow(window.id)}>
              {t('floatingWindow.minimize')}
            </ContextMenuItem>
            {window.isMaximized ? (
              <ContextMenuItem onSelect={() => restoreWindow(window.id)}>
                {t('floatingWindow.restore')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => maximizeWindow(window.id)}>
                {t('floatingWindow.maximize')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => closeWindow(window.id)}>
              {t('floatingWindow.close')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {/* Вміст вікна — ObjectEditor */}
        <div className="flex-1 overflow-auto">
          <ObjectEditor objectRef={window.objectRef} />
        </div>
      </div>
    </Rnd>
  )
}
