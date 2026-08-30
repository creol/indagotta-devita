/**
 * Production server for self-hosting (Docker on a NAS, a VPS, anywhere).
 * ---------------------------------------------------------------------------
 * On Vercel this file is not used at all: Vercel serves /dist as static files
 * and turns /api/recognize into a serverless function by itself.
 *
 * When self-hosting there is no such magic, so this one small Node server does
 * both jobs:
 *   1. POST /api/recognize  -> the same handler Vercel would have run
 *   2. everything else      -> static files from /dist
 *
 * It has zero runtime dependencies, so the Docker image needs no node_modules.
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The API handler is written for Vercel's (req, res) shape. esbuild bundles it
// into this file at build time -- see "npm run build:server".
import recognizeHandler from '../api/recognize.ts'

const PORT = Number(process.env.PORT) || 8080
const HOST = process.env.HOST || '0.0.0.0'

// In the Docker image the bundled server sits next to dist/. DIST_DIR lets you
// override that if you lay the files out differently.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const DIST_DIR = resolve(process.env.DIST_DIR || join(HERE, '..', 'dist'))

/** Only the file types this app actually ships. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)

    // --- Health check, for Container Station / nginx / uptime monitors ------
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }

    // --- The API route -----------------------------------------------------
    if (pathname === '/api/recognize') {
      // Give the handler the two helpers Vercel adds to its response object,
      // so the exact same code runs here, on Vercel, and in `npm run dev`.
      const apiRes = Object.assign(res, {
        status(code) {
          res.statusCode = code
          return apiRes
        },
        json(body) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
          return apiRes
        },
      })
      await recognizeHandler(req, apiRes)
      return
    }

    // Any other /api/* path does not exist -- answer in JSON rather than
    // falling through and handing the caller the HTML page.
    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    // --- Static files ------------------------------------------------------
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }

    await serveStatic(pathname, req, res)
  } catch (error) {
    console.error('[server] unhandled error:', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Internal server error' }))
    } else if (!res.writableEnded) {
      res.end()
    }
  }
})

async function serveStatic(pathname, req, res) {
  // Resolve inside DIST_DIR and verify we never escaped it. Without this a
  // request for /../../etc/passwd would read files outside the app.
  const candidate = resolve(join(DIST_DIR, normalize(pathname)))
  const insideDist = candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep)
  let filePath = insideDist ? candidate : DIST_DIR

  let info = await statOrNull(filePath)
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html')
    info = await statOrNull(filePath)
  }

  // Single-page app: unknown paths still get index.html so client-side routing
  // works. Assets and API paths are handled above, so this is safe.
  if (!info) {
    filePath = join(DIST_DIR, 'index.html')
    info = await statOrNull(filePath)
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found. Was the app built? Expected files in: ' + DIST_DIR)
      return
    }
  }

  const ext = extname(filePath).toLowerCase()
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    // Vite fingerprints filenames under /assets, so those can be cached hard.
    // Everything else (index.html, sw.js, the manifest) must revalidate, or
    // users would keep getting a stale app after a redeploy.
    'Cache-Control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }

  res.writeHead(200, headers)
  createReadStream(filePath).pipe(res)
}

async function statOrNull(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Sing Along listening on http://${HOST}:${PORT}`)
  console.log(`Serving static files from ${DIST_DIR}`)
  if (!process.env.AUDD_API_TOKEN) {
    console.warn('WARNING: AUDD_API_TOKEN is not set -- song recognition will fail.')
  }
})

// Docker sends SIGTERM on `docker stop`. Closing cleanly avoids a 10s wait.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`)
    server.close(() => process.exit(0))
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
