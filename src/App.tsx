import { useCallback, useEffect, useRef, useState } from 'react'
import { ListenButton } from './components/ListenButton'
import { SongCard } from './components/SongCard'
import { LyricsView } from './components/LyricsView'
import { isRecordingSupported, recordClip } from './lib/recorder'
import { recognizeClip, timecodeToSeconds } from './lib/recognize'
import type { ListenStatus, RecognitionResponse } from './types'

/** How long we listen for. AudD works well with anything from ~5s upwards. */
const RECORD_SECONDS = 10

export default function App() {
  const [status, setStatus] = useState<ListenStatus>('idle')
  const [result, setResult] = useState<RecognitionResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(RECORD_SECONDS)

  // Held in a ref (not state) so we can always clear it, even from cleanup.
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // When the microphone actually went live. AudD's timecode describes the start
  // of the recorded clip, so this timestamp plus that offset is what lets the
  // lyrics work out where the song is *now* -- roughly 12 seconds later, once
  // recording, recognition and the lyrics lookup have all finished.
  const [recordingStartedAtMs, setRecordingStartedAtMs] = useState<number | null>(null)

  // Some browsers simply cannot do this. Checking once up front lets us show a
  // clear explanation instead of a button that fails when tapped.
  const [supported] = useState(isRecordingSupported)

  const stopCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current)
      countdownRef.current = null
    }
  }, [])

  // Make sure a timer never outlives the component.
  useEffect(() => stopCountdown, [stopCountdown])

  /**
   * The whole flow lives in this one click handler.
   *
   * ⚠️  iOS SAFARI: `recordClip` (and therefore getUserMedia) is called with no
   * `await` before it. Safari only grants microphone access to code that runs
   * as a direct result of a tap, so anything slow -- a fetch, a state settle,
   * a permission pre-check -- must not happen first.
   */
  const handleListen = useCallback(async () => {
    // Reset anything left over from the previous attempt.
    setResult(null)
    setErrorMessage(null)
    setRecordingStartedAtMs(null)
    setSecondsLeft(RECORD_SECONDS)
    setStatus('requesting-mic')

    try {
      const { blob, mimeType } = await recordClip({
        durationMs: RECORD_SECONDS * 1000,
        // Fired once the microphone is actually live, so the countdown we show
        // matches the audio we are really capturing.
        onRecordingStarted: () => {
          setRecordingStartedAtMs(Date.now())
          setStatus('recording')
          countdownRef.current = setInterval(() => {
            setSecondsLeft((current) => (current > 0 ? current - 1 : 0))
          }, 1000)
        },
      })

      stopCountdown()
      setStatus('identifying')

      const recognition = await recognizeClip(blob, mimeType)
      setResult(recognition)
      setStatus('done')
    } catch (error) {
      stopCountdown()
      setErrorMessage(toFriendlyMessage(error))
      setStatus('error')
    }
  }, [stopCountdown])

  const song = result?.status === 'found' ? result.song : null

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Sing&nbsp;Along</h1>
        <p className="app__subtitle">
          Tap Listen, hold your phone towards the music, and we&rsquo;ll find the song.
        </p>
      </header>

      {supported ? (
        <>
          <ListenButton
            status={status}
            secondsLeft={secondsLeft}
            disabled={false}
            onClick={handleListen}
          />

          <p className="app__hint">
            {status === 'idle' && `We'll record about ${RECORD_SECONDS} seconds.`}
            {status === 'requesting-mic' && 'Waiting for microphone permission…'}
            {status === 'recording' && 'Listening — keep the music playing.'}
            {status === 'identifying' && 'Matching the clip against millions of songs…'}
            {status === 'done' && 'Tap Listen again to try another song.'}
            {status === 'error' && 'Something went wrong — you can try again.'}
          </p>
        </>
      ) : (
        <div className="card card--warning">
          <h2>Recording isn&rsquo;t available</h2>
          <p>
            This browser doesn&rsquo;t support microphone recording. Try Safari on iOS, or Chrome on
            Android or desktop. Note that microphone access also requires <strong>https://</strong>{' '}
            (or <strong>localhost</strong>).
          </p>
        </div>
      )}

      {/* ---- Error state ---- */}
      {status === 'error' && errorMessage && (
        <div className="card card--error" role="alert">
          <h2>Couldn&rsquo;t identify the song</h2>
          <p>{errorMessage}</p>
        </div>
      )}

      {/* ---- Loading state ---- */}
      {status === 'identifying' && (
        <div className="card card--loading" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>Identifying the song…</p>
        </div>
      )}

      {/* ---- "We heard you, but found nothing" state ---- */}
      {result?.status === 'not_found' && (
        <div className="card card--empty">
          <h2>No match found</h2>
          <p>
            Try again with the music a little louder, closer to your phone, or during a section with
            vocals.
          </p>
        </div>
      )}

      {/* ---- Success state ---- */}
      {song && (
        <>
          <SongCard song={song} />
          <LyricsView
            song={song}
            startOffsetSec={timecodeToSeconds(song.timecode)}
            recordingStartedAtMs={recordingStartedAtMs}
          />
        </>
      )}

      <footer className="app__footer">
        <p>
          Song recognition by{' '}
          <a href="https://audd.io" target="_blank" rel="noreferrer">
            AudD
          </a>
        </p>
      </footer>
    </main>
  )
}

/**
 * Browser errors from getUserMedia are precise but unfriendly. Translate the
 * common ones into something a person can act on.
 */
function toFriendlyMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was blocked. Allow it in your browser settings, then tap Listen again.'
      case 'NotFoundError':
        return 'No microphone was found on this device.'
      case 'NotReadableError':
        return 'The microphone is already in use by another app. Close it and try again.'
      default:
        return `Recording failed (${error.name}).`
    }
  }

  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}
