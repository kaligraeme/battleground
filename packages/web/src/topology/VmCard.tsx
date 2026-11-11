import { Cpu, GripVertical, Layers, LockOpen, MemoryStick, TriangleAlert } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { OsGlyph } from '../components/OsGlyph';
import { cx } from '../components/ui';
import type { VmNode } from './model';

export interface VmCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  vm: VmNode;
  selected?: boolean;
  /** Extra state classes: trace endpoints, drop targets. */
  flags?: { traceSrc?: boolean; traceDst?: boolean; target?: boolean; dragging?: boolean };
  /** Shown before the OS glyph in build mode. */
  grip?: ReactNode;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
}

const ROLE_TAG: Record<string, string> = {
  'primary-dc': 'DC',
  'alt-dc': 'ALT DC',
  member: 'MEMBER',
};

export function VmCard({ vm, selected, flags, grip, className, style, ref, ...rest }: VmCardProps) {
  const power = vm.power;
  return (
    <div
      ref={ref}
      className={cx(
        'vm',
        selected && 'vm--selected',
        power === 'absent' && 'vm--absent',
        power === 'off' && 'vm--off',
        vm.phase === 'working' && 'vm--working',
        vm.issue === 'error' && 'vm--error',
        vm.issue === 'warning' && 'vm--warning',
        flags?.traceSrc && 'vm--trace-src',
        flags?.traceDst && 'vm--trace-dst',
        flags?.target && 'vm--target',
        flags?.dragging && 'vm--dragging',
        className,
      )}
      style={style}
      data-nopan
      data-vm-index={vm.index}
      {...rest}
    >
      <div className="vm__row">
        {grip}
        <OsGlyph os={vm.os} />
        <span className="vm__title truncate" title={vm.title}>
          {vm.title}
        </span>
        <span className="vm__power row">
          {vm.issue ? (
            <TriangleAlert
              width={14}
              height={14}
              className={vm.issue === 'error' ? 'text-err' : 'text-warn'}
              aria-label={vm.issue === 'error' ? 'Has errors' : 'Has warnings'}
            />
          ) : null}
          {power ? (
            <span
              className={cx(
                'dot',
                power === 'on' && 'dot--ok',
                vm.phase === 'working' && 'dot--warn dot--pulse',
                vm.phase === 'failed' && 'dot--err',
              )}
              title={vm.phaseLabel ?? (power === 'on' ? 'Powered on' : power === 'off' ? 'Powered off' : 'Not deployed')}
            />
          ) : null}
        </span>
      </div>
      <div className="vm__sub truncate" title={`${vm.name} · ${vm.template}`}>
        {vm.phase === 'working' && vm.phaseLabel ? vm.phaseLabel : vm.name}
      </div>
      <div className="vm__meta">
        <span className="vm__ip">{vm.ip}</span>
        <span title={`${vm.cpus} vCPU`}>
          <Cpu />
          {vm.cpus}
        </span>
        <span title={`${vm.ramGb} GB RAM`}>
          <MemoryStick />
          {vm.ramGb}G
        </span>
        <span className="vm__tags">
          {vm.domain ? (
            <span className={cx('vm__tag', vm.domain.role !== 'member' && 'vm__tag--dc')} title={`${vm.domain.role} of ${vm.domain.fqdn}`}>
              {ROLE_TAG[vm.domain.role] ?? vm.domain.role}
            </span>
          ) : null}
          {vm.roleCount > 0 ? (
            <span className="vm__tag" title={`${vm.roleCount} Ansible role${vm.roleCount === 1 ? '' : 's'}`}>
              <Layers />
              {vm.roleCount}
            </span>
          ) : null}
          {!vm.testing.blockInternet ? (
            <span className="vm__tag vm__tag--testing" title="Keeps internet access in testing mode">
              <LockOpen />
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function VmGrip(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="vm__grip" aria-hidden {...props}>
      <GripVertical />
    </span>
  );
}
