import type { ListenStatus } from '../types'

interface ListenButtonProps {
  status: ListenStatus
  /** Seconds left in the current recording, used for the countdown label. */
  secondsLeft: number
  disabled: boolean
  onClick: () => void
}

/** The label changes with the status so the button itself explains what is happening. */
function labelFor(status: ListenStatus, secondsLeft: number): string {
  switch (status) {
    case 'requesting-mic':
      return 'Allow microphone…'
    case 'recording':
      return `Listening… ${secondsLeft}s`
    case 'identifying':
      return 'Identifying…'
    default:
      return 'Listen'
  }
}

export function ListenButton({ status, secondsLeft, disabled, onClick }: ListenButtonProps) {
  const isBusy = status === 'requesting-mic' || status === 'recording' || status === 'identifying'

  return (
    <button
      type="button"
      className="listen-button"
      // IMPORTANT: this is a plain onClick. Recording is kicked off directly
      // from this handler so iOS Safari can see the user's tap.
      onClick={onClick}
      disabled={disabled || isBusy}
      data-status={status}
      aria-live="polite"
    >
      {/* The pulsing ring only renders while we are actually capturing audio. */}
      {status === 'recording' && <span className="listen-button__pulse" aria-hidden="true" />}

      <span className="listen-button__icon" aria-hidden="true">
        {isBusy ? '●' : '🎤'}
      </span>
      <span className="listen-button__label">{labelFor(status, secondsLeft)}</span>
    </button>
  )
}
