import { setUserOnboarding } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils';

/**
 * Browser-level check that a large file goes up in chunks rather than one request.
 *
 * Point PLAYWRIGHT_BASE_URL at the capped nginx proxy to also prove it survives a reverse proxy
 * with a request-body limit, which is the case the feature exists for:
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:2290 LARGE_FILE=/path/to/over-16MiB.png
 */
const largeFile = process.env.LARGE_FILE;

test.describe('resumable upload (web)', () => {
  test.skip(!largeFile, 'requires LARGE_FILE to point at a file larger than one 16MiB chunk');

  test.beforeAll(() => {
    utils.initSdk();
  });

  test('uploads a large file in chunks', async ({ context, page }) => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup();
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(admin.accessToken) });
    await utils.setAuthCookies(context, admin.accessToken);

    // the network trace is the actual assertion: which requests the browser really made
    const requests: { method: string; url: string }[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/assets')) {
        requests.push({ method: request.method(), url: request.url() });
      }
    });

    await page.goto('/photos');
    await expect(page).toHaveURL(/\/photos/);

    // the timeline is empty after the reset, so the placeholder is the upload entry point;
    // the uploader creates its file input on demand
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByText('Click to upload your first photo').click();
    const chooser = await chooserPromise;
    await chooser.setFiles(largeFile!);

    const uploadedCount = async () => {
      const result = await utils.searchAssets(admin.accessToken, { originalFileName: 'large.png' });
      return result.assets.total;
    };
    await expect.poll(uploadedCount, { timeout: 180_000, intervals: [1000] }).toBe(1);

    const creates = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/assets/upload'));
    const patches = requests.filter((r) => r.method === 'PATCH' && r.url.includes('/assets/upload/'));
    const singleRequest = requests.filter((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/assets');

    expect(creates).toHaveLength(1);
    expect(patches.length).toBeGreaterThan(1);
    expect(singleRequest).toHaveLength(0);
  });
});
