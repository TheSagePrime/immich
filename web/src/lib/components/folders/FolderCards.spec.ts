import FolderCards from '#lib/components/folders/FolderCards.svelte';
import { mdiFolder } from '@mdi/js';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';

const items = [
  { label: 'summer', path: '/photos/summer', assetCount: 3, coverAssetId: '00000000-0000-4000-a000-000000000001' },
  { label: 'empty', path: '/photos/empty', assetCount: 0, coverAssetId: null },
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
    expect(onClick).toHaveBeenCalledWith(items[0]);

    await rerender({ items, icon: mdiFolder, onClick, onToggle, selectable: true, selected: new Set() });
    baseElement.querySelector<HTMLButtonElement>(':scope [data-testid="folder-card"] button')!.click();
    expect(onToggle).toHaveBeenCalledWith(items[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without items', async () => {
    const { baseElement } = await render(FolderCards, { items: [], icon: mdiFolder, onClick: vi.fn() });

    expect(baseElement.querySelector('[data-testid="folder-cards"]')).toBeNull();
  });
});
