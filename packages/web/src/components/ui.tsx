import { Check, Copy, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'testing';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: boolean;
  block?: boolean;
  busy?: boolean;
  tip?: string;
  tipPos?: 'left' | 'right' | 'top';
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  busy,
  tip,
  tipPos,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(
        'btn',
        variant !== 'default' && `btn--${variant}`,
        size === 'sm' && 'btn--sm',
        icon && 'btn--icon',
        block && 'btn--block',
        className,
      )}
      disabled={disabled || busy}
      data-tip={tip}
      data-tip-pos={tipPos}
      aria-label={icon && tip ? tip : rest['aria-label']}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Field wrappers
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  row,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  row?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  if (row) {
    return (
      <div className={cx('field', className)}>
        <div className="field field--row">
          <label className="field__label" htmlFor={htmlFor}>
            {label}
          </label>
          {children}
        </div>
        {hint ? <div className="field__hint">{hint}</div> : null}
        {error ? <div className="field__error">{error}</div> : null}
      </div>
    );
  }
  return (
    <div className={cx('field', className)}>
      {label ? (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? <div className="field__error">{error}</div> : hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  tip?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="segmented__item"
          aria-pressed={opt.value === value}
          title={opt.tip}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'drop' | 'accent' | 'testing';

export function Badge({
  tone = 'neutral',
  plain,
  children,
  title,
  className,
}: {
  tone?: Tone;
  plain?: boolean;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={cx('badge', tone !== 'neutral' && `badge--${tone}`, plain && 'badge--plain', className)}
      title={title}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------

/** Closes on outside pointer-down and Escape. */
export function useDismiss(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, ref]);
}

export function Dropdown({
  trigger,
  children,
  align = 'left',
  up,
  menuClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);
  return (
    <div className="pop-anchor" ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open ? (
        <div className={cx('menu', align === 'right' && 'menu--right', up && 'menu--up', menuClassName)} role="menu">
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  danger,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx('menu__item', danger && 'menu__item--danger')}
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span className="grow">
        {children}
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dialog (native <dialog>, so focus trapping and Esc come for free)
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  flush,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  size?: 'md' | 'wide' | 'xl';
  flush?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={cx('dialog', size === 'wide' && 'dialog--wide', size === 'xl' && 'dialog--xl')}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog__head">
        <div className="grow">
          <div className="dialog__title" id={titleId}>
            {title}
          </div>
          {subtitle ? <div className="dialog__sub">{subtitle}</div> : null}
        </div>
        <Button variant="ghost" icon tip="Close" tipPos="left" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className={cx('dialog__body', flush && 'dialog__body--flush')}>{children}</div>
      {footer ? <div className="dialog__foot">{footer}</div> : null}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
  countTone?: 'err' | 'warn';
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  trailing,
}: {
  tabs: ReadonlyArray<TabDef<T>>;
  active: T;
  onChange: (id: T) => void;
  label?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.id === active}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon}
          {tab.label}
          {tab.count ? (
            <span className={cx('tab__count', tab.countTone && `tab__count--${tab.countTone}`)}>{tab.count}</span>
          ) : null}
        </button>
      ))}
      {trailing ? (
        <>
          <span className="grow" />
          <div className="row">{trailing}</div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy to clipboard
// ---------------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API is unavailable on insecure origins; fall back to a hidden textarea.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm',
  variant = 'default',
  iconOnly,
}: {
  text: string | (() => string);
  label?: string;
  size?: 'md' | 'sm';
  variant?: ButtonVariant;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      size={size}
      variant={variant}
      icon={iconOnly}
      tip={iconOnly ? label : undefined}
      onClick={async () => {
        const ok = await copyText(typeof text === 'function' ? text() : text);
        if (ok) {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
      {iconOnly ? null : copied ? 'Copied' : label}
    </Button>
  );
}

/** Triggers a browser download of in-memory content. */
export function downloadBlob(filename: string, content: BlobPart, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
