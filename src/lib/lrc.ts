/**
 * LRC parsing.
 * ---------------------------------------------------------------------------
 * An .lrc file is plain text where each line carries a timestamp:
 *
 *   [ar:INXS]                  <- metadata, ignored
 *   [00:01.23] All veils and misty
 *   [00:04.59] Streets of blue
 *   [00:30.76][01:12.40] Mystify      <- a repeated line can carry several
 *
 * We turn that into a flat, time-sorted list so the UI can binary-search for
 * "which line should be highlighted right now".
 */

export interface LyricLine {
  /** When this line starts, in seconds from the beginning of the song. */
  timeSec: number
  text: string
}

/** `[mm:ss.xx]`, `[mm:ss]`, or `[hh:mm:ss.xx]`. Hundredths or thousandths. */
const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:[.:](\d{1,3}))?\]/g

/*
 * Metadata tags -- [ar:], [ti:], [al:], [by:], [length:] -- need no special
 * handling: they cannot match TIMESTAMP (which requires digits), so they end up
 * with zero timestamps and are skipped below. [offset:] is the one exception,
 * because it changes the timing of every other line.
 */

/**
 * Parses LRC text into time-sorted lines.
 *
 * Returns an empty array for anything unparseable, so a malformed file shows
 * "no lyrics" rather than throwing in the middle of a render.
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc) return []

  const lines: LyricLine[] = []
  // Some files carry a global [offset:±ms] correction. Positive means the
  // lyrics should appear *earlier*, per the de-facto LRC convention.
  let offsetSec = 0

  for (const rawLine of lrc.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const offsetMatch = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line)
    if (offsetMatch) {
      offsetSec = -Number(offsetMatch[1]) / 1000
      continue
    }

    // Collect every timestamp at the start of this line.
    TIMESTAMP.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    let consumedTo = 0

    while ((match = TIMESTAMP.exec(line)) !== null) {
      // Only timestamps forming an unbroken run at the start count. A "[03:12]"
      // appearing inside the lyric text is part of the words, not a cue.
      if (match.index !== consumedTo) break
      consumedTo = match.index + match[0].length

      const [, a, b, c, frac] = match
      // Two groups -> mm:ss. Three -> hh:mm:ss.
      const hours = c !== undefined ? Number(a) : 0
      const minutes = c !== undefined ? Number(b) : Number(a)
      const seconds = c !== undefined ? Number(c) : Number(b)

      // ".5" means half a second, ".50" means the same, ".500" likewise --
      // so scale by the number of digits actually written.
      let fraction = 0
      if (frac !== undefined) fraction = Number(frac) / 10 ** frac.length

      times.push(hours * 3600 + minutes * 60 + seconds + fraction)
    }

    if (times.length === 0) continue

    const text = line.slice(consumedTo).trim()
    // A timestamp with no words is a real thing in LRC files -- it marks an
    // instrumental gap. Keep it: it stops the previous line staying highlighted
    // through a 30 second solo.
    for (const timeSec of times) {
      lines.push({ timeSec, text })
    }
  }

  // Metadata-only files parse to nothing; that is a legitimate "no lyrics".
  if (lines.length === 0) return []

  return lines
    .map((line) => ({ ...line, timeSec: Math.max(0, line.timeSec + offsetSec) }))
    .sort((a, b) => a.timeSec - b.timeSec)
}

/**
 * Index of the line that should be highlighted at `positionSec`, or -1 when the
 * song has not reached the first line yet.
 *
 * Binary search rather than a scan: this runs on every animation tick, and a
 * long song can carry hundreds of lines.
 */
export function findActiveLineIndex(lines: LyricLine[], positionSec: number): number {
  if (lines.length === 0 || positionSec < lines[0].timeSec) return -1

  let low = 0
  let high = lines.length - 1
  let answer = 0

  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].timeSec <= positionSec) {
      answer = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return answer
}

/** "mm:ss" for display. */
export function formatSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
