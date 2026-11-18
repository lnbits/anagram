import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../scripts/call-audio-lab.html', import.meta.url), 'utf8');
test.use({
  permissions: ['microphone'],
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});
for (const mode of ['packet', 'webm', 'webrtc']) {
  test(`local audio comparison starts and cleans up ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/__call-audio-lab', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto('/__call-audio-lab');
    await page.locator('#mode').selectOption(mode);
    await page.locator('#start').click();
    await expect(page.locator('#status')).toContainText('Playing reference', { timeout: 20000 });
    await expect(page.locator('#metrics')).toContainText('microphoneDbFS');
    await expect
      .poll(() => page.locator('#remote').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(0.2);
    await page.locator('#stop').click();
    await expect(page.locator('#start')).toBeEnabled();
    expect(
      await page.locator('#remote').evaluate((audio: HTMLAudioElement) => audio.srcObject),
    ).toBeNull();
    expect(errors).toEqual([]);
  });
}
