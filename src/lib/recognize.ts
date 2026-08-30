import type { RecognitionResponse } from '../types'
import { blobToBase64 } from './recorder'

/**
 * Sends a recorded clip to our own /api/recognize function, which forwards it
 * to AudD using the secret API token. The browser never sees that token.
 */
export async function recognizeClip(blob: Blob, mimeType: string): Promise<RecognitionResponse> {
  const audioBase64 = await blobToBase64(blob)

  const response = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType }),
  })

  // The API always answers with JSON -- but if something upstream (a proxy, a
  // crashed function) returns HTML instead, parsing would throw a confusing
  // "Unexpected token <" error. Catching it here gives a friendlier message.
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}).`)
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Recognition failed (HTTP ${response.status}).`
    throw new Error(message)
  }

  return data as RecognitionResponse
}

/**
 * Converts AudD's "mm:ss" (or "hh:mm:ss") timecode into a number of seconds.
 *
 * The UI does not need this yet, but the next milestone does: to highlight the
 * right lyric line we need the offset as a number we can compare against LRC
 * timestamps.
 */
export function timecodeToSeconds(timecode: string | null): number | null {
  if (!timecode) return null

  const parts = timecode.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null

  // ["01","24"] -> 84   |   ["01","02","03"] -> 3723
  return parts.reduce((total, part) => total * 60 + part, 0)
}
