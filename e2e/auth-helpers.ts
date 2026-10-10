import { expect, type Page } from '@playwright/test';
export async function finishOnboarding(page: Page) {
  const next = page.getByTestId('auth-onboarding-relays-next-button');
  await expect(next).toBeEnabled();
  await next.click();
  const action = page
    .getByTestId('auth-onboarding-skip-button')
    .or(page.getByTestId('auth-onboarding-continue-button'))
    .or(page.getByTestId('auth-onboarding-profile-start-button'));
  await expect(action).toBeVisible({ timeout: 20000 });
  await action.click();
  const skip = page.getByTestId('auth-notifications-skip');
  await expect(skip.or(page.getByRole('navigation', { name: 'Main navigation' }))).toBeVisible();
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}
