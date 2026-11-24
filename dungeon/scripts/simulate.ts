/**
 * Runs a dungeon with four AI companions as fast as possible and prints how it went.
 * Usage: npm run simulate -- [seed] [count]
 */
import { Instance, formatTime, type Seat } from '../src/server/sim/instance.js';

const seed0 = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 1);
const seats: Seat[] = [
  { ownerId: null, name: 'Aldric', role: 'tank', weapon: 'sword_shield' },
  { ownerId: null, name: 'Sera', role: 'mage', weapon: 'dawn_staff' },
  { ownerId: null, name: 'Tamsin', role: 'ranger', weapon: 'longbow' },
  { ownerId: null, name: 'Corvin', role: 'melee', weapon: 'twin_daggers' },
];

for (let n = 0; n < count; n++) {
  const seed = seed0 + n;
  const inst = new Instance(`sim-${seed}`, seats, { seed });
  const started = Date.now();
  const limit = 40 * 60 * 20;
  const log: string[] = [];
  while (inst.phase !== 'complete' && inst.ticks < limit) {
    inst.tick();
    for (const ev of inst.drainEvents()) {
      if (ev.e === 'banner') log.push(`[${formatTime(inst.now)}] ${ev.text}${ev.sub ? ` - ${ev.sub}` : ''}`);
    }
  }
  const res = inst.results();
  console.log(`seed ${seed}: ${inst.plan.name} (${inst.plan.bossCount} bosses, ${inst.plan.rooms.length} rooms, map ${inst.map.w}x${inst.map.h})`);
  console.log(`  ${inst.phase === 'complete' ? 'COMPLETE' : 'DID NOT FINISH'} in ${formatTime(inst.now)} game time, ${inst.wipes} wipes, ${Date.now() - started} ms real time`);
  for (const r of res) console.log(`  ${r.name.padEnd(8)} ${r.role.padEnd(7)} dmg ${String(r.damage).padStart(8)}  heal ${String(r.healing).padStart(7)}  deaths ${r.deaths}  raises ${r.raises}`);
  if (process.env.VERBOSE) for (const l of log) console.log('   ', l);
}
