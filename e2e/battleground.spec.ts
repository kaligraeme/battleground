import { type Locator, type Page, expect, test } from '@playwright/test';
import { E2E_ADMIN_PASSWORD } from '../playwright.config';

// The tests share one server and build on each other's changes.
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, hash = '#/view'): Promise<void> {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`/ui/${hash}`);
  await page.getByLabel('Email or user ID').fill('BG');
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.topbar')).toBeVisible();
}

/** A pointer drag in small steps, the way a person drags (dnd-kit needs real pointer moves). */
async function dragTo(page: Page, source: Locator, target: Locator): Promise<void> {
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('drag source or target is not visible');
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 15;
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}

test('signing in shows the default range from the Ludus example config', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('.rangebar h2')).toHaveText('Default Range for Battleground Admin');
  await expect(page.locator('.lane__tag')).toHaveText(['VLAN 10', 'VLAN 99']);
  await expect(page.locator('.vm')).toHaveCount(3);
  await expect(page.locator('.rangebar')).toContainText('NEVER DEPLOYED');
});

test('build a range by drag and drop, then save and deploy it', async ({ page }) => {
  await signIn(page, '#/build');
  await expect(page.locator('.palette__item').first()).toBeVisible();

  // A template dropped on "New VLAN" creates the next free VLAN with a machine on it.
  await dragTo(page, page.locator('.palette__item[data-template="debian-12-x64-server-template"]'), page.locator('.lane--ghost'));
  await expect(page.locator('.lane:not(.lane--ghost) .lane__tag')).toHaveText(['VLAN 10', 'VLAN 20', 'VLAN 99']);
  await expect(page.locator('.insp-head h3')).toHaveText('BG-debian12');

  // Machines can be dragged between VLANs.
  await dragTo(page, page.locator('.vm', { hasText: 'BG-debian12' }), page.locator('.lane[data-vlan="10"]'));
  await expect(page.locator('.lane:not(.lane--ghost) .lane__tag')).toHaveText(['VLAN 10', 'VLAN 99']);
  await expect(page.locator('.lane[data-vlan="10"] .lane__count')).toHaveText('3 VMs');

  await expect(page.locator('.buildbar__status')).toContainText('Unsaved changes');
  await page.getByRole('button', { name: 'Save & deploy' }).click();

  await expect(page.locator('.viewtab')).toBeVisible();
  await expect(page.locator('.rangebar')).toContainText('SUCCESS', { timeout: 30_000 });
  await expect(page.locator('pre.log')).toContainText('PLAY RECAP');
  await expect(page.locator('pre.log')).toContainText('BG-debian12');
});

test('the traffic simulator follows the router firewall rules', async ({ page }) => {
  await signIn(page);
  await page.getByRole('tab', { name: 'Traffic' }).click();
  const from = page.locator('select[aria-label="From"]');
  const to = page.locator('select[aria-label="To"]');

  await from.selectOption({ label: 'BG-kali (10.1.99.1)' });
  await to.selectOption({ label: 'BG-DC01-2022 (10.1.10.11)' });
  await expect(page.locator('.verdict')).toContainText('Allowed');
  await expect(page.locator('.verdict')).toContainText('Allow kali to all windows');

  await from.selectOption({ label: 'BG-DC01-2022 (10.1.10.11)' });
  await to.selectOption({ label: 'BG-kali (10.1.99.1)' });
  await expect(page.locator('.verdict')).toContainText('Rejected');
  await expect(page.locator('.verdict')).toContainText('inter_vlan_default: REJECT');
});

test('the YAML editor reports what a Ludus server would reject', async ({ page }) => {
  await signIn(page, '#/build');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('bogus_key: 1\n');
  await page.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.locator('.problems')).toContainText('Additional property bogus_key is not allowed');

  // Saving is refused until the problem is fixed; discarding restores the saved config.
  await page.locator('.buildbar').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('The config has errors');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('.buildbar__status')).toContainText('Valid Ludus config');
});
