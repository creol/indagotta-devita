import type { Song } from '../types'

/**
 * LyricsView -- PLACEHOLDER for milestone 2.
 * ---------------------------------------------------------------------------
 * Right now this component just shows what is coming next. The props are the
 * ones the real implementation will need, so wiring it up later is mostly a
 * matter of filling in the body:
 *
 *   - `song`             which track we matched
 *   - `startOffsetSec`   how far into the song we were when we recorded
 *   - `lrc`              the raw .lrc file contents, once we fetch lyrics
 *
 * The plan for milestone 2:
 *   1. Fetch timestamped lyrics (LRC format) for `song`, via a new /api route.
 *   2. Parse the LRC into a list of { timeSec, text } lines.
 *   3. Start a local clock from `startOffsetSec` and, on each tick, highlight
 *      the last line whose timeSec has passed -- then auto-scroll to it.
 */

interface LyricsViewProps {
  song: Song
  /** Offset into the song in seconds, or null when AudD did not report one. */
  startOffsetSec: number | null
  /** Raw LRC file contents. Not fetched yet -- always undefined for now. */
  lrc?: string
}

export function LyricsView({ song, startOffsetSec, lrc }: LyricsViewProps) {
  // Once milestone 2 lands, this branch is where the parsed, scrolling lyrics
  // will render. Until then `lrc` is never passed, so we always fall through
  // to the placeholder below.
  const hasLyrics = typeof lrc === 'string' && lrc.trim().length > 0

  return (
    <section className="card lyrics-view" aria-label="Lyrics">
      <header className="lyrics-view__header">
        <h3 className="lyrics-view__title">Lyrics</h3>
        <span className="badge">Coming in milestone 2</span>
      </header>

      {hasLyrics ? (
        // Placeholder rendering: milestone 2 replaces this with parsed,
        // time-synced lines that highlight and scroll as the song plays.
        <pre className="lyrics-view__raw">{lrc}</pre>
      ) : (
        <div className="lyrics-view__empty">
          <p>
            Timestamped lyrics for <strong>{song.title}</strong> will scroll here in time with the
            music.
          </p>
          <p className="lyrics-view__hint">
            {startOffsetSec !== null ? (
              <>
                We already know where we are in the track (<strong>{startOffsetSec}s</strong> in), so
                the next step is fetching an LRC file and highlighting the matching line.
              </>
            ) : (
              <>
                AudD did not report a time offset for this match, so milestone 2 will need to fall
                back to starting the lyrics from the top.
              </>
            )}
          </p>
        </div>
      )}
    </section>
  )
}
