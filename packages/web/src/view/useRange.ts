import { type RangeConfig, parseYaml } from '@battleground/core';
import { useMemo } from 'react';
import { useApp } from '../lib/store';
import { buildTopologyModel } from '../topology/buildModel';

export function parseConfig(text: string | null | undefined): RangeConfig | undefined {
  if (!text) return undefined;
  const parsed = parseYaml(text);
  if (parsed.problems.length > 0 || !parsed.value || typeof parsed.value !== 'object') return undefined;
  return parsed.value as RangeConfig;
}

/** Everything the View tab needs about the current range, derived once per poll. */
export function useRangeData(rangeId: string) {
  const session = useApp((s) => s.session);
  const meta = useApp((s) => s.meta);
  const detailRaw = useApp((s) => s.detail);
  const detailFor = useApp((s) => s.detailFor);
  const detailError = useApp((s) => s.detailError);
  const detail = detailFor === rangeId ? detailRaw : null;
  const summary = session?.ranges.find((r) => r.rangeID === rangeId);
  const config = useMemo(() => parseConfig(detail?.config), [detail?.config]);
  const deployedConfig = useMemo(() => parseConfig(detail?.deployedConfig), [detail?.deployedConfig]);
  const rangeNumber = detail?.range.rangeNumber ?? summary?.rangeNumber ?? 1;
  const vpnClientIp = `198.51.100.${session?.user.userNumber ?? 2}`;
  const model = useMemo(
    () => buildTopologyModel({ config, rangeId, rangeNumber, detail, vpnClientIp }),
    [config, rangeId, rangeNumber, detail, vpnClientIp],
  );
  const undeployed = Boolean(detail?.deployedConfig && detail.deployedConfig !== detail.config);
  return { session, meta, detail, detailError: detailFor === rangeId ? detailError : null, summary, config, deployedConfig, model, rangeNumber, undeployed };
}
