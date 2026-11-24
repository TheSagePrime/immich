export const PLAYBACK_MIN_DURATION_SECONDS = 60;
export const PLAYBACK_MIN_POSITION_SECONDS = 5;
export const PLAYBACK_END_MARGIN_SECONDS = 10;
export const PLAYBACK_END_MARGIN_RATIO = 0.05;
export const PLAYBACK_SAVE_INTERVAL_MS = 10_000;

const isKnownDuration = (duration: number | null | undefined): duration is number =>
  duration !== null && duration !== undefined && Number.isFinite(duration) && duration > 0;

export const isResumableDuration = (duration: number | null | undefined) =>
  !isKnownDuration(duration) || duration >= PLAYBACK_MIN_DURATION_SECONDS;

export const getResumePosition = (position: number, duration: number | null | undefined): number | null => {
  if (!Number.isFinite(position) || position < PLAYBACK_MIN_POSITION_SECONDS) {
    return null;
  }

  if (!isKnownDuration(duration)) {
    return position;
  }

  if (duration < PLAYBACK_MIN_DURATION_SECONDS) {
    return null;
  }

  const endMargin = Math.max(PLAYBACK_END_MARGIN_SECONDS, duration * PLAYBACK_END_MARGIN_RATIO);
  return position >= duration - endMargin ? null : position;
};

export const formatPlaybackTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
};

type RequestOptions = { keepalive?: boolean };

export type PlaybackPositionTrackerOptions = {
  save: (position: number, duration: number | undefined, options: RequestOptions) => Promise<unknown>;
  clear: (options: RequestOptions) => Promise<unknown>;
  hasSavedPosition: boolean;
  now?: () => number;
  intervalMs?: number;
};

export class PlaybackPositionTracker {
  #save: PlaybackPositionTrackerOptions['save'];
  #clear: PlaybackPositionTrackerOptions['clear'];
  #now: () => number;
  #intervalMs: number;
  #hasSavedPosition: boolean;
  #started = false;
  #lastSavedPosition: number | null = null;
  #lastSavedAt = 0;
  #position = 0;
  #duration: number | undefined;

  constructor({
    save,
    clear,
    hasSavedPosition,
    now = Date.now,
    intervalMs = PLAYBACK_SAVE_INTERVAL_MS,
  }: PlaybackPositionTrackerOptions) {
    this.#save = save;
    this.#clear = clear;
    this.#now = now;
    this.#intervalMs = intervalMs;
    this.#hasSavedPosition = hasSavedPosition;
  }

  get started() {
    return this.#started;
  }

  start(position: number, duration?: number) {
    this.#started = true;
    this.#update(position, duration);
    this.#lastSavedAt = this.#now();
  }

  onTimeUpdate(position: number, duration?: number) {
    if (!this.#started) {
      return;
    }

    this.#update(position, duration);
    if (this.#now() - this.#lastSavedAt >= this.#intervalMs) {
      void this.flush();
    }
  }

  async flush(options: RequestOptions = {}) {
    if (!this.#started || !isResumableDuration(this.#duration)) {
      return;
    }

    this.#lastSavedAt = this.#now();
    const resumePosition = getResumePosition(this.#position, this.#duration);

    if (resumePosition === null) {
      await this.#clearSaved(options);
      return;
    }

    if (this.#lastSavedPosition !== null && Math.abs(this.#lastSavedPosition - resumePosition) < 1) {
      return;
    }

    this.#lastSavedPosition = resumePosition;
    this.#hasSavedPosition = true;
    await this.#run(() => this.#save(resumePosition, this.#duration, options));
  }

  async finish(options: RequestOptions = {}) {
    if (!this.#started) {
      return;
    }

    this.#lastSavedAt = this.#now();
    await this.#clearSaved(options);
  }

  stop() {
    this.#started = false;
  }

  #update(position: number, duration?: number) {
    if (Number.isFinite(position)) {
      this.#position = position;
    }

    if (isKnownDuration(duration)) {
      this.#duration = duration;
    }
  }

  async #clearSaved(options: RequestOptions) {
    if (!this.#hasSavedPosition) {
      return;
    }

    this.#hasSavedPosition = false;
    this.#lastSavedPosition = null;
    await this.#run(() => this.#clear(options));
  }

  async #run(request: () => Promise<unknown>) {
    try {
      await request();
    } catch (error) {
      console.warn('Unable to save the playback position', error);
    }
  }
}
