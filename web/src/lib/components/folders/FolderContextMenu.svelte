<script lang="ts">
  import Portal from '#lib/elements/Portal.svelte';
  import type { FolderMenuItem } from '#lib/services/folder.service.ts';
  import { Icon } from '@immich/ui';
  import { onMount, tick } from 'svelte';

  type Props = {
    items: FolderMenuItem[];
    x: number;
    y: number;
    label: string;
    onClose: () => void;
  };

  const { items, x, y, label, onClose }: Props = $props();

  let menu: HTMLElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);
  let previousFocus: Element | null = null;

  const getButtons = () => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];

  const close = () => {
    onClose();
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
  };

  const handleSelect = async (item: FolderMenuItem) => {
    if (item.disabled) {
      return;
    }

    close();
    await item.onAction();
  };

  const moveFocus = (step: number) => {
    const buttons = getButtons();
    if (buttons.length === 0) {
      return;
    }

    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = index === -1 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const onkeydown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'Escape': {
        close();
        break;
      }
      case 'ArrowDown': {
        moveFocus(1);
        break;
      }
      case 'ArrowUp': {
        moveFocus(-1);
        break;
      }
      case 'Home': {
        getButtons().at(0)?.focus();
        break;
      }
      case 'End': {
        getButtons().at(-1)?.focus();
        break;
      }
      case 'Tab': {
        close();
        break;
      }
      default: {
        return;
      }
    }

    event.preventDefault();
    event.stopPropagation();
  };

  onMount(async () => {
    previousFocus = document.activeElement;
    await tick();
    const width = menu?.offsetWidth ?? 0;
    const height = menu?.offsetHeight ?? 0;
    left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    getButtons().at(0)?.focus();
  });
</script>

<Portal target="body">
  <div
    class="fixed inset-0 z-1000"
    role="presentation"
    onclick={close}
    oncontextmenu={(event) => {
      event.preventDefault();
      close();
    }}
  ></div>
  <div
    bind:this={menu}
    role="menu"
    tabindex="-1"
    aria-label={label}
    class="fixed z-1001 flex w-64 flex-col gap-0.5 overflow-hidden rounded-xl border bg-light-100 py-1 text-sm shadow-lg dark:border-light-300"
    style:left="{left}px"
    style:top="{top}px"
    data-testid="folder-context-menu"
    {onkeydown}
  >
    {#each items as item (item.id)}
      <button
        type="button"
        role="menuitem"
        class="mx-1 flex items-center gap-2 rounded-lg p-2 text-start outline-none hover:bg-light-200 focus-visible:bg-light-200 disabled:cursor-not-allowed disabled:opacity-50 {item.color ===
        'danger'
          ? 'text-danger'
          : ''}"
        disabled={item.disabled}
        aria-disabled={item.disabled}
        title={item.disabled ? item.hint : undefined}
        data-testid="folder-menu-{item.id}"
        onclick={() => handleSelect(item)}
      >
        <Icon icon={item.icon} class="shrink-0" size="1.25rem" />
        <span class="flex grow flex-col">
          <span class="font-medium">{item.title}</span>
          {#if item.disabled && item.hint}
            <span class="text-xs text-gray-500 dark:text-gray-400">{item.hint}</span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
</Portal>
