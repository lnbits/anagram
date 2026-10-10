import { test, expect } from '@playwright/test';

test('production CSP blocks injected inline/remote scripts and base URL changes while allowing Wasm', async ({
  page,
}) => {
  const response = await page.goto('/');
  await expect(page.getByTestId('auth-open-login-button')).toBeVisible();
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  const html = await response!.text();
  const policy = html.match(/http-equiv="content-security-policy" content="([^"]+)"/i)?.[1] ?? '';
  expect(await page.evaluate(() => '__appE2E__' in window)).toBe(false);
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'none'");
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.effectiveDirective),
    );
    const inline = document.createElement('script');
    inline.textContent = 'window.__securityProbe = true';
    document.body.append(inline);
    const external = document.createElement('script');
    external.src = 'https://untrusted-script.invalid/exfiltrate.js';
    document.body.append(external);
    const base = document.createElement('base');
    base.href = 'https://untrusted-base.invalid/';
    document.head.append(base);
    await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      executed: Boolean((window as any).__securityProbe),
      base: document.baseURI,
      violations,
    };
  });
  expect(result.executed).toBe(false);
  expect(result.base).toBe('http://127.0.0.1:5189/');
  expect(result.violations.filter((directive) => directive === 'script-src-elem')).toHaveLength(2);
  expect(result.violations).toContain('base-uri');
});
