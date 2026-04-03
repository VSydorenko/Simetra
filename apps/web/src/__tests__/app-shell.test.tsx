import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TooltipProvider } from '@workspace/ui/components/tooltip'
import '../i18n'
import { DEFAULT_PANEL_LAYOUT, useUiStore } from '../stores/ui-store'

// Мок cmdk — не працює в jsdom через залежність від browser API
vi.mock('cmdk', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandDialog: () => null,
  CommandInput: () => null,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: () => null,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandShortcut: () => null,
  CommandSeparator: () => null,
}))

// Lazy import AppShell після мокування
const { AppShell } = await import('../components/layout/app-shell')

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  localStorage.clear()
  useUiStore.setState({
    openTabs: [],
    activeTabId: null,
    floatingWindows: [],
    activeWindowId: null,
    nextWindowZIndex: 30,
    selectedObject: null,
    selectedField: null,
    expandedTreeNodes: [
      'Catalog',
      'Document',
      'Enumeration',
      'InformationRegister',
      'AccumulationRegister',
      'Constant',
      'CustomTable',
    ],
    commandPaletteOpen: false,
    propertiesPanelOpen: true,
    panelLayout: DEFAULT_PANEL_LAYOUT,
    searchQuery: '',
    focusedPanel: null,
  })
})

describe('AppShell', () => {
  it('рендериться без crash', () => {
    renderWithProviders(<AppShell />)
    // Логотип Simetra
    expect(screen.getByText('Simetra')).toBeInTheDocument()
  })

  it('показує назву проєкту у top bar', () => {
    renderWithProviders(<AppShell />)
    // Дефолтна назва проєкту
    expect(screen.getByText(/NewProject/)).toBeInTheDocument()
  })

  it('показує кількість обʼєктів у status bar', () => {
    renderWithProviders(<AppShell />)
    // Status bar: "Обʼєктів: 0" або подібне
    expect(screen.getByText(/0/)).toBeInTheDocument()
  })

  it('відображає кнопки дій у top bar', () => {
    renderWithProviders(<AppShell />)
    // Top bar містить кнопки — перевіряємо що є хоча б декілька icon buttons
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(5)
  })
})
