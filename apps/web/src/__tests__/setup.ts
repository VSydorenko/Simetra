// Полифіл для API, відсутніх у jsdom
import '@testing-library/jest-dom'

// ResizeObserver — використовується react-resizable-panels та react-arborist
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
