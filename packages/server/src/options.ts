import { resolve } from 'node:path';

export const VERSION = '0.1.0';

export interface ServerOptions {
  host: string;
  port: number;
  /** Directory for state and logs. `null` keeps everything in memory (tests). */
  dataDir: string | null;
  /** Directory holding the built web UI, if any. */
  publicDir: string | null;
  /** Simulated seconds per real second; `0` runs every simulated step instantly. Undefined keeps the saved setting. */
  speed?: number;
  /** Whether the bundled templates start out built. */
  templatesPrebuilt: boolean;
  tls?: { certFile: string; keyFile: string };
  admin: {
    name: string;
    userID: string;
    email: string;
    /** When absent a random password is generated and printed once. */
    password?: string;
  };
  /** Silences the startup banner (tests). */
  quiet: boolean;
}

export const DEFAULT_SPEED = 60;

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number, got "${value}"`);
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export const USAGE = `Battleground ${VERSION} - a portable, Ludus-compatible cyber range simulator

Usage:
  battleground [options]            Start the server
  battleground reset-admin          Reset the admin password and API key, print them, and exit

Options (each also has an environment variable):
  --host <addr>       Address to listen on            BATTLEGROUND_HOST        (default 127.0.0.1)
  --port <n>          Port for the API and web UI      BATTLEGROUND_PORT        (default 8080)
  --data <dir>        Where state and logs are kept    BATTLEGROUND_DATA_DIR    (default ./data)
  --speed <n>         Simulated seconds per second;    BATTLEGROUND_SPEED       (default ${DEFAULT_SPEED})
                      0 = finish every step instantly
  --unbuilt-templates Start with no templates built    BATTLEGROUND_TEMPLATES=unbuilt
  --tls-cert <file>   Serve HTTPS with this cert       BATTLEGROUND_TLS_CERT
  --tls-key <file>    ...and this private key          BATTLEGROUND_TLS_KEY
  -h, --help          Show this help
  -v, --version       Show the version

First-run admin account (only used when the data directory is empty):
  BATTLEGROUND_ADMIN_NAME      (default "Battleground Admin")
  BATTLEGROUND_ADMIN_USERID    (default "BG")
  BATTLEGROUND_ADMIN_EMAIL     (default "admin@battleground.local")
  BATTLEGROUND_ADMIN_PASSWORD  (default: generated and printed once)
`;

export interface ParsedCli {
  command: 'serve' | 'reset-admin' | 'help' | 'version';
  options: ServerOptions;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv, defaults: { publicDir: string | null }): ParsedCli {
  const flags = new Map<string, string | true>();
  let command: ParsedCli['command'] = 'serve';
  const valueFlags = new Set(['--host', '--port', '--data', '--speed', '--tls-cert', '--tls-key']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') command = 'help';
    else if (arg === '-v' || arg === '--version') command = 'version';
    else if (arg === 'reset-admin') command = 'reset-admin';
    else if (arg === '--unbuilt-templates') flags.set(arg, true);
    else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags.set(arg, value);
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [name, ...rest] = arg.split('=');
      if (!valueFlags.has(name as string)) throw new Error(`Unknown option ${name}`);
      flags.set(name as string, rest.join('='));
    } else {
      throw new Error(`Unknown argument "${arg}". Run with --help for usage.`);
    }
  }

  const str = (flag: string, envName: string): string | undefined => {
    const value = flags.get(flag);
    if (typeof value === 'string') return value;
    const fromEnv = env[envName];
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  };

  const certFile = str('--tls-cert', 'BATTLEGROUND_TLS_CERT');
  const keyFile = str('--tls-key', 'BATTLEGROUND_TLS_KEY');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('TLS needs both a certificate and a key (--tls-cert and --tls-key).');
  }

  const options: ServerOptions = {
    host: str('--host', 'BATTLEGROUND_HOST') ?? '127.0.0.1',
    port: num(str('--port', 'BATTLEGROUND_PORT'), 8080, 'port'),
    dataDir: resolve(str('--data', 'BATTLEGROUND_DATA_DIR') ?? 'data'),
    publicDir: env.BATTLEGROUND_PUBLIC_DIR ? resolve(env.BATTLEGROUND_PUBLIC_DIR) : defaults.publicDir,
    speed: str('--speed', 'BATTLEGROUND_SPEED') === undefined ? undefined : num(str('--speed', 'BATTLEGROUND_SPEED'), DEFAULT_SPEED, 'speed'),
    templatesPrebuilt: flags.has('--unbuilt-templates') ? false : (env.BATTLEGROUND_TEMPLATES ?? 'built') !== 'unbuilt',
    tls: certFile && keyFile ? { certFile: resolve(certFile), keyFile: resolve(keyFile) } : undefined,
    admin: {
      name: env.BATTLEGROUND_ADMIN_NAME || 'Battleground Admin',
      userID: env.BATTLEGROUND_ADMIN_USERID || 'BG',
      email: env.BATTLEGROUND_ADMIN_EMAIL || 'admin@battleground.local',
      password: env.BATTLEGROUND_ADMIN_PASSWORD || undefined,
    },
    quiet: bool(env.BATTLEGROUND_QUIET, false),
  };
  return { command, options };
}
