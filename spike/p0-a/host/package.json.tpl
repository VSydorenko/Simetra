{
  "name": "p0a-host",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@simetra-spike/p0a-stub": "file:__TARBALLS__/simetra-spike-p0a-stub-0.0.0.tgz",
    "simetra": "file:__TARBALLS__/simetra-0.1.0.tgz",
    "@tanstack/db": "1.0.0-rc.1.3",
    "@tanstack/react-db": "1.0.0-rc.1.3",
    "@tanstack/react-query": "5.105.3",
    "@tanstack/react-router": "__ROUTER__",
    "@tanstack/react-start": "__START__",
    "@tanstack/virtual-file-routes": "1.162.0",
    "@vercel/functions": "3.10.6",
    "drizzle-orm": "0.45.4",
    "pg": "8.23.1",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "6.2.1",
    "nitro": "__NITRO__",
    "vite": "__VITE__"
  }
}
