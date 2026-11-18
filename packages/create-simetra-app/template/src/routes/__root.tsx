import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"

// Лише оболонка HTML: без loader і `beforeLoad` (текст їхніх помилок потрапив
// би в dehydrated state, §4.2). Дані й `errorComponent` — D3.
export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
})
