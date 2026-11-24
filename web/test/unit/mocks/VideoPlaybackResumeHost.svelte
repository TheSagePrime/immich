<script lang="ts">
  import VideoPlaybackResume from '../../../src/lib/components/asset-viewer/VideoPlaybackResume.svelte';

  type Props = {
    data: { video: HTMLVideoElement; assetId: string; fallbackDuration?: number };
  };

  let { data }: Props = $props();
</script>

<VideoPlaybackResume video={data.video} assetId={data.assetId} ready={true} fallbackDuration={data.fallbackDuration} />
