import type { Song } from '../types'
import { timecodeToSeconds } from '../lib/recognize'

interface SongCardProps {
  song: Song
}

/** Shows the recognised song: title, artist, and where we are inside the track. */
export function SongCard({ song }: SongCardProps) {
  const offsetSeconds = timecodeToSeconds(song.timecode)

  return (
    <section className="card song-card" aria-label="Recognised song">
      <p className="song-card__eyebrow">Now playing</p>
      <h2 className="song-card__title">{song.title}</h2>
      <p className="song-card__artist">{song.artist}</p>

      {song.album && <p className="song-card__album">{song.album}</p>}

      {/* The time offset is the key piece for the next milestone: it tells us
          which lyric line should be highlighted right now. */}
      <div className="song-card__offset">
        <span className="song-card__offset-label">Time into song</span>
        <span className="song-card__offset-value">{song.timecode ?? '—'}</span>
        {offsetSeconds !== null && (
          <span className="song-card__offset-seconds">({offsetSeconds}s)</span>
        )}
      </div>

      {song.songLink && (
        <a className="song-card__link" href={song.songLink} target="_blank" rel="noreferrer">
          More about this track ↗
        </a>
      )}
    </section>
  )
}
