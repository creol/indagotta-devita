/**
 * A tiny wrapper around the MediaRecorder API.
 * ---------------------------------------------------------------------------
 * Recording in a browser is a four step dance:
 *   1. ask the user for microphone access  (getUserMedia)
 *   2. wrap the resulting stream in a MediaRecorder
 *   3. collect the chunks it emits
 *   4. stop, and -- importantly -- release the microphone
 *
 * The comments below call out the bits that differ between browsers, and
 * especially the ones that bite on iOS Safari.
 */

/**
 * Audio formats we are happy to record in, best first.
 *
 * Chrome/Firefox/Android produce WebM+Opus. iOS Safari cannot do WebM at all
 * and produces MP4/AAC instead, so we must ask the browser what it supports
 * rather than hard-coding a format.
 */
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4', // iOS Safari
  'audio/aac',
  'audio/ogg;codecs=opus',
]

/** True when this browser can record audio at all. */
export function isRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    // Note: mediaDevices is undefined on plain http:// pages (localhost is fine).
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

/** Picks the first format this browser can actually record. */
function pickMimeType(): string | undefined {
  // Very old Safari has MediaRecorder but not isTypeSupported. In that case we
  // pass no mimeType at all and let the browser choose its own default.
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

export interface RecordingResult {
  blob: Blob
  mimeType: string
  /**
   * `Date.now()` at the instant capture stopped -- i.e. the wall-clock time of
   * the LAST audio in `blob`.
   *
   * This is what the lyrics clock anchors to. AudD's `timecode` reports where
   * the matched fragment sits in the song, and for a clip shorter than the
   * 12-second window AudD matches against, that lands at the end of what we
   * sent rather than the beginning. Anchoring to the start instead put the
   * lyrics a whole clip-length ahead of the music.
   */
  stoppedAtMs: number
}

export interface RecordOptions {
  /** How long to record, in milliseconds. */
  durationMs: number
  /** Called once the microphone is live and audio is actually being captured. */
  onRecordingStarted?: () => void
}

/**
 * Records a short audio clip and resolves with it.
 *
 * ⚠️  iOS SAFARI: this function must be called *synchronously* from a real user
 * gesture -- i.e. straight out of an onClick handler. Safari ties microphone
 * permission to the tap that requested it, so calling this from a timer, a
 * useEffect, or after an unrelated `await` will silently fail with a
 * NotAllowedError even if the user has already granted permission before.
 */
export async function recordClip({
  durationMs,
  onRecordingStarted,
}: RecordOptions): Promise<RecordingResult> {
  // ---- 1. Ask for the microphone ------------------------------------------
  // This is the very first thing we do so the browser can still see that we
  // are inside the user's tap. Everything else waits until after.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Music recognition works best on the raw signal. These filters are
      // tuned for speech and can chew up the details a fingerprint needs.
      // They are "ideal" hints -- a browser that disagrees just ignores them.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  })

  try {
    // ---- 2. Set up the recorder -------------------------------------------
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

    // ---- 3. Collect the audio chunks --------------------------------------
    const chunks: Blob[] = []
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })

    // Set the moment we stop capture, so the timestamp is not skewed by however
    // long the browser then takes to assemble the blob.
    let stoppedAtMs = 0

    const finished = new Promise<RecordingResult>((resolve, reject) => {
      recorder.addEventListener('stop', () => {
        // recorder.mimeType is the format the browser actually used, which can
        // differ from what we asked for. The server needs the real one.
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(chunks, { type })
        if (blob.size === 0) {
          reject(new Error('No audio was captured. Check that your microphone is not muted.'))
          return
        }
        resolve({ blob, mimeType: type, stoppedAtMs: stoppedAtMs || Date.now() })
      })

      recorder.addEventListener('error', () => {
        reject(new Error('Recording failed unexpectedly.'))
      })
    })

    // ---- 4. Record for the requested duration ------------------------------
    // The 250ms timeslice makes the recorder emit data as it goes. Some Safari
    // versions produce nothing at all if you only ask for one chunk at the end.
    recorder.start(250)
    onRecordingStarted?.()

    await new Promise((resolve) => setTimeout(resolve, durationMs))

    // The recorder may already have stopped itself if something went wrong.
    stoppedAtMs = Date.now()
    if (recorder.state !== 'inactive') recorder.stop()

    return await finished
  } finally {
    // ---- 5. Always release the microphone ---------------------------------
    // Skipping this leaves the browser's "recording" indicator on, and on iOS
    // it keeps the audio session captured so other sounds stay ducked.
    stream.getTracks().forEach((track) => track.stop())
  }
}

/**
 * Turns a recorded Blob into a base64 string we can put inside a JSON request.
 *
 * Base64 makes the payload ~33% bigger, but it keeps both sides of the wire
 * dead simple: plain JSON in, plain JSON out, no multipart parsing anywhere.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the recorded audio.'))
    reader.onload = () => {
      // FileReader gives us a data URL like "data:audio/webm;base64,GkXfo59..."
      // and we only want the part after the comma.
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      resolve(base64)
    }
    reader.readAsDataURL(blob)
  })
}
