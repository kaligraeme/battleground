/**
 * Minimal ustar reading and writing, enough for the archives the Ludus CLI
 * uploads (template and role directories) and for blueprint exports.
 */

export interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  data: Uint8Array;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function field(block: Uint8Array, offset: number, length: number): string {
  const raw = decoder.decode(block.subarray(offset, offset + length));
  const nul = raw.indexOf('\0');
  return nul === -1 ? raw : raw.slice(0, nul);
}

export function readTar(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(header, 0, 100);
    const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] ?? 48);
    const prefix = field(header, 345, 155);
    if (Number.isNaN(size)) throw new Error('Invalid tar header');
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (typeflag === 'L') {
      longName = decoder.decode(data).replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue; // pax headers
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (typeflag === '5') entries.push({ path: path.replace(/\/$/, ''), type: 'dir', data: new Uint8Array() });
    else if (typeflag === '0' || typeflag === '\0') entries.push({ path, type: 'file', data: new Uint8Array(data) });
  }
  return entries;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

export function writeTar(entries: ReadonlyArray<{ path: string; data: Uint8Array | string; mode?: number }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const header = new Uint8Array(512);
    const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
    if (encoder.encode(entry.path).length > 100) throw new Error(`Path too long for tar: ${entry.path}`);
    put(entry.path, 0);
    put(octal(entry.mode ?? 0o644, 8), 100);
    put(octal(0, 8), 108);
    put(octal(0, 8), 116);
    put(octal(data.length, 12), 124);
    put(octal(mtime, 12), 136);
    put('        ', 148);
    header[156] = 48; // '0' regular file
    put('ustar\x0000', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
