// Серверний entry: типовий обробник Start плюс заголовки, без яких
// персональний SSR-знімок ядра потрапив би в спільний кеш (CDN, проксі).
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createServerEntry } from '@tanstack/react-start/server-entry'

const handler = createStartHandler(defaultStreamHandler)

export default createServerEntry({
  async fetch(request) {
    const response = await handler(request)
    if ((response.headers.get('content-type') ?? '').includes('text/html')) {
      response.headers.set('cache-control', 'private, no-store')
      response.headers.append('vary', 'Cookie')
    }
    return response
  },
})
