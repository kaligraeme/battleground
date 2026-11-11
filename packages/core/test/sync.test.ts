import { describe, expect, it } from 'vitest';
import { cloneJson, createDocument, parseYaml, stringifyDoc, syncDocument } from '../src';

const SAMPLE = `# yaml-language-server: $schema=https://docs.ludus.cloud/schemas/range-config.json

ludus:
  # The domain controller
  - vm_name: "{{ range_id }}-ad-dc-win2022-server-x64"
    hostname: "{{ range_id }}-DC01-2022"
    template: win2022-server-x64-template
    vlan: 10 # corp
    ip_last_octet: 11
    ram_gb: 8
    cpus: 4
    windows:
      sysprep: false
    domain:
      fqdn: ludus.domain
      role: primary-dc
  # Attacker box
  - vm_name: "{{ range_id }}-kali"
    hostname: "{{ range_id }}-kali"
    template: kali-x64-desktop-template
    vlan: 99
    ip_last_octet: 1
    ram_gb: 8
    cpus: 4
    linux: true
    testing:
      snapshot: false
      block_internet: false
`;

function edit(text: string, mutate: (cfg: any) => void): string {
  const parsed = parseYaml(text);
  expect(parsed.problems).toEqual([]);
  const prev = parsed.value;
  const next = cloneJson(prev);
  mutate(next);
  return stringifyDoc(syncDocument(parsed.doc, prev, next));
}

describe('syncDocument', () => {
  it('round-trips an untouched document byte for byte', () => {
    expect(edit(SAMPLE, () => {})).toBe(SAMPLE);
  });

  it('changes one scalar and keeps comments, quoting and layout', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus[0].vlan = 20;
    });
    expect(out).toBe(SAMPLE.replace('vlan: 10 # corp', 'vlan: 20 # corp'));
  });

  it('inserts new keys in canonical position', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus[1].ram_min_gb = 2;
      cfg.network = { inter_vlan_default: 'REJECT', rules: [{ name: 'k', vlan_src: 99, vlan_dst: 10, protocol: 'tcp', ports: '8080:8088', action: 'ACCEPT' }] };
    });
    expect(out).toContain('    ram_gb: 8\n    ram_min_gb: 2\n    cpus: 4\n    linux: true');
    expect(out).toContain('ports: "8080:8088"');
    expect(out).toContain('# The domain controller');
    expect(parseYaml(out).value).toMatchObject({ network: { inter_vlan_default: 'REJECT' } });
  });

  it('removes an item without disturbing the others', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus.splice(0, 1);
    });
    expect(out).not.toContain('DC01');
    expect(out).toContain('# Attacker box');
    expect(out).toContain('vm_name: "{{ range_id }}-kali"');
    expect((parseYaml(out).value as any).ludus).toHaveLength(1);
  });

  it('appends an item with safe quoting', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus.push({ cpus: 2, ram_gb: 4, vm_name: '{{ range_id }}-web', hostname: '{{ range_id }}-web', template: 'debian-12-x64-server-template', vlan: 20, ip_last_octet: 5, linux: true });
    });
    expect(out).toContain('  - vm_name: "{{ range_id }}-web"\n    hostname: "{{ range_id }}-web"\n    template: debian-12-x64-server-template\n    vlan: 20\n    ip_last_octet: 5\n    ram_gb: 4\n    cpus: 2\n    linux: true\n');
    expect(out).toContain('# The domain controller');
    expect(out).toContain('vlan: 10 # corp');
  });

  it('keeps comments when items are reordered', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus.reverse();
    });
    const value = parseYaml(out).value as any;
    expect(value.ludus.map((v: any) => v.vlan)).toEqual([99, 10]);
    expect(out).toContain('vlan: 10 # corp');
  });

  it('changes shape (linux: true -> packages)', () => {
    const out = edit(SAMPLE, (cfg) => {
      cfg.ludus[1].linux = { packages: ['curl', 'nmap'] };
    });
    expect((parseYaml(out).value as any).ludus[1].linux).toEqual({ packages: ['curl', 'nmap'] });
  });

  it('rebuilds documents that use anchors instead of corrupting them', () => {
    const text = `base: &b\n  cpus: 2\nludus:\n  - <<: *b\n    vm_name: a\n`;
    const parsed = parseYaml(text);
    const prev = parsed.value as any;
    const next = cloneJson(prev);
    next.ludus[0].cpus = 4;
    const out = stringifyDoc(syncDocument(parsed.doc, prev, next));
    expect((parseYaml(out).value as any).ludus[0].cpus).toBe(4);
    expect((parseYaml(out).value as any).base.cpus).toBe(2);
  });

  it('creates canonical documents from scratch', () => {
    const out = stringifyDoc(createDocument({ network: { inter_vlan_default: 'ACCEPT' }, ludus: [] }));
    expect(out.startsWith('# yaml-language-server: $schema=')).toBe(true);
    expect(out.indexOf('ludus:')).toBeLessThan(out.indexOf('network:'));
  });
});
