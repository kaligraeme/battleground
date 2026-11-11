import { DndContext, type DragEndEvent, type DragStartEvent, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useSensor, useSensors, type CollisionDetection } from '@dnd-kit/core';
import { type Issue, type RangeConfig, type TemplateInfo, prettyPath, validateConfigText } from '@battleground/core';
import { Columns2, Eye, FileCode, LayoutGrid, Redo2, RotateCcw, Rocket, Save, Settings2, TriangleAlert, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OsGlyph } from '../components/OsGlyph';
import { Badge, Button, Segmented, Tabs, cx } from '../components/ui';
import { HttpError, type TemplateEntry, api } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../lib/store';
import { toast } from '../lib/toast';
import { NEW_LANE_DROP_ID, Topology } from '../topology/Topology';
import { buildTopologyModel } from '../topology/buildModel';
import type { Selection } from '../topology/model';
import { requestLogOpen } from '../view/logRequest';
import { moveVm, newVm, nextVlan, useDraft } from './draft';
import { DefaultsInspector, NetworkInspector, RouterInspector, VlanInspector, VmInspector } from './Inspector';
import { Palette } from './Palette';
import { YamlEditor } from './YamlEditor';

type Layout = 'visual' | 'split' | 'yaml';
type SideTab = 'inspector' | 'problems';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function DragPreview({ label, sub, os }: { label: string; sub: string; os: TemplateInfo['os'] }) {
  return (
    <div className="drag-preview">
      <OsGlyph os={os === 'other' ? undefined : os} />
      <div>
        <div className="vm__title">{label}</div>
        <div className="vm__sub">{sub}</div>
      </div>
    </div>
  );
}

export function BuildTab({ rangeId }: { rangeId: string }) {
  const detail = useApp((s) => (s.detailFor === rangeId ? s.detail : null));
  const meta = useApp((s) => s.meta);
  if (!detail || !meta) {
    return (
      <div className="splash">
        <span className="spinner" />
      </div>
    );
  }
  return <BuildEditor rangeId={rangeId} savedText={detail.config} />;
}

function BuildEditor({ rangeId, savedText }: { rangeId: string; savedText: string }) {
  const session = useApp((s) => s.session);
  const meta = useApp((s) => s.meta);
  const detail = useApp((s) => s.detail);
  const refresh = useApp((s) => s.refresh);
  const draft = useDraft(savedText);
  const [layout, setLayout] = useState<Layout>(() => (window.innerWidth < 900 ? 'visual' : 'split'));
  const [sideTab, setSideTab] = useState<SideTab>('inspector');
  const [selection, setSelection] = useState<Selection>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  const [saving, setSaving] = useState<'save' | 'deploy' | null>(null);
  const [dragLabel, setDragLabel] = useState<{ label: string; sub: string; os: TemplateInfo['os'] } | null>(null);
  const [focusOffset, setFocusOffset] = useState<{ at: number; nonce: number } | undefined>(undefined);
  const lastSaved = useRef(savedText);

  // When the server's copy changes and the draft has no edits of its own, follow it.
  useEffect(() => {
    if (savedText !== lastSaved.current) {
      if (draft.text === lastSaved.current) draft.reset(savedText, { keepHistory: true });
      lastSaved.current = savedText;
    }
  }, [savedText, draft]);

  const rangeNumber = detail?.range.rangeNumber ?? 1;
  const ctx = useMemo(
    () => ({
      rangeId,
      userId: session?.user.userID ?? rangeId,
      builtTemplates: new Set(meta?.templates.filter((t) => t.built).map((t) => t.name) ?? []),
      knownTemplates: new Set(meta?.templates.filter((t) => t.available).map((t) => t.name) ?? []),
      ansible: meta?.ansible ?? [],
      nodes: meta ? [meta.node] : undefined,
      entitlements: meta?.entitlements ?? [],
    }),
    [rangeId, session, meta],
  );
  const validation = useMemo(() => validateConfigText(draft.text, ctx), [draft.text, ctx]);
  const syntaxBroken = validation.parsed.problems.length > 0;
  // Half-typed text is often valid YAML that is no longer a range (`bludus:`), so the map keeps
  // the last version that had a machine list and the inspector waits until there is one again.
  const value = validation.parsed.value;
  const drawable = !syntaxBroken && isObject(value) && Array.isArray(value.ludus);
  const lastDrawable = useRef<RangeConfig | undefined>(undefined);
  if (drawable) lastDrawable.current = value as unknown as RangeConfig;
  const config = drawable ? (value as unknown as RangeConfig) : undefined;
  const shown = lastDrawable.current;

  const model = useMemo(
    () => buildTopologyModel({ config: shown, rangeId, rangeNumber, issues: validation.issues, vpnClientIp: `198.51.100.${session?.user.userNumber ?? 2}` }),
    [shown, rangeId, rangeNumber, validation.issues, session],
  );

  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');
  const dirty = draft.text !== savedText;

  const apply = useCallback(
    (mutate: (config: RangeConfig) => void) => {
      const ok = draft.apply(mutate);
      if (!ok) toast.warn('Fix the YAML first', 'The config has a syntax error, so it cannot be edited visually until that is fixed.');
      return ok;
    },
    [draft],
  );

  const addTemplate = useCallback(
    /** `auto` adds to the selected VLAN (or a new one); `new` always starts a new VLAN. */
    (template: TemplateEntry, where: number | 'auto' | 'new') => {
      let added = -1;
      apply((c) => {
        const selected = selection?.kind === 'vlan' ? selection.vlan : selection?.kind === 'vm' ? c.ludus[selection.index]?.vlan : undefined;
        const target = typeof where === 'number' ? where : where === 'auto' ? (selected ?? nextVlan(c)) : nextVlan(c);
        added = c.ludus.length;
        c.ludus.push(newVm(c, template, target));
      });
      if (added >= 0) {
        setSelection({ kind: 'vm', index: added });
        setShowDefaults(false);
        setSideTab('inspector');
        if (!template.built) toast.warn(`${template.label} is not built`, 'Build the template (Templates menu) before saving this config.');
      }
    },
    [apply, selection],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));

  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { type: string; template?: TemplateEntry; index?: number } | undefined;
    if (data?.type === 'template' && data.template) setDragLabel({ label: data.template.label, sub: data.template.name, os: data.template.os });
    else if (data?.type === 'vm' && data.index !== undefined && shown) {
      const vm = shown.ludus?.[data.index];
      if (vm) setDragLabel({ label: String(vm.hostname).replace(/\{\{\s*range_id\s*\}\}/g, rangeId), sub: vm.template, os: vm.windows ? 'windows' : vm.macos ? 'macos' : 'linux' });
    }
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragLabel(null);
    const data = event.active.data.current as { type: string; template?: TemplateEntry; index?: number } | undefined;
    const over = event.over;
    if (!data || !over) return;
    const target = over.data.current as { type: string; vlan?: number } | undefined;
    if (!target) return;
    if (data.type === 'template' && data.template) {
      if (target.type === 'lane' && target.vlan !== undefined) addTemplate(data.template, target.vlan);
      else if (over.id === NEW_LANE_DROP_ID) addTemplate(data.template, 'new');
    } else if (data.type === 'vm' && data.index !== undefined) {
      const index = data.index;
      if (target.type === 'lane' && target.vlan !== undefined) apply((c) => moveVm(c, index, target.vlan as number));
      else if (over.id === NEW_LANE_DROP_ID) apply((c) => moveVm(c, index, nextVlan(c)));
    }
  };

  const save = async (andDeploy: boolean) => {
    if (errors.length > 0) {
      setSideTab('problems');
      toast.err('The config has errors', 'Fix the problems listed under Problems before saving.');
      return;
    }
    setSaving(andDeploy ? 'deploy' : 'save');
    try {
      let result: string;
      try {
        result = (await api.setConfig(rangeId, draft.text)).result;
      } catch (err) {
        if (err instanceof HttpError && err.status === 409 && err.message.startsWith('Testing is enabled') && window.confirm(`${err.message}\n\nSave anyway?`)) {
          result = (await api.setConfig(rangeId, draft.text, true)).result;
        } else throw err;
      }
      lastSaved.current = draft.text;
      if (andDeploy) {
        await api.deploy(rangeId);
        toast.ok('Saved and deploying', 'Follow the deployment in the View tab.');
        requestLogOpen();
        navigate({ tab: 'view' });
      } else toast.ok(result);
      await refresh(rangeId);
    } catch (err) {
      toast.err(andDeploy ? 'Could not save and deploy' : 'Could not save', errorText(err));
    } finally {
      setSaving(null);
    }
  };

  // Keyboard shortcuts outside the YAML editor (which has its own undo).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const inEditor = (event.target as HTMLElement | null)?.closest('.cm-editor, input, textarea, select');
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save(false);
      } else if (!inEditor && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) draft.redo();
        else draft.undo();
      } else if (!inEditor && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        draft.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const focusIssue = (issue: Issue) => {
    const [root, index] = issue.path;
    if (root === 'ludus' && typeof index === 'number') setSelection({ kind: 'vm', index });
    else if (root === 'network') setSelection({ kind: 'network' });
    else if (root === 'router') setSelection({ kind: 'router' });
    if (root === 'defaults') setShowDefaults(true);
    else setShowDefaults(false);
    if (issue.range && layout !== 'visual') setFocusOffset({ at: issue.range.from, nonce: Date.now() });
    else setSideTab('inspector');
  };

  const inspector = (() => {
    if (!config) {
      return (
        <div className="empty">
          <TriangleAlert />
          <div className="empty__title">{syntaxBroken ? 'Fix the YAML to edit visually' : 'No machine list'}</div>
          <p className="text-sm">{syntaxBroken ? 'The Problems tab shows where the syntax error is.' : 'A range config needs a top-level ludus: list. Add one in the YAML, or drag a template onto the map.'}</p>
        </div>
      );
    }
    if (showDefaults) return <DefaultsInspector config={config} apply={apply} />;
    if (selection?.kind === 'vm') {
      return <VmInspector config={config} index={selection.index} apply={apply} issues={validation.issues} meta={meta} rangeId={rangeId} rangeNumber={rangeNumber} onSelect={setSelection} />;
    }
    if (selection?.kind === 'vlan') return <VlanInspector config={config} vlan={selection.vlan} apply={apply} rangeNumber={rangeNumber} onSelect={setSelection} />;
    if (selection?.kind === 'router') return <RouterInspector config={config} apply={apply} meta={meta} rangeId={rangeId} />;
    if (selection) return <NetworkInspector config={config} apply={apply} issues={validation.issues} />;
    return (
      <div className="inspector">
        <div className="empty" style={{ padding: '28px 12px' }}>
          <LayoutGrid />
          <div className="empty__title">Build by dragging</div>
          <p className="text-sm">Drag templates from the left onto a VLAN. Drag machines between VLANs to move them. Click anything to edit it here.</p>
        </div>
        <div className="stack stack--tight">
          <Button onClick={() => setSelection({ kind: 'network' })}>
            <TriangleAlert />
            Firewall rules ({config.network?.rules?.length ?? 0})
          </Button>
          <Button onClick={() => setShowDefaults(true)}>
            <Settings2 />
            Range settings
          </Button>
        </div>
      </div>
    );
  })();

  return (
    <div className="buildtab">
      <div className="buildbar">
        <div className="row buildbar__status">
          {dirty ? <Badge tone="accent">Unsaved changes</Badge> : <Badge tone="ok">Saved</Badge>}
          {errors.length > 0 ? (
            <button type="button" className="badge badge--err badge--btn" onClick={() => setSideTab('problems')}>
              {errors.length} error{errors.length === 1 ? '' : 's'}
            </button>
          ) : null}
          {warnings.length > 0 ? (
            <button type="button" className="badge badge--warn badge--btn" onClick={() => setSideTab('problems')}>
              {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </button>
          ) : null}
          {errors.length === 0 && !syntaxBroken ? <span className="faint text-xs buildbar__ok">Valid Ludus config</span> : null}
        </div>
        <Segmented<Layout>
          label="Editor layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: 'visual', label: <><LayoutGrid /> <span className="hide-sm">Visual</span></>, tip: 'Visual builder' },
            { value: 'split', label: <><Columns2 /> <span className="hide-sm">Split</span></>, tip: 'Visual and YAML side by side' },
            { value: 'yaml', label: <><FileCode /> <span className="hide-sm">YAML</span></>, tip: 'YAML only' },
          ]}
        />
        <div className="row buildbar__actions">
          <Button variant="ghost" icon tip="Undo" disabled={!draft.canUndo} onClick={draft.undo}>
            <Undo2 />
          </Button>
          <Button variant="ghost" icon tip="Redo" disabled={!draft.canRedo} onClick={draft.redo}>
            <Redo2 />
          </Button>
          <Button variant="ghost" icon tip="Discard changes" tipPos="left" disabled={!dirty} onClick={() => window.confirm('Discard all unsaved changes?') && draft.reset(savedText, { keepHistory: true })}>
            <RotateCcw />
          </Button>
          <Button busy={saving === 'save'} disabled={!dirty || syntaxBroken} onClick={() => save(false)}>
            <Save />
            Save
          </Button>
          <Button variant="primary" busy={saving === 'deploy'} disabled={syntaxBroken || detail?.deploying} onClick={() => save(true)}>
            <Rocket />
            <span className="hide-sm">Save &amp; deploy</span>
          </Button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragLabel(null)}>
        <div className={cx('buildtab__body', `buildtab__body--${layout}`)}>
          {layout !== 'yaml' ? (
            <Palette
              templates={meta?.templates ?? []}
              builtin={meta?.builtinBlueprints ?? []}
              blueprints={meta?.blueprints ?? []}
              onAdd={(t) => addTemplate(t, 'auto')}
              onLoadBlueprint={(text, name) => {
                if (dirty && !window.confirm(`Replace the current draft with “${name}”? You can undo this.`)) return;
                draft.reset(text, { keepHistory: true });
                setSelection(null);
                toast.info(`Loaded ${name}`, 'Review it, then Save.');
              }}
            />
          ) : null}
          <div className="buildtab__center">
            {layout !== 'yaml' ? (
              <div className="buildtab__canvas">
                <Topology
                  model={model}
                  mode="build"
                  selection={selection}
                  onSelect={(sel) => {
                    setSelection(sel);
                    setShowDefaults(false);
                    if (sel) setSideTab('inspector');
                  }}
                  onAddVlan={() => toast.info('Drag a template onto “New VLAN”', 'A VLAN exists as soon as a machine is placed on it.')}
                  legend={
                    <>
                      <span>
                        <span className="mono">{model.cidr}</span>
                      </span>
                      <span>
                        {model.lanes.reduce((n, l) => n + l.vms.length, 0)} VMs · {model.lanes.length} VLAN{model.lanes.length === 1 ? '' : 's'}
                      </span>
                    </>
                  }
                >
                  {!drawable && shown ? (
                    <div className="canvas__banner" data-nopan>
                      <TriangleAlert size={15} />
                      {syntaxBroken ? 'The YAML has a syntax error.' : 'The config has no ludus: list of machines.'} The map shows the last complete version until that is fixed.
                    </div>
                  ) : null}
                </Topology>
              </div>
            ) : null}
            {layout !== 'visual' ? (
              <div className="buildtab__yaml panel">
                <div className="panel__head">
                  <FileCode size={14} />
                  <span className="panel__title">range-config.yml</span>
                  <span className="grow" />
                  <span className="faint text-xs hide-sm">
                    Same file as <code>ludus range config get</code>
                  </span>
                </div>
                <YamlEditor value={draft.text} onChange={draft.setText} issues={validation.issues} focusOffset={focusOffset} />
              </div>
            ) : null}
          </div>
          <aside className="inspector-panel panel">
            <Tabs<SideTab>
              label="Inspector panels"
              active={sideTab}
              onChange={setSideTab}
              tabs={[
                { id: 'inspector', label: 'Inspector', icon: <Eye /> },
                { id: 'problems', label: 'Problems', icon: <TriangleAlert />, count: errors.length + warnings.length || undefined, countTone: errors.length > 0 ? 'err' : 'warn' },
              ]}
            />
            <div className="panel__body">
              {sideTab === 'inspector' ? (
                <div className="panel__pad">{inspector}</div>
              ) : (
                <ul className="problems">
                  {validation.issues.length === 0 ? <li className="empty">No problems. This config is ready to save.</li> : null}
                  {validation.issues.map((issue, i) => (
                    <li key={i}>
                      <button type="button" className={cx('problem', `problem--${issue.severity}`)} onClick={() => focusIssue(issue)}>
                        <span className="problem__where mono">
                          {prettyPath(issue.path)}
                          {issue.range ? ` · line ${issue.range.line}` : ''}
                        </span>
                        <span className="problem__msg">{issue.message}</span>
                        {issue.hint ? <span className="problem__hint">{issue.hint}</span> : null}
                        <span className="problem__src">
                          {issue.source === 'lint'
                            ? 'Advice'
                            : issue.source === 'deploy'
                              ? 'Would fail at deploy'
                              : issue.source === 'yaml'
                                ? 'YAML'
                                : 'Ludus would reject this'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
        <DragOverlay dropAnimation={null}>{dragLabel ? <DragPreview {...dragLabel} /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}
