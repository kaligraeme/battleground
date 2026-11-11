import { useDraggable } from '@dnd-kit/core';
import { BookOpen, GripVertical, Hammer, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { OsGlyph } from '../components/OsGlyph';
import { Badge, Segmented, cx } from '../components/ui';
import type { BlueprintEntry, TemplateEntry } from '../lib/api';
import type { BuiltinBlueprint } from '@battleground/core';

export const templateDragId = (name: string) => `template:${name}`;

function TemplateItem({ template, onAdd }: { template: TemplateEntry; onAdd: (template: TemplateEntry) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: templateDragId(template.name),
    data: { type: 'template', template },
  });
  return (
    <div
      ref={setNodeRef}
      className={cx('palette__item', isDragging && 'palette__item--dragging', !template.built && 'palette__item--unbuilt')}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      title={`${template.name}\nDrag onto a VLAN, or press Enter to add to the selected VLAN`}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onAdd(template);
      }}
      onDoubleClick={() => onAdd(template)}
      data-template={template.name}
    >
      <OsGlyph os={template.os === 'other' ? undefined : template.os} />
      <div className="grow">
        <div className="palette__name truncate">{template.label}</div>
        <div className="palette__sub truncate">
          {template.cpus} vCPU · {template.ramGb} GB
          {!template.built ? (template.available ? ' · not built' : ' · not on server') : ''}
        </div>
      </div>
      {!template.built ? <Hammer size={13} className="faint" aria-label="Not built" /> : null}
      <GripVertical size={14} className="palette__grip" aria-hidden />
    </div>
  );
}

const KIND_ORDER = ['server', 'workstation', 'attacker', 'analysis'] as const;
const KIND_LABEL: Record<string, string> = { server: 'Servers', workstation: 'Workstations', attacker: 'Attack', analysis: 'Analysis' };

export function Palette({
  templates,
  builtin,
  blueprints,
  onAdd,
  onLoadBlueprint,
}: {
  templates: TemplateEntry[];
  builtin: readonly BuiltinBlueprint[];
  blueprints: BlueprintEntry[];
  onAdd: (template: TemplateEntry) => void;
  onLoadBlueprint: (config: string, name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'templates' | 'blueprints'>('templates');
  const [showAll, setShowAll] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = templates.filter((t) => (showAll || t.available) && (!q || t.name.includes(q) || t.label.toLowerCase().includes(q)));
    return KIND_ORDER.map((kind) => ({ kind, items: list.filter((t) => t.kind === kind) })).filter((g) => g.items.length > 0);
  }, [templates, query, showAll]);

  return (
    <aside className="palette panel" aria-label="Templates">
      <div className="panel__head">
        <Segmented
          label="Palette"
          value={view}
          onChange={setView}
          options={[
            { value: 'templates', label: 'Templates' },
            { value: 'blueprints', label: <><BookOpen /> Blueprints</> },
          ]}
        />
      </div>
      {view === 'templates' ? (
        <>
          <div className="palette__search">
            <div className="input-affix">
              <Search />
              <input className="input input--sm" placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search templates" />
            </div>
          </div>
          <div className="panel__body palette__list">
            {groups.map((group) => (
              <div key={group.kind} className="palette__group">
                <div className="palette__group-title">{KIND_LABEL[group.kind]}</div>
                {group.items.map((t) => (
                  <TemplateItem key={t.name} template={t} onAdd={onAdd} />
                ))}
              </div>
            ))}
            {groups.length === 0 ? <p className="faint text-sm panel__pad">No templates match.</p> : null}
            <label className="palette__toggle text-xs muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show add-on templates this server does not have
            </label>
          </div>
          <div className="palette__hint text-xs faint">Drag a template onto a VLAN, or onto “New VLAN” to create one.</div>
        </>
      ) : (
        <div className="panel__body palette__list">
          <div className="palette__group">
            <div className="palette__group-title">Starting points</div>
            {builtin.map((b) => (
              <button key={b.id} type="button" className="blueprint" onClick={() => onLoadBlueprint(b.config, b.name)}>
                <span className="blueprint__name">{b.name}</span>
                <span className="blueprint__desc">{b.description}</span>
                <span className="row row--wrap">
                  {b.tags.map((tag) => (
                    <Badge key={tag} plain>
                      {tag}
                    </Badge>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {blueprints.length > 0 ? (
            <div className="palette__group">
              <div className="palette__group-title">Saved blueprints</div>
              {blueprints.map((b) => (
                <button key={b.blueprintID} type="button" className="blueprint" onClick={() => onLoadBlueprint(b.config, b.name)}>
                  <span className="blueprint__name">{b.name}</span>
                  <span className="blueprint__desc mono">{b.blueprintID}</span>
                </button>
              ))}
            </div>
          ) : null}
          <p className="faint text-xs panel__pad">Loading a blueprint replaces the draft. You can undo it, and nothing is saved until you click Save.</p>
        </div>
      )}
    </aside>
  );
}
