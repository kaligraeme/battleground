import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { Issue } from '@battleground/core';
import { useEffect, useRef } from 'react';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--bg-0)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-1)', color: 'var(--text-3)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg-3) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-3)', color: 'var(--text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-foldGutter span': { color: 'var(--text-3)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-2)', border: '1px solid var(--line-strong)', color: 'var(--text)', borderRadius: '6px' },
  '.cm-diagnostic': { padding: '6px 10px', whiteSpace: 'pre-wrap', maxWidth: '520px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--err)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn)' },
  '.cm-diagnostic-info': { borderLeft: '3px solid var(--accent)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--err)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  '.cm-lintRange-info': { backgroundImage: 'none', textDecoration: 'underline dotted var(--accent)', textUnderlineOffset: '3px' },
  '.cm-panels': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--accent-hi)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--drop)' },
  { tag: tags.comment, color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.meta, tags.labelName], color: 'var(--testing)' },
  { tag: tags.punctuation, color: 'var(--text-3)' },
]);

function diagnosticsFor(issues: readonly Issue[], length: number): Diagnostic[] {
  return issues
    .filter((issue) => issue.range)
    .map((issue) => {
      const from = Math.min(issue.range?.from ?? 0, length);
      const to = Math.max(from, Math.min(issue.range?.to ?? from, length));
      return {
        from,
        to,
        severity: issue.severity,
        message: issue.hint ? `${issue.message}\n\n${issue.hint}` : issue.message,
        source: issue.source === 'lint' || issue.source === 'deploy' ? 'Battleground' : 'Ludus',
      };
    });
}

/** The YAML source of the draft. Edits flow both ways with the visual builder. */
export function YamlEditor({ value, onChange, issues, focusOffset }: { value: string; onChange: (text: string) => void; issues: readonly Issue[]; focusOffset?: { at: number; nonce: number } }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          lintGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          EditorState.tabSize.of(2),
          yaml(),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': 'Range config YAML' }),
          EditorView.updateListener.of((update) => {
            // Changes that came in from outside are not echoed back.
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(Transaction.remote))) {
              changeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; later values arrive through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    // Replace only the part that differs, so the cursor and scroll position survive.
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) start++;
    let endOld = current.length;
    let endNew = value.length;
    while (endOld > start && endNew > start && current[endOld - 1] === value[endNew - 1]) {
      endOld--;
      endNew--;
    }
    editor.dispatch({
      changes: { from: start, to: endOld, insert: value.slice(start, endNew) },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, diagnosticsFor(issues, editor.state.doc.length)));
  }, [issues, value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || !focusOffset) return;
    const at = Math.min(focusOffset.at, editor.state.doc.length);
    editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    editor.focus();
  }, [focusOffset]);

  return <div ref={host} className="yaml-editor" />;
}
