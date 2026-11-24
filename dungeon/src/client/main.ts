/** Lumenfall browser client: title screen, lobby, and dungeon runs. */
import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './styles.css';
import { toast } from './dom.js';
import { Game } from './game/game.js';
import { Net } from './net.js';
import { createBackdrop } from './ui/common.js';
import { LobbyView } from './ui/lobby.js';
import { titleScreen } from './ui/title.js';

const app = document.getElementById('app') as HTMLElement;
const net = new Net();
const backdrop = createBackdrop();
let lobby: LobbyView | null = null;
let game: Game | null = null;
let online = false;

function showTitle(): void {
  app.replaceChildren(backdrop.el, titleScreen((name) => net.connect(name)));
}

function showLobby(): void {
  if (!lobby) lobby = new LobbyView(net);
  lobby.setStatus(online);
  app.replaceChildren(backdrop.el, lobby.el);
}

net.onStatus((s) => {
  online = s === 'online';
  lobby?.setStatus(online);
});

net.onMessage((msg) => {
  switch (msg.t) {
    case 'welcome':
      // After a reconnect the server re-sends the dungeon if it is still running, so any game
      // on screen now may be stale (for example after a server restart).
      game?.destroy();
      game = null;
      showLobby();
      break;
    case 'lobby':
      lobby?.update(msg.state);
      break;
    case 'error':
      toast(msg.message, 'error');
      break;
    case 'chat':
      if (game) game.onMessage(msg);
      else lobby?.addChat(msg.from, msg.text);
      break;
    case 'instance.start':
      game?.destroy();
      game = new Game(net, msg.start);
      app.replaceChildren(game.el);
      break;
    case 'instance.end':
      game?.destroy();
      game = null;
      showLobby();
      break;
    case 'snap':
    case 'skillFail':
      game?.onMessage(msg);
      break;
    default:
      break;
  }
});

// A read-only handle for browser tests and curious players poking at the console.
(window as unknown as { lumenfall: unknown }).lumenfall = {
  get game() {
    return game;
  },
};

showTitle();
