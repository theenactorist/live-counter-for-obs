import '../styles/fonts.css';
import './overlay.css';

/**
 * Task 2.1 stub: renders the empty overlay root over a transparent body.
 * No counter rendering or WebSocket wiring yet — that lands in Task 2.7.
 */
function renderOverlayRoot(): void {
  const root = document.getElementById('app');
  if (!root) return;

  const overlayRoot = document.createElement('div');
  overlayRoot.dataset.testid = 'overlay-root';

  root.appendChild(overlayRoot);
}

renderOverlayRoot();
