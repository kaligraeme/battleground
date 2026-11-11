/**
 * The simulated output of a template build (`packer build` against Proxmox),
 * shaped like the log a Ludus server keeps for each build.
 */

import { templateInfo } from '@battleground/core';
import type { PackerInput, PackerStep } from './types';

const ISO: Record<string, string> = {
  debian12: 'https://cdimage.debian.org/cdimage/archive/12.1.0/amd64/iso-cd/debian-12.1.0-amd64-netinst.iso',
  debian13: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso',
  kali: 'https://cdimage.kali.org/current/kali-linux-2026.3-installer-netinst-amd64.iso',
  'win11-22h2-x64-enterprise':
    'https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66751/22621.525.220925-0207.ni_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso',
  'win2022-server-x64': 'https://software-static.download.prss.microsoft.com/sg/download/888969d5-f34g-4e03-ac9d-1f9786c66749/SERVER_EVAL_x64FRE_en-us.iso',
};

/** The marker a Ludus server appends to the log of a successful build. */
export const BUILD_COMPLETE = '\n\n=>================\n=> Build complete!\n=>================\n\n';

export function buildPackerScenario(input: PackerInput & { vmid: number }): PackerStep[] {
  const info = templateInfo(input.name, input.os);
  const label = info.packerLabel;
  const ui = (text: string) => `ui: ==> proxmox-iso.${label}: ${text}`;
  const out = (text: string) => `ui:     proxmox-iso.${label}: ${text}`;
  const iso = ISO[label] ?? `https://isos.example.invalid/${label}.iso`;
  const windows = info.os === 'windows';
  const dhcp = `192.0.2.${50 + (input.vmid % 50)}`;

  const steps: PackerStep[] = [
    {
      seconds: 1,
      lines: [
        '[INFO] Packer version: 1.11.2 [go1.22.6 linux amd64]',
        '[TRACE] discovering plugins in /opt/ludus/resources/packer/plugins',
        '[INFO] Discovered potential plugin: ansible = /opt/ludus/resources/packer/plugins/github.com/hashicorp/ansible/packer-plugin-ansible_v1.1.1_x5.0_linux_amd64',
        '[INFO] Discovered potential plugin: proxmox = /opt/ludus/resources/packer/plugins/github.com/badsectorlabs/proxmox/packer-plugin-proxmox_v1.2.3_x5.0_linux_amd64',
        ui('Retrieving ISO'),
        ui(`Trying ${iso}`),
      ],
    },
    { seconds: windows ? 240 : 90, lines: [ui(`Trying ${iso}?checksum=sha${windows ? 256 : 512}%3A${'0123456789abcdef'.repeat(4)}`)] },
  ];
  if (windows) {
    steps.push({
      seconds: 60,
      lines: [ui('Retrieving additional ISO'), ui('Trying https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.240-1/virtio-win-0.1.240.iso')],
    });
    steps.push({ seconds: 5, lines: [ui('Creating CD disk...'), out('Creating hybrid ISO from CD files: Autounattend.xml, setup-for-ansible.ps1, win-updates.ps1, windows-common-setup.ps1')] });
  }
  steps.push({ seconds: 25, lines: [ui('Creating VM'), ui(`No VM ID given, getting next free from Proxmox`)] });
  steps.push({ seconds: 6, lines: [ui('Starting VM')] });
  if (!windows) {
    steps.push({ seconds: 2, lines: [ui(`Starting HTTP server on port ${8000 + (input.vmid % 900)}`)] });
    steps.push({ seconds: 15, lines: [ui('Waiting 15s for boot')] });
    steps.push({ seconds: 12, lines: [ui('Typing the boot command')] });
    steps.push({ seconds: 5, lines: [ui('Waiting for SSH to become available...')] });
    // The installer runs unattended for most of the build; the guest agent only answers at the end.
    for (let i = 0; i < 6; i++) {
      steps.push({ seconds: info.name.startsWith('kali') ? 160 : 110, lines: [`[DEBUG] Error getting SSH address: 500 QEMU guest agent is not running`] });
    }
    steps.push({ seconds: 3, lines: [ui(`Using SSH communicator to connect: ${dhcp}`), ui('Connected to SSH!')] });
    const playbook = info.name.startsWith('kali') ? '/opt/ludus/packer/kali/kali.yml' : '/opt/ludus/packer/ansible/reset-ssh-host-keys.yml';
    steps.push({
      seconds: 4,
      lines: [
        ui('Provisioning with Ansible...'),
        out('Setting up proxy adapter for Ansible....'),
        ui(`Executing Ansible: ansible-playbook -e packer_build_name="${label}" -e packer_builder_type=proxmox-iso -e packer_http_addr=192.0.2.254:${8000 + (input.vmid % 900)} --ssh-extra-args '-o IdentitiesOnly=yes' -e ansible_ssh_private_key_file=/tmp/ansible-key -i /tmp/packer-provisioner-ansible ${playbook}`),
      ],
    });
    if (info.name.startsWith('kali')) {
      steps.push({
        seconds: 600,
        lines: [
          out('PLAY [Setup Kali (install kasmvnc)] *******************************************'),
          out('TASK [Gathering Facts] *********************************************************'),
          out('ok: [default]'),
          out('TASK [Install packages] ********************************************************'),
          out('changed: [default]'),
        ],
      });
      steps.push({
        seconds: 120,
        lines: [
          out('TASK [Download kasmvnc deb] ****************************************************'),
          out('changed: [default]'),
          out('TASK [Install the kasmvnc deb] *************************************************'),
          out('changed: [default]'),
          out('TASK [Create a service for kasmvnc] ********************************************'),
          out('changed: [default]'),
          out('TASK [Enable the kasmvnc service] **********************************************'),
          out('changed: [default]'),
          out('PLAY RECAP *********************************************************************'),
          out('default                    : ok=15   changed=12   unreachable=0    failed=0    skipped=2    rescued=0    ignored=1   '),
        ],
      });
    } else {
      steps.push({
        seconds: 20,
        lines: [
          out('PLAY [Create and enable SSH host keys regeneration service] ********************'),
          out('TASK [Gathering Facts] *********************************************************'),
          out('ok: [default]'),
          out('TASK [Create systemd service file for SSH host keys regeneration] **************'),
          out('changed: [default]'),
          out('TASK [Reload systemd daemon] ***************************************************'),
          out('ok: [default]'),
          out('TASK [Enable SSH host keys regeneration service] *******************************'),
          out('changed: [default]'),
          out('PLAY RECAP *********************************************************************'),
          out('default                    : ok=4    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   '),
        ],
      });
    }
  } else {
    if (label.startsWith('win11')) {
      steps.push({ seconds: 120, lines: [ui('Typing the boot command')] });
    }
    steps.push({ seconds: 5, lines: [ui('Waiting for WinRM to become available...')] });
    for (let i = 0; i < 8; i++) {
      steps.push({ seconds: 240, lines: ['[DEBUG] Error getting WinRM host: 500 QEMU guest agent is not running'] });
    }
    steps.push({ seconds: 30, lines: [out('WinRM connected.'), ui('Connected to WinRM!')] });
    steps.push({ seconds: 15, lines: [ui('Provisioning with windows-shell...'), out('==> Disabling Windows Updates')] });
    steps.push({ seconds: 10, lines: [ui('Provisioning with Powershell...'), ui('Provisioning with powershell script: ../scripts/disable-hibernate.ps1')] });
    steps.push({
      seconds: 60,
      lines: [
        ui('Provisioning with Powershell...'),
        ui('Provisioning with powershell script: ../scripts/install-virtio-drivers.ps1'),
        out('Added 4A2E1E2B6F05F8A31B5C64A1C3F57F2E7C2D0F81, CN=Red Hat, Inc., O=Red Hat, Inc. from E:\\Balloon\\2k22\\amd64\\balloon.cat'),
      ],
    });
    steps.push({ seconds: 600, lines: [ui('Provisioning with Powershell...'), ui('Provisioning with powershell script: ../scripts/optimize-assemblies.ps1'), out('Optimization complete.')] });
    steps.push({
      seconds: 300,
      lines: [
        ui('Provisioning with Ansible...'),
        out('PLAY [Generate native .NET images for CPU] *************************************'),
        out('TASK [Run ngen tasks] **********************************************************'),
        out('changed: [default]'),
        out('PLAY RECAP *********************************************************************'),
        out('default                    : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   '),
      ],
    });
  }
  steps.push({ seconds: 20, lines: [ui('Stopping VM')] });
  steps.push({ seconds: 15, lines: [ui('Converting VM to template'), `Build 'proxmox-iso.${label}' finished.`, '==> Builds finished. The artifacts of successful builds are:', `--> proxmox-iso.${label}: A template was created: ${input.vmid}`] });
  return steps;
}
