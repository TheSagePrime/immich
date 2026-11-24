<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { getPlaybackPositionQuery } from '#lib/queries/video-library.query.ts';
  import { formatPlaybackTime, getResumePosition, PlaybackPositionTracker } from '#lib/utils/playback-position.ts';
  import { deletePlaybackPosition, updatePlaybackPosition } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { mdiRestart } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';

  type Props = {
    video: HTMLVideoElement | undefined;
    assetId: string;
    ready: boolean;
    fallbackDuration?: number;
  };

  const RESUME_NOTICE_MS = 8000;

  let { video, assetId, ready, fallbackDuration }: Props = $props();

  const enabled = $derived(authManager.authenticated && !authManager.isSharedLink);
  const query = createQuery(() => ({
    ...getPlaybackPositionQuery(assetId),
    enabled,
    refetchOnWindowFocus: false,
  }));
  const settled = $derived(query.status !== 'pending');

  let resumedFrom = $state<number | null>(null);
  let tracker: PlaybackPositionTracker | undefined;
  let resumeHandledFor: string | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const getDuration = (element: HTMLVideoElement) =>
    Number.isFinite(element.duration) && element.duration > 0 ? element.duration : fallbackDuration;

  const hideNotice = () => {
    clearTimeout(noticeTimer);
    resumedFrom = null;
  };

  const showNotice = (position: number) => {
    resumedFrom = position;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, RESUME_NOTICE_MS);
  };

  const applyResume = (element: HTMLVideoElement, id: string) => {
    if (resumeHandledFor === id) {
      return;
    }

    resumeHandledFor = id;
    const saved = query.data;
    const resume = saved ? getResumePosition(saved.position, getDuration(element) ?? saved.duration) : null;
    if (resume !== null && element.currentTime < 1) {
      element.currentTime = resume;
      showNotice(resume);
    }
  };

  $effect(() => {
    const element = video;
    const id = assetId;
    if (!enabled || !element || !ready || !settled) {
      return;
    }

    return untrack(() => {
      applyResume(element, id);

      const current = new PlaybackPositionTracker({
        save: (position, duration, options) =>
          updatePlaybackPosition({ id, playbackPositionUpdateDto: { position, duration } }, options),
        clear: (options) => deletePlaybackPosition({ id }, options),
        hasSavedPosition: !!query.data?.updatedAt,
      });
      current.start(element.currentTime, getDuration(element));
      tracker = current;

      const onTimeUpdate = () => current.onTimeUpdate(element.currentTime, getDuration(element));
      const onPause = () => void current.flush();
      const onEnded = () => void current.finish();
      const onPageHide = () => void current.flush({ keepalive: true });

      element.addEventListener('timeupdate', onTimeUpdate);
      element.addEventListener('pause', onPause);
      element.addEventListener('ended', onEnded);
      window.addEventListener('pagehide', onPageHide);

      return () => {
        element.removeEventListener('timeupdate', onTimeUpdate);
        element.removeEventListener('pause', onPause);
        element.removeEventListener('ended', onEnded);
        window.removeEventListener('pagehide', onPageHide);
        void current.flush({ keepalive: true });
        current.stop();
        if (tracker === current) {
          tracker = undefined;
        }
      };
    });
  });

  $effect(() => {
    void assetId;
    return () => {
      hideNotice();
      resumeHandledFor = undefined;
    };
  });

  const startOver = () => {
    hideNotice();
    if (!video) {
      return;
    }

    video.currentTime = 0;
    tracker?.onTimeUpdate(0, getDuration(video));
    void tracker?.flush();
  };
</script>

{#if resumedFrom !== null}
  <div
    transition:fade={{ duration: 150 }}
    class="absolute start-4 bottom-36 z-10 flex items-center gap-3 rounded-xl bg-black/70 py-2 ps-4 pe-2 text-sm text-white"
    role="status"
    data-testid="video-resume-notice"
  >
    <span>{$t('video_resumed_at', { values: { time: formatPlaybackTime(resumedFrom) } })}</span>
    <Button size="small" color="secondary" leadingIcon={mdiRestart} onclick={startOver}>{$t('video_start_over')}</Button>
  </div>
{/if}
