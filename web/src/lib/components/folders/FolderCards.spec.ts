import FolderCards from '#lib/components/folders/FolderCards.svelte';
import type { FolderCard } from '#lib/utils/folder-cards.ts';
import { mdiFolder } from '@mdi/js';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';

const items: FolderCard[] = [
  {
    label: 'summer',
    path: '/photos/summer',
    href: '/folders?root=a&path=summer',
    kind: 'folder',
    writable: true,
    assetCount: 3,
    coverAssetId: '00000000-0000-4000-a000-000000000001',
  },
  {
    label: 'empty',
    path: '/photos/empty',
    href: '/folders?root=a&path=empty',
    kind: 'folder',
    writable: true,
    assetCount: 0,
    coverAssetId: null,
  },
];

describe('FolderCards', () => {
  it('renders a cover thumbnail and the item count', async () => {
    const { baseElement } = await render(FolderCards, { items, icon: mdiFolder, onClick: vi.fn() });

    const cards = baseElement.querySelectorAll('[data-testid="folder-card"]');
    expect(cards).toHaveLength(2);

    const cover = cards[0].querySelector('[data-testid="folder-cover"]');
    expect(cover?.getAttribute('src')).toContain('/assets/00000000-0000-4000-a000-000000000001/thumbnail');
    expect(cover?.getAttribute('loading')).toBe('lazy');
    expect(cards[0].querySelector('[data-testid="folder-count"]')?.textContent?.trim()).toBe('items_count');
  });

  it('falls back to the folder icon without a cover', async () => {
    const { baseElement } = await render(FolderCards, { items, icon: mdiFolder, onClick: vi.fn() });

    const cards = baseElement.querySelectorAll('[data-testid="folder-card"]');
    expect(cards[1].querySelector('[data-testid="folder-cover"]')).toBeNull();
    expect(cards[1].querySelector('svg')).not.toBeNull();
  });

  it('opens a folder on click and toggles it in selection mode', async () => {
    const onClick = vi.fn();
    const onToggle = vi.fn();
    const { baseElement, rerender } = await render(FolderCards, { items, icon: mdiFolder, onClick, onToggle });

    baseElement.querySelector<HTMLButtonElement>(':scope [data-testid="folder-card"] button')!.click();
    expect(onClick).toHaveBeenCalledWith(items[0], expect.any(MouseEvent));

    await rerender({ items, icon: mdiFolder, onClick, onToggle, selectable: true, selected: new Set() });
    baseElement.querySelector<HTMLButtonElement>(':scope [data-testid="folder-card"] button')!.click();
    expect(onToggle).toHaveBeenCalledWith(items[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without items', async () => {
    const { baseElement } = await render(FolderCards, { items: [], icon: mdiFolder, onClick: vi.fn() });

    expect(baseElement.querySelector('[data-testid="folder-cards"]')).toBeNull();
  });

  it('opens the menu on right-click and from the menu button', async () => {
    const onMenu = vi.fn();
    const { baseElement } = await render(FolderCards, { items, icon: mdiFolder, onClick: vi.fn(), onMenu });

    const card = baseElement.querySelector<HTMLElement>('[data-testid="folder-card"]')!;
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
    card.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onMenu).toHaveBeenCalledWith(items[0], { x: 12, y: 34 });

    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click();
    expect(onMenu).toHaveBeenCalledTimes(2);
  });

  it('accepts drops only where allowed and highlights the target', async () => {
    const onDrop = vi.fn();
    const onDragOver = vi.fn();
    const { baseElement } = await render(FolderCards, {
      items,
      icon: mdiFolder,
      onClick: vi.fn(),
      dropTarget: '/photos/empty',
      canDrop: (item: FolderCard) => item.path === '/photos/empty',
      onDragOver,
      onDrop,
    });

    const [summer, empty] = baseElement.querySelectorAll<HTMLElement>('[data-testid="folder-card"]');
    expect(empty.dataset.dropTarget).toBe('true');
    expect(summer.dataset.dropTarget).toBeUndefined();

    summer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    expect(onDrop).not.toHaveBeenCalled();

    const over = new DragEvent('dragover', { bubbles: true, cancelable: true });
    empty.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(onDragOver).toHaveBeenCalledWith(items[1]);

    empty.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    expect(onDrop).toHaveBeenCalledWith(items[1]);
  });
});
