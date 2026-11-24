import BottomInfo from '#lib/components/shared-components/side-bar/BottomInfo.svelte';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { queryClient } from '#lib/queries/client.ts';
import { factory } from '#test/common/factories.ts';
import { payload } from '#test/common/payloads.ts';
import { cleanup, render } from 'vitest-browser-svelte';

vi.mock('#lib/components/shared-components/side-bar/PurchaseInfo.svelte', async () => {
  const { default: Empty } = await import('#test/unit/mocks/Empty.svelte');
  return { default: Empty };
});

vi.mock('#lib/components/shared-components/side-bar/StorageSpace.svelte', async () => {
  const { default: Empty } = await import('#test/unit/mocks/Empty.svelte');
  return { default: Empty };
});

vi.mock('#lib/components/shared-components/side-bar/ServerStatus.svelte', async () => {
  const { default: Empty } = await import('#test/unit/mocks/Empty.svelte');
  return { default: Empty };
});

const setSimpleMode = (simpleMode: boolean) => {
  const config = payload.userConfig();
  queryClient.setQueryData(['config', 'user'], { ...config, server: { ...config.server, simpleMode } });
};

describe('BottomInfo', () => {
  beforeEach(() => {
    authManager.setUser(factory.user({ isAdmin: false }));
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    authManager.reset();
  });

  it('shows the purchase information when simple mode is off', async () => {
    setSimpleMode(false);
    const { baseElement } = await render(BottomInfo);

    expect(baseElement.querySelectorAll('[data-testid="mock-component"]')).toHaveLength(3);
  });

  it('hides the purchase information in simple mode', async () => {
    setSimpleMode(true);
    const { baseElement } = await render(BottomInfo);

    expect(baseElement.querySelectorAll('[data-testid="mock-component"]')).toHaveLength(2);
  });
});
