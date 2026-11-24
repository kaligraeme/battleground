/** Simulation and gameplay constants shared by the server and the browser client. */

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
/** The server sends a world snapshot every this many ticks (10 per second). */
export const SNAPSHOT_EVERY = 2;

/** World units are tiles. One tile is roughly one stride. */
export const PLAYER_RADIUS = 0.45;
export const PLAYER_SPEED = 6;
export const SPRINT_BONUS = 0.35;

export const GCD = 2.5;
/** After any action the actor cannot start another for this long, so two abilities fit in one GCD. */
export const ANIMATION_LOCK = 0.6;
/** A GCD skill pressed within this window before the GCD ends is queued and fires when it ends. */
export const QUEUE_WINDOW = 0.5;
/** Moving during the last moments of a cast does not cancel it. */
export const SLIDECAST_WINDOW = 0.35;
export const COMBO_WINDOW = 15;
/** Damage and heal over time effects tick on this interval. */
export const DOT_TICK = 3;
export const CRIT_CHANCE = 0.1;
export const CRIT_MULT = 1.5;

/** Melee skills reach this far past both hitboxes. */
export const MELEE_RANGE = 3;
/** Radius of "party" effects such as songs and area heals. */
export const PARTY_EFFECT_RADIUS = 20;

/** How long players have to accept a ready check. */
export const READY_CHECK_SECONDS = 30;
export const PARTY_SIZE = 4;

/** Seconds without combat before out-of-combat regeneration starts. */
export const OUT_OF_COMBAT_DELAY = 4;
