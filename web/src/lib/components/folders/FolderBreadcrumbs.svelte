<script lang="ts">
  import type { FolderCrumb } from '#lib/utils/folder-roots.ts';
  import { Breadcrumbs, ControlBar, ControlBarHeader, IconButton } from '@immich/ui';
  import { mdiArrowUpLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    crumbs: FolderCrumb[];
    homeHref: string;
    title: string;
    icon: string;
    canDrop?: (crumb: FolderCrumb) => boolean;
    onDrop?: (crumb: FolderCrumb) => void;
  };

  const { crumbs, homeHref, title, icon, canDrop, onDrop }: Props = $props();

  const items = $derived([
    { icon, title, href: homeHref },
    ...crumbs.map((crumb, index) =>
      index === crumbs.length - 1 ? { title: crumb.title } : { title: crumb.title, href: crumb.href },
    ),
  ]);
  const linked = $derived(crumbs.slice(0, -1));
  const parentLink = $derived(crumbs.length === 0 ? undefined : (crumbs.at(-2)?.href ?? homeHref));

  let container: HTMLElement | undefined = $state();
  let highlighted: HTMLElement | undefined;

  const findCrumb = (event: DragEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    if (!anchor || !container) {
      return;
    }

    const anchors = [...container.querySelectorAll('a')];
    const index = anchors.indexOf(anchor) - 1;
    const crumb = linked[index];
    return crumb && canDrop?.(crumb) ? { anchor, crumb } : undefined;
  };

  const setHighlight = (anchor?: HTMLElement) => {
    if (highlighted === anchor) {
      return;
    }

    highlighted?.classList.remove('ring-2', 'ring-primary', 'rounded-md', 'bg-primary/20');
    delete highlighted?.dataset.dropTarget;
    highlighted = anchor;
    highlighted?.classList.add('ring-2', 'ring-primary', 'rounded-md', 'bg-primary/20');
    if (highlighted) {
      highlighted.dataset.dropTarget = 'true';
    }
  };

  const ondragover = (event: DragEvent) => {
    const match = findCrumb(event);
    setHighlight(match?.anchor);
    if (match) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    }
  };

  const ondrop = (event: DragEvent) => {
    const match = findCrumb(event);
    setHighlight();
    if (match) {
      event.preventDefault();
      onDrop?.(match.crumb);
    }
  };
</script>

<ControlBar>
  <ControlBarHeader class="flex-row gap-4 overflow-x-auto">
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      icon={mdiArrowUpLeft}
      aria-label={$t('to_parent')}
      href={parentLink}
      disabled={!parentLink}
    />
    <div
      bind:this={container}
      class="min-w-0"
      role="navigation"
      aria-label={$t('folders')}
      data-testid="folder-breadcrumbs"
      {ondragover}
      ondragleave={(event) => {
        if (!container?.contains(event.relatedTarget as Node | null)) {
          setHighlight();
        }
      }}
      {ondrop}
    >
      <Breadcrumbs {items} class="min-w-0 flex-wrap [&_a]:text-primary" />
    </div>
  </ControlBarHeader>
</ControlBar>
