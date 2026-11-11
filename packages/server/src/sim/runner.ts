import { AbortedError, type SimClock } from './clock';
import { countTask, formatHostLine, formatRecap, noHostsMatched, playBanner, taskBanner } from './ansibleLog';
import type { DeployScenario, Effect, RecapCounters, SimPlay, SimTask, Stage } from './types';

export type RunStatus = 'success' | 'failure' | 'aborted';

export interface RunProgress {
  stage: Stage;
  play: string;
  task?: string;
  /** VMs the current task acts on. */
  focus: string[];
  /** Simulated seconds of work done and in total. */
  done: number;
  total: number;
}

export interface RunHooks {
  write(text: string): void;
  effect(effect: Effect): void;
  progress(progress: RunProgress): void;
}

export interface RunOptions {
  clock: SimClock;
  signal: AbortSignal;
  /** Caps the real time any single task may take (for requests that wait on the run). */
  maxTaskMs?: number;
}

export function scenarioSeconds(plays: readonly SimPlay[]): number {
  return plays.reduce((sum, play) => sum + play.tasks.reduce((s, task) => s + task.seconds, 0), 0);
}

function formatTaskLines(task: SimTask): string {
  let out = '';
  for (const line of task.lines) {
    if (line.note) out += `${line.note}\n`;
    out += formatHostLine(line);
    if (line.ignored) out += '...ignoring\n';
  }
  return out;
}

/**
 * Plays a scenario back: banners and results go to the log as tasks start and
 * finish, effects are applied when their task completes, and the recap is
 * written at the end, as `ansible-playbook` would.
 */
export async function runScenario(scenario: DeployScenario, options: RunOptions, hooks: RunHooks): Promise<RunStatus> {
  const counters = new Map<string, RecapCounters>();
  const total = scenarioSeconds(scenario.plays);
  let done = 0;
  let failed = false;
  try {
    outer: for (const play of scenario.plays) {
      hooks.write(playBanner(play.name));
      if (play.hosts.length === 0) {
        hooks.write(noHostsMatched());
        continue;
      }
      hooks.progress({ stage: play.stage, play: play.name, focus: [], done, total });
      for (const task of play.tasks) {
        hooks.write(taskBanner(task.name));
        hooks.progress({ stage: play.stage, play: play.name, task: task.name, focus: task.focus ?? [], done, total });
        await options.clock.sleep(task.seconds, options.signal, options.maxTaskMs);
        hooks.write(formatTaskLines(task));
        countTask(counters, task);
        for (const effect of task.effects ?? []) hooks.effect(effect);
        done += task.seconds;
        if (task.lines.some((line) => line.result === 'fatal' && !line.rescued && !line.ignored)) failed = true;
        if (task.fatal) break outer;
      }
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      hooks.write('\n[ERROR]: User interrupted execution\n');
      return 'aborted';
    }
    throw err;
  }
  hooks.write(formatRecap(counters));
  hooks.progress({ stage: 'finish', play: 'PLAY RECAP', focus: [], done: total, total });
  return failed || scenario.fails ? 'failure' : 'success';
}
