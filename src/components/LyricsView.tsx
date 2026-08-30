import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchLyrics } from '../lib/recognize'
import { findActiveLineIndex, formatSeconds, parseLrc } from '../lib/lrc'
import type { LyricsResponse, LyricsStatus, Song } from '../types'

interface LyricsViewProps {
  song: Song
  /** How far into the song we were when recording STARTED, in seconds. */
  startOffsetSec: number | null
  /** `Date.now()` at the moment the microphone went live. */
  recordingStartedAtMs: number | null
}

/** How long to leave auto-scroll off after the user scrolls by hand. */
const USER_SCROLL_GRACE_MS = 5000

/**
 * LyricsView -- timestamped lyrics that scroll in time with the music.
 *
 * The clock is the heart of this. We never hear the song, so we cannot follow
 * it; instead we work out where it must be by now:
 *
 *     position = offsetAtRecordingStart + (now - whenRecordingStarted)
 *
 * Anchoring to when the *recording* started, rather than to when the lyrics
 * finished loading, matters: ten seconds of recording plus a couple of seconds
 * of recognition and lookup means an unanchored clock would start a dozen or
 * more seconds behind the music.
 *
 * That still leaves small errors -- the exact point AudD matched, network jitter
 * -- so there is a manual nudge. A second out is very noticeable when you are
 * trying to sing along.
 */
export function LyricsView({ song, startOffsetSec, recordingStartedAtMs }: LyricsViewProps) {
  const [status, setStatus] = useState<LyricsStatus>('idle')
  const [lyrics, setLyrics] = useState<LyricsResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Whether we can actually sync. Without a timecode we still show the words,
  // just from the top and paused, rather than pretending to be in time.
  const canSync = startOffsetSec !== null && recordingStartedAtMs !== null

  const [positionSec, setPositionSec] = useState(startOffsetSec ?? 0)
  const [isRunning, setIsRunning] = useState(canSync)
  const [nudgeSec, setNudgeSec] = useState(0)

  /**
   * The clock is stored as an anchor rather than a ticking counter: a known
   * song position paired with the wall-clock time it was true. Position is then
   * derived on every tick, so pausing, nudging and re-rendering cannot make it
   * drift the way an incrementing counter would.
   */
  const anchorRef = useRef({
    songPos: startOffsetSec ?? 0,
    wallClock: recordingStartedAtMs ?? Date.now(),
  })

  const scrollBoxRef = useRef<HTMLDivElement | null>(null)
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([])
  const userScrolledAtRef = useRef(0)

  // ---- Fetch the lyrics ---------------------------------------------------
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setLyrics(null)
    setErrorMessage(null)

    fetchLyrics(song, controller.signal)
      .then((result) => {
        setLyrics(result)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        // An abort is us tearing down, not a failure worth showing.
        if (error instanceof DOMException && error.name === 'AbortError') return
        setErrorMessage(error instanceof Error ? error.message : 'Could not load lyrics.')
        setStatus('error')
      })

    return () => controller.abort()
    // Re-fetch only when the actual track changes.
  }, [song.title, song.artist, song.album, song.durationSec, song])

  // ---- Run the clock ------------------------------------------------------
  useEffect(() => {
    if (!isRunning) return

    // 10Hz. Lyrics change every few seconds, so this is far more than enough,
    // and it costs a fraction of what a requestAnimationFrame loop would.
    const id = setInterval(() => {
      const { songPos, wallClock } = anchorRef.current
      setPositionSec(songPos + (Date.now() - wallClock) / 1000)
    }, 100)

    return () => clearInterval(id)
  }, [isRunning])

  const parsedLines = useMemo(
    () => (lyrics?.status === 'found' ? parseLrc(lyrics.lrc) : []),
    [lyrics],
  )

  const effectivePosition = positionSec + nudgeSec
  const activeIndex = useMemo(
    () => findActiveLineIndex(parsedLines, effectivePosition),
    [parsedLines, effectivePosition],
  )

  // ---- Keep the current line in view --------------------------------------
  useEffect(() => {
    if (activeIndex < 0) return
    // Respect a reader who has scrolled away to look at something else.
    if (Date.now() - userScrolledAtRef.current < USER_SCROLL_GRACE_MS) return

    const box = scrollBoxRef.current
    const line = lineRefs.current[activeIndex]
    if (!box || !line) return

    // Scroll the container itself rather than calling scrollIntoView, which
    // would also scroll the page and yank the whole app around on a phone.
    const target = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    box.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' })
  }, [activeIndex])

  const noteUserScroll = useCallback(() => {
    userScrolledAtRef.current = Date.now()
  }, [])

  // ---- Controls -----------------------------------------------------------
  const togglePlay = useCallback(() => {
    setIsRunning((running) => {
      if (running) {
        // Freeze: fold elapsed time into the anchor so resuming continues from
        // here rather than jumping forward by however long we were paused.
        const { songPos, wallClock } = anchorRef.current
        anchorRef.current = {
          songPos: songPos + (Date.now() - wallClock) / 1000,
          wallClock: Date.now(),
        }
      } else {
        anchorRef.current = { ...anchorRef.current, wallClock: Date.now() }
      }
      return !running
    })
  }, [])

  const nudge = useCallback((deltaSec: number) => {
    setNudgeSec((current) => Math.round((current + deltaSec) * 10) / 10)
    userScrolledAtRef.current = 0 // a nudge means "follow along again"
  }, [])

  // ---- Render -------------------------------------------------------------
  return (
    <section className="card lyrics-view" aria-label="Lyrics">
      <header className="lyrics-view__header">
        <h3 className="lyrics-view__title">Lyrics</h3>
        {lyrics?.status === 'found' && (
          <span className="lyrics-view__clock" aria-label="Position in song">
            {formatSeconds(effectivePosition)}
          </span>
        )}
      </header>

      {status === 'loading' && (
        <div className="lyrics-view__state" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>Looking for lyrics…</p>
        </div>
      )}

      {status === 'error' && (
        <div className="lyrics-view__state" role="alert">
          <p>{errorMessage}</p>
        </div>
      )}

      {status === 'ready' && lyrics?.status === 'not_found' && (
        <div className="lyrics-view__state">
          <p>
            No lyrics found for <strong>{song.title}</strong>.
          </p>
          <p className="lyrics-view__hint">
            LRCLIB is community-contributed, so rarer tracks, live cuts and
            instrumentals often aren&rsquo;t in it yet.
          </p>
        </div>
      )}

      {status === 'ready' && lyrics?.status === 'instrumental' && (
        <div className="lyrics-view__state">
          <p>This track is instrumental — nothing to sing along to.</p>
        </div>
      )}

      {status === 'ready' && lyrics?.status === 'unsynced' && (
        <>
          <p className="lyrics-view__hint lyrics-view__hint--top">
            Only untimed lyrics exist for this track, so they can&rsquo;t scroll in time.
          </p>
          <div className="lyrics-view__scroll" ref={scrollBoxRef}>
            <pre className="lyrics-view__plain">{lyrics.plainLyrics}</pre>
          </div>
        </>
      )}

      {status === 'ready' && lyrics?.status === 'found' && (
        <>
          {!canSync && (
            <p className="lyrics-view__hint lyrics-view__hint--top">
              No time offset was reported for this match, so the lyrics start from
              the beginning. Press play when the song starts.
            </p>
          )}

          {parsedLines.length === 0 ? (
            <div className="lyrics-view__state">
              <p>The lyrics for this track couldn&rsquo;t be read.</p>
            </div>
          ) : (
            <>
              <div
                className="lyrics-view__scroll"
                ref={scrollBoxRef}
                onWheel={noteUserScroll}
                onTouchMove={noteUserScroll}
              >
                {parsedLines.map((line, index) => (
                  <p
                    key={`${line.timeSec}-${index}`}
                    ref={(element) => {
                      lineRefs.current[index] = element
                    }}
                    className={
                      'lyrics-view__line' +
                      (index === activeIndex ? ' lyrics-view__line--active' : '') +
                      (index < activeIndex ? ' lyrics-view__line--past' : '')
                    }
                    aria-current={index === activeIndex ? 'true' : undefined}
                  >
                    {/* An empty cue marks an instrumental gap; show a dot so the
                        line does not collapse to nothing. */}
                    {line.text || '♪'}
                  </p>
                ))}
              </div>

              <div className="lyrics-view__controls">
                <button
                  type="button"
                  className="lyrics-view__button"
                  onClick={togglePlay}
                  aria-label={isRunning ? 'Pause lyrics' : 'Play lyrics'}
                >
                  {isRunning ? '❚❚' : '▶'}
                </button>

                <div className="lyrics-view__sync">
                  <button
                    type="button"
                    className="lyrics-view__button lyrics-view__button--small"
                    onClick={() => nudge(-1)}
                    aria-label="Lyrics are ahead — go back one second"
                  >
                    −1s
                  </button>
                  <span className="lyrics-view__nudge" aria-live="polite">
                    {nudgeSec === 0 ? 'in sync' : `${nudgeSec > 0 ? '+' : ''}${nudgeSec.toFixed(1)}s`}
                  </span>
                  <button
                    type="button"
                    className="lyrics-view__button lyrics-view__button--small"
                    onClick={() => nudge(1)}
                    aria-label="Lyrics are behind — go forward one second"
                  >
                    +1s
                  </button>
                </div>
              </div>

              <p className="lyrics-view__credit">
                Lyrics by{' '}
                <a href="https://lrclib.net" target="_blank" rel="noreferrer">
                  LRCLIB
                </a>
                {lyrics.matchedQuery.toLowerCase() !==
                  `${song.artist} - ${song.title}`.toLowerCase() && (
                  <> · matched “{lyrics.matchedQuery}”</>
                )}
              </p>
            </>
          )}
        </>
      )}
    </section>
  )
}
