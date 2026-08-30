/**
 * POST /api/lyrics
 * ---------------------------------------------------------------------------
 * Finds timestamped (LRC) lyrics for a recognised song, using LRCLIB
 * (https://lrclib.net) -- a free, open lyrics database that needs no API key.
 *
 * This runs server-side for the same reasons /api/recognize does: the browser
 * only ever talks to our own origin, and the provider can be swapped or cached
 * later without touching the app.
 *
 * Request:  { title, artist, album?, durationSec? }
 * Response: { status: 'found',        lrc, ... }          synced + timestamped
 *           { status: 'unsynced',     plainLyrics, ... }  words, but no timings
 *           { status: 'instrumental' }
 *           { status: 'not_found' }
 */

// The same minimal (req, res) shapes as api/recognize.ts. Written out rather
// than shared so each function stays self-contained and readable on its own.
interface ApiRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  on(event: string, listener: (chunk?: unknown) => void): unknown
}

interface ApiResponse {
  status(code: number): ApiResponse
  json(body: unknown): ApiResponse
  setHeader(name: string, value: string): void
}

const LRCLIB = 'https://lrclib.net'

// LRCLIB asks clients to identify themselves so they can get in touch if
// something misbehaves. It is a small free service; be a good citizen.
const USER_AGENT = 'singalong/0.1 (https://github.com/creol/indagotta-devita)'

/** Keeps total latency sane: never make more than this many lookups per request. */
const MAX_LOOKUPS = 4

interface LrclibTrack {
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' })
  }

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message })
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const artist = typeof payload.artist === 'string' ? payload.artist.trim() : ''
  const album = typeof payload.album === 'string' ? payload.album.trim() : ''
  const durationSec =
    typeof payload.durationSec === 'number' && Number.isFinite(payload.durationSec)
      ? payload.durationSec
      : null

  if (!title || !artist) {
    return res.status(400).json({ error: 'Both "title" and "artist" are required.' })
  }

  // Recognition returns *release* titles, which often do not match a lyrics
  // database: "Mystify (Remastered 2011)", "Head Over Heels / Broken",
  // "Need You Tonight - 2011 Remaster". Try progressively cleaner variants.
  const searches = buildSearches(title, artist)

  try {
    let firstUnsynced: LrclibTrack | null = null
    let sawInstrumental = false
    let lookups = 0

    for (const search of searches) {
      if (lookups >= MAX_LOOKUPS) break
      lookups++

      const candidates = await lookup(search, album, durationSec)

      for (const track of candidates) {
        if (track.syncedLyrics && track.syncedLyrics.trim()) {
          return res.status(200).json({
            status: 'found',
            lrc: track.syncedLyrics,
            trackName: track.trackName ?? title,
            artistName: track.artistName ?? artist,
            albumName: track.albumName ?? null,
            durationSec: typeof track.duration === 'number' ? track.duration : null,
            // Handy when a match looks wrong: shows which variant actually hit.
            matchedQuery: search.artist + ' - ' + search.title,
          })
        }
        if (track.instrumental) sawInstrumental = true
        if (!firstUnsynced && track.plainLyrics && track.plainLyrics.trim()) {
          firstUnsynced = track
        }
      }
    }

    // Words but no timings is common. Showing them unhighlighted is far better
    // than claiming the song has no lyrics at all.
    if (firstUnsynced) {
      return res.status(200).json({
        status: 'unsynced',
        plainLyrics: firstUnsynced.plainLyrics,
        trackName: firstUnsynced.trackName ?? title,
        artistName: firstUnsynced.artistName ?? artist,
      })
    }

    if (sawInstrumental) return res.status(200).json({ status: 'instrumental' })

    return res.status(200).json({ status: 'not_found' })
  } catch {
    return res.status(502).json({ error: 'Could not reach the lyrics service.' })
  }
}

interface Search {
  title: string
  artist: string
}

/**
 * Progressively looser title/artist variants, best first.
 *
 * Order matters: the exact title is tried before any cleaned-up version, so a
 * song genuinely called "Live and Let Die" is never mangled into something else
 * before the real title has had its chance.
 */
export function buildSearches(title: string, artist: string): Search[] {
  const titles = [title]

  const cleaned = cleanTitle(title)
  if (cleaned && cleaned !== title) titles.push(cleaned)

  // Medleys arrive as "A / B". The first part is the song people know.
  const medleyHead = cleaned.split(/\s+\/\s+/)[0].trim()
  if (medleyHead && !titles.includes(medleyHead)) titles.push(medleyHead)

  const artists = [artist]
  const primaryArtist = cleanArtist(artist)
  if (primaryArtist && primaryArtist !== artist) artists.push(primaryArtist)

  const searches: Search[] = []
  for (const a of artists) {
    for (const t of titles) {
      if (!searches.some((s) => s.title === t && s.artist === a)) {
        searches.push({ title: t, artist: a })
      }
    }
  }
  return searches
}

/** Words marking a suffix as packaging rather than part of the song's name. */
const NOISE =
  /\b(remaster(ed)?|re-?recorded|live|acoustic|demo|mono|stereo|single|album|radio|edit|version|mix|remix|deluxe|expanded|anniversary|bonus|instrumental|explicit|clean)\b/i

function cleanTitle(title: string): string {
  let out = title

  // Drop a trailing "(Remastered 2011)" or "[Radio Edit]", but keep parentheses
  // that are genuinely part of a title, such as "(Don't Fear) The Reaper" --
  // hence the NOISE test rather than stripping every bracketed group.
  out = out.replace(/\s*[([][^()[\]]*[)\]]\s*$/, (match) => (NOISE.test(match) ? '' : match))

  // "Need You Tonight - 2011 Remaster"
  const dash = out.split(/\s+[-–]\s+/)
  if (dash.length > 1 && NOISE.test(dash[dash.length - 1])) {
    out = dash.slice(0, -1).join(' - ')
  }

  return out.trim()
}

function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*[([]?\s*\b(feat|ft|featuring|with)\b\.?\s+[^()[\]]*[)\]]?\s*$/i, '')
    .split(/\s*[,;]\s*|\s+&\s+|\s+x\s+/i)[0]
    .trim()
}

/** One LRCLIB round trip, returning zero or more candidate tracks. */
async function lookup(
  search: Search,
  album: string,
  durationSec: number | null,
): Promise<LrclibTrack[]> {
  // /api/get is an exact lookup and gives the best answer when we know enough
  // to pin the track down. Its 404 is an expected answer, not an error.
  if (album || durationSec !== null) {
    const params = new URLSearchParams({ artist_name: search.artist, track_name: search.title })
    if (album) params.set('album_name', album)
    if (durationSec !== null) params.set('duration', String(Math.round(durationSec)))

    const exact = await getJson(LRCLIB + '/api/get?' + params.toString())
    if (exact && !Array.isArray(exact)) return [exact as LrclibTrack]
  }

  // /api/search is fuzzy and returns a list.
  const params = new URLSearchParams({ track_name: search.title, artist_name: search.artist })
  const results = await getJson(LRCLIB + '/api/search?' + params.toString())
  if (!Array.isArray(results)) return []

  const tracks = results as LrclibTrack[]

  // Prefer a synced result, then the closest duration when we know it. Without
  // the duration tiebreak a live or extended cut often wins, and its timings
  // drift further out of step the longer the song runs.
  return tracks.slice().sort((a, b) => {
    const synced = Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics))
    if (synced !== 0) return synced
    if (durationSec === null) return 0
    return Math.abs((a.duration ?? 1e9) - durationSec) - Math.abs((b.duration ?? 1e9) - durationSec)
  })
}

async function getJson(url: string): Promise<unknown | null> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (response.status === 404) return null // "no such track" -- a normal answer
  if (!response.ok) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as Record<string, unknown>
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    return parseJson(req.body.toString())
  }
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
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
