import {
  PLAYBACK_SAVE_INTERVAL_MS,
  PlaybackPositionTracker,
  formatPlaybackTime,
  getResumePosition,
} from '#lib/utils/playback-position.ts';

describe('getResumePosition', () => {
  it.each([
    [0, 600, null],
    [4.9, 600, null],
    [5, 600, 5],
    [300, 600, 300],
    [569, 600, 569],
    [570, 600, null],
    [100, 120, 100],
    [111, 120, null],
    [30, 45, null],
    [30, null, 30],
    [NaN, 600, null],
  ])('should resume %s of %s at %s', (position, duration, expected) => {
    expect(getResumePosition(position, duration)).toBe(expected);
  });
});

describe('formatPlaybackTime', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [-3, '0:00'],
  ])('should format %s as %s', (seconds, expected) => {
    expect(formatPlaybackTime(seconds)).toBe(expected);
  });
});

describe(PlaybackPositionTracker.name, () => {
  const setup = (hasSavedPosition = false) => {
    let now = 0;
    const save = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    const tracker = new PlaybackPositionTracker({ save, clear, hasSavedPosition, now: () => now });
    const advance = (ms: number) => (now += ms);
    return { tracker, save, clear, advance };
  };

  it('should ignore time updates before it is started', () => {
    const { tracker, save, advance } = setup();
    advance(PLAYBACK_SAVE_INTERVAL_MS * 2);
    tracker.onTimeUpdate(100, 600);
    expect(save).not.toHaveBeenCalled();
  });

  it('should throttle saves while playing', () => {
    const { tracker, save, advance } = setup();
    tracker.start(0, 600);

    for (let second = 1; second <= 25; second++) {
      advance(1000);
      tracker.onTimeUpdate(second, 600);
    }

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(1, 10, 600, {});
    expect(save).toHaveBeenNthCalledWith(2, 20, 600, {});
  });

  it('should not save the same position twice', async () => {
    const { tracker, save } = setup();
    tracker.start(42, 600);

    await tracker.flush();
    await tracker.flush();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('should pass keepalive through when flushing', async () => {
    const { tracker, save } = setup();
    tracker.start(0, 600);
    tracker.onTimeUpdate(42, 600);

    await tracker.flush({ keepalive: true });

    expect(save).toHaveBeenCalledWith(42, 600, { keepalive: true });
  });

  it('should clear a saved position when the video is watched to the end', async () => {
    const { tracker, save, clear } = setup(true);
    tracker.start(300, 600);
    tracker.onTimeUpdate(595, 600);

    await tracker.flush();

    expect(save).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('should clear a saved position when restarting from the beginning', async () => {
    const { tracker, clear } = setup(true);
    tracker.start(0, 600);
    tracker.onTimeUpdate(2, 600);

    await tracker.flush();
    await tracker.flush();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('should not clear anything when nothing was saved', async () => {
    const { tracker, clear } = setup(false);
    tracker.start(0, 600);

    await tracker.finish();

    expect(clear).not.toHaveBeenCalled();
  });

  it('should clear after ending a saved video', async () => {
    const { tracker, clear } = setup(false);
    tracker.start(0, 600);
    tracker.onTimeUpdate(100, 600);
    await tracker.flush();

    await tracker.finish();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('should not track short clips', async () => {
    const { tracker, save, clear } = setup(true);
    tracker.start(0, 30);
    tracker.onTimeUpdate(20, 30);

    await tracker.flush();

    expect(save).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('should stop tracking after stop', async () => {
    const { tracker, save } = setup();
    tracker.start(0, 600);
    tracker.stop();
    tracker.onTimeUpdate(100, 600);

    await tracker.flush();

    expect(save).not.toHaveBeenCalled();
  });

  it('should swallow request errors', async () => {
    const { tracker, save } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    save.mockRejectedValue(new Error('offline'));
    tracker.start(100, 600);

    await expect(tracker.flush()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
