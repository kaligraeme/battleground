/** The title screen: pick a name and enter. */
import { h } from '../dom.js';
import { savedName } from '../net.js';

export function titleScreen(onEnter: (name: string) => void): HTMLElement {
  const input = h('input', { class: 'input', placeholder: 'Your hero’s name', maxlength: '16', value: savedName(), autofocus: true, 'aria-label': 'Hero name' });
  const go = (): void => {
    const name = input.value.trim();
    if (name.length < 2) {
      input.focus();
      input.classList.add('shake');
      return;
    }
    onEnter(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  const el = h(
    'div',
    { class: 'title-screen' },
    h(
      'div',
      { class: 'title-card' },
      h('h1', { class: 'logo' }, 'LUMENFALL'),
      h('div', { class: 'logo-rule' }),
      h('div', { class: 'tagline' }, 'Four heroes · Endless depths'),
      h('div', { class: 'title-form' }, input, h('button', { class: 'btn primary', onclick: go }, 'Enter')),
      h('p', { class: 'title-hint' }, 'Form a party of four — Tank, Mage, Ranger and Melee — and descend into a dungeon that is never the same twice. Empty roles are filled by AI companions.'),
    ),
  );
  setTimeout(() => input.focus(), 50);
  return el;
}
