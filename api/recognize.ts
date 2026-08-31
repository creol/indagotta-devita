/**
 * POST /api/recognize
 * ---------------------------------------------------------------------------
 * This is a Vercel-style serverless function. Its ONLY job is to sit between
 * the browser and the AudD song-recognition API so that our secret API token
 * never has to be shipped to the browser.
 *
 *   browser  --(base64 audio)-->  this function  --(audio + token)-->  audd.io
 *
 * The browser sends JSON like:
 *   { "audioBase64": "GkXfo59...", "mimeType": "audio/webm" }
 *
 * We send back a small, tidy object the UI can render directly:
 *   { "status": "found", "song": { title, artist, album, timecode, ... } }
 *   { "status": "not_found" }
 *   { "error": "..." }
 */

// Minimal stand-ins for @vercel/node's VercelRequest / VercelResponse. Writing
// them out (instead of installing the package) keeps the dependency list short
// and makes it obvious exactly what this function relies on.
interface ApiRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  // A Node readable stream -- used only if the platform did not parse the body.
  on(event: string, listener: (chunk?: unknown) => void): unknown
}

interface ApiResponse {
  status(code: number): ApiResponse
  json(body: unknown): ApiResponse
  setHeader(name: string, value: string): void
}

const AUDD_ENDPOINT = 'https://api.audd.io/'

/** Roughly 6 MB of base64 -- far more than a 10 second clip ever needs. */
const MAX_BODY_BYTES = 6 * 1024 * 1024

/** The shape of the bits of AudD's response we actually care about. */
interface AudDResponse {
  status?: string
  error?: { error_code?: number; error_message?: string }
  result?: {
    title?: string
    artist?: string
    album?: string
    release_date?: string
    label?: string
    timecode?: string
    song_link?: string
    // Requested via `return=apple_music,spotify` below. We only want the track
    // length: knowing it lets the lyrics lookup tell a 3:30 studio cut from a
    // 7:00 live version, whose timings would drift badly against this one.
    spotify?: { duration_ms?: number } | null
    apple_music?: { durationInMillis?: number } | null
  } | null
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  // ---- 1. Only POST is allowed -------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }

  // ---- 2. Make sure the server is configured ------------------------------
  const apiToken = process.env.AUDD_API_TOKEN
  if (!apiToken) {
    // Never echo the variable's value -- just say it is missing.
    return res.status(500).json({
      error: 'Server is missing AUDD_API_TOKEN. Copy .env.example to .env and add your token.',
    })
  }

  // ---- 3. Read and validate the incoming JSON -----------------------------
  let payload: { audioBase64?: unknown; mimeType?: unknown }
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message })
  }

  const { audioBase64, mimeType } = payload
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return res.status(400).json({ error: 'Expected a non-empty "audioBase64" string.' })
  }

  const audioBytes = Buffer.from(audioBase64, 'base64')
  if (audioBytes.length === 0) {
    return res.status(400).json({ error: 'The audio clip was empty.' })
  }

  // ---- 4. Forward the clip to AudD ----------------------------------------
  // Node 18+ provides fetch, FormData, Blob and File as globals, so we can
  // build a multipart upload without any extra packages.
  const contentType = typeof mimeType === 'string' && mimeType ? mimeType : 'audio/webm'
  const form = new FormData()
  form.append('api_token', apiToken)
  form.append('file', new Blob([audioBytes], { type: contentType }), 'clip')
  // Ask AudD to include streaming-service metadata alongside the basic result.
  form.append('return', 'apple_music,spotify')

  let audd: AudDResponse
  try {
    const auddResponse = await fetch(AUDD_ENDPOINT, { method: 'POST', body: form })
    if (!auddResponse.ok) {
      return res.status(502).json({
        error: `Song recognition service returned HTTP ${auddResponse.status}.`,
      })
    }
    audd = (await auddResponse.json()) as AudDResponse
  } catch {
    return res.status(502).json({ error: 'Could not reach the song recognition service.' })
  }

  // ---- 5. Translate AudD's answer into our own small shape ----------------
  if (audd.status === 'error') {
    // AudD's own error text is safe to surface (bad token, quota, etc.) and is
    // by far the most useful thing to show while getting set up.
    return res.status(502).json({
      error: audd.error?.error_message ?? 'Song recognition failed.',
    })
  }

  if (!audd.result) {
    // A perfectly normal outcome: we heard audio, but nothing matched.
    return res.status(200).json({ status: 'not_found' })
  }

  const r = audd.result

  // Either streaming provider can supply the track length; take whichever
  // answered. Null is fine -- the lyrics lookup just loses a tiebreak.
  const durationSec =
    typeof r.spotify?.duration_ms === 'number'
      ? Math.round(r.spotify.duration_ms / 1000)
      : typeof r.apple_music?.durationInMillis === 'number'
        ? Math.round(r.apple_music.durationInMillis / 1000)
        : null

  return res.status(200).json({
    status: 'found',
    song: {
      title: r.title ?? 'Unknown title',
      artist: r.artist ?? 'Unknown artist',
      album: r.album ?? null,
      releaseDate: r.release_date ?? null,
      label: r.label ?? null,
      // "timecode" is how far into the song the clip was recorded, as "mm:ss".
      // This is what lets the next milestone jump to the right lyric line.
      timecode: r.timecode ?? null,
      songLink: r.song_link ?? null,
      durationSec,
    },
  })
}

/**
 * Returns the request body as a parsed JSON object.
 *
 * Different hosts behave differently: Vercel usually parses JSON bodies for us
 * and puts the result on req.body, while our local Vite shim hands over the raw
 * stream. This helper copes with every case so the handler above stays simple.
 */
async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  // Case 1: the platform already parsed it into an object.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>
  }

  // Case 2: the platform gave us a string or Buffer.
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    return parseJson(req.body.toString())
  }

  // Case 3: nothing was parsed -- read the raw stream ourselves.
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk) => {
      const buf = chunk as Buffer
      total += buf.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Audio clip is too large.'))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new Error('Could not read the request body.')))
  })

  return parseJson(raw)
}

function parseJson(text: string): Record<string, unknown> {
  if (!text.trim()) throw new Error('Request body was empty.')
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Request body was not valid JSON.')
  }
}
