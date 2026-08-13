import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })

// jsdom 没有 ResizeObserver，cmdk / Radix 定位用到。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}
