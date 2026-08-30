/** Everything the UI needs to know about a recognised song. */
export interface Song {
  title: string
  artist: string
  album: string | null
  releaseDate: string | null
  label: string | null
  /** How far into the song our clip was, formatted as "mm:ss" (e.g. "01:24"). */
  timecode: string | null
  /** A shareable audd.io link to the track, when available. */
  songLink: string | null
}

/**
 * The three possible outcomes of a recognition attempt. Modelling it as a
 * union means the UI can never accidentally show a song and an error at once.
 */
export type RecognitionResponse =
  | { status: 'found'; song: Song }
  | { status: 'not_found' }

/** Every state the Listen button can be in, in the order they happen. */
export type ListenStatus = 'idle' | 'requesting-mic' | 'recording' | 'identifying' | 'done' | 'error'
