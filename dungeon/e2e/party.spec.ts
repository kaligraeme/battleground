import { expect, test, type Page } from '@playwright/test';

async function enter(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Hero name').fill(name);
  await page.getByRole('button', { name: 'Enter' }).click();
  await expect(page.locator('.lobby')).toBeVisible();
}

const world = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { lumenfall: { game: { world: { duty: { phase: string; rooms: { status: string }[] }; partyMembers(): unknown[]; meEntity(): { x: number; y: number } | undefined } } | null } }).lumenfall.game;
    if (!g) return null;
    const me = g.world.meEntity();
    return { phase: g.world.duty.phase, cleared: g.world.duty.rooms.filter((r) => r.status === 'cleared').length, members: g.world.partyMembers().length, me: me ? { x: me.x, y: me.y } : null };
  });

test('two players form a party, queue with AI fill and clear the first room together', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  for (const p of [alice, bob]) p.on('pageerror', (e) => errors.push(e.message));

  await enter(alice, 'Alice');
  await enter(bob, 'Bob');

  // Alice plays a ranger with the Windsong Harp; Bob joins her party by code and plays melee.
  await alice.locator('.role-card[data-role="ranger"]').click();
  await alice.getByRole('button', { name: /Windsong Harp/ }).click();
  await expect(alice.locator('.weapon-card.selected')).toContainText('Windsong Harp');
  const code = (await alice.locator('.code-box .code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z2-9]{5}$/);
  await bob.locator('.role-card[data-role="melee"]').click();
  await bob.getByLabel('Party code').fill(code);
  await bob.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(alice.locator('.party-slot:not(.empty)')).toHaveCount(2);
  await expect(bob.locator('.party-slot:not(.empty)')).toHaveCount(2);

  // Party chat reaches both members.
  await bob.getByLabel('Party chat').fill('ready when you are');
  await bob.getByLabel('Party chat').press('Enter');
  await expect(alice.locator('.chat-lines')).toContainText('ready when you are');

  // Only the leader can queue.
  await expect(bob.getByRole('button', { name: 'Join Queue' })).toBeDisabled();
  await alice.locator('.fill-options button', { hasText: 'Now' }).click();
  await alice.getByRole('button', { name: 'Join Queue' }).click();

  // The ready check lists both players and two AI companions, including a Dawn Staff healer.
  for (const p of [alice, bob]) {
    await expect(p.locator('.modal .ready-slot')).toHaveCount(4);
    await expect(p.locator('.modal .ai-badge')).toHaveCount(2);
  }
  await expect(alice.locator('.modal')).toContainText('Dawn Staff');
  await alice.getByRole('button', { name: 'Commence' }).click();
  await bob.getByRole('button', { name: 'Commence' }).click();

  for (const p of [alice, bob]) {
    await expect(p.locator('canvas.world')).toBeVisible();
    await expect(p.locator('.pl-member')).toHaveCount(4);
    await expect(p.locator('.hotbar .slot')).toHaveCount(10);
  }
  await expect.poll(async () => (await world(alice))?.phase, { timeout: 10_000 }).toBe('running');

  // Bob walks, and Alice sees him move.
  const before = await bob.evaluate(() => {
    const g = (window as unknown as { lumenfall: { game: { world: { meEntity(): { x: number; y: number } } } } }).lumenfall.game;
    return { ...g.world.meEntity() };
  });
  await bob.keyboard.down('d');
  await bob.waitForTimeout(700);
  await bob.keyboard.up('d');
  await bob.keyboard.down('s');
  await bob.waitForTimeout(500);
  await bob.keyboard.up('s');
  const bobId = await bob.evaluate(() => (window as unknown as { lumenfall: { game: { world: { meId: number } } } }).lumenfall.game.world.meId);
  await expect
    .poll(
      async () =>
        alice.evaluate((id) => {
          const e = (window as unknown as { lumenfall: { game: { world: { ents: Map<number, { x: number; y: number }> } } } }).lumenfall.game.world.ents.get(id);
          return e ? { x: e.x, y: e.y } : null;
        }, bobId),
      { timeout: 5_000 },
    )
    .not.toEqual(before);

  // The AI tank leads the way. Both players follow it (F) and fight until the first room falls.
  for (const p of [alice, bob]) {
    await p.keyboard.press('Escape');
    await p.keyboard.press('f');
    await expect(p.locator('.skill-error')).toContainText('Following');
  }
  const deadline = Date.now() + 120_000;
  let cleared = 0;
  while (Date.now() < deadline && cleared < 2) {
    for (const p of [alice, bob]) for (const k of ['1', '2', '3']) await p.keyboard.press(k);
    await alice.waitForTimeout(400);
    cleared = (await world(alice))?.cleared ?? 0;
  }
  expect(cleared).toBeGreaterThanOrEqual(2);
  await expect(alice.locator('.duty-obj .obj.done').first()).toBeVisible();
  expect(errors).toEqual([]);
});
