import '../styles/fonts.css';

/**
 * Task 2.1 stub: renders the dock shell with a disconnected-state banner.
 * No OBS WebSocket wiring yet — that lands in Task 2.2+ (ObsWsClient).
 */
function renderAppShell(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const shell = document.createElement('div');
  shell.dataset.testid = 'app-shell';

  const banner = document.createElement('div');
  banner.dataset.testid = 'banner-ws';
  banner.textContent = 'Not connected to OBS — open Settings';

  shell.appendChild(banner);
  root.appendChild(shell);
}

renderAppShell();
