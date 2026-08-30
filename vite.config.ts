import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * In production (on Vercel) every file in /api becomes its own serverless
 * function, and requests to /api/recognize are routed there automatically.
 *
 * The plain Vite dev server knows nothing about that convention, so this small
 * plugin recreates it locally: it intercepts /api/* requests, loads the
 * matching TypeScript file, and calls its default export with an Express-like
 * (req, res) pair -- the same shape Vercel provides.
 *
 * The upshot: `npm run dev` runs the whole app, and you do NOT need the Vercel
 * CLI or a Vercel account just to develop locally.
 */
function devApiRoutes(): Plugin {
  return {
    name: 'dev-api-routes',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api/')) return next()

        // "/api/recognize?foo=1" -> "recognize"
        const route = url.split('?')[0].slice('/api/'.length).replace(/\/+$/, '')
        // Refuse anything that could escape the /api folder.
        if (!/^[a-zA-Z0-9_-]+$/.test(route)) return next()

        // Add the two helpers Vercel's runtime adds to the response object,
        // so the handler code can be written once and run in both places.
        const vercelRes = Object.assign(res, {
          status(code: number) {
            res.statusCode = code
            return vercelRes
          },
          json(body: unknown) {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
            return vercelRes
          },
        })

        try {
          // ssrLoadModule compiles the TypeScript handler on the fly.
          const mod = await server.ssrLoadModule(`/api/${route}.ts`)
          await mod.default(req, vercelRes)
        } catch (error) {
          server.config.logger.error(`[dev-api] /api/${route} failed: ${String(error)}`)
          if (!res.writableEnded) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Local API route failed. See the terminal for details.' }))
          }
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Vite only exposes VITE_-prefixed variables to the browser. Passing '' as
  // the third argument loads *every* variable from .env so that our local API
  // handler can read AUDD_API_TOKEN from process.env, exactly like on Vercel.
  const env = loadEnv(mode, process.cwd(), '')
  process.env = { ...process.env, ...env }

  return {
    plugins: [react(), devApiRoutes()],
    server: {
      port: 5173,
      // Listen on all interfaces so you can open the app from your phone.
      host: true,
    },
  }
})
