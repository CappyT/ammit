// Ammit on-page widget — a small, unobtrusive crocodile badge near the player
// with a verdict-colored ring; click opens a compact panel to block/whitelist
// the current artist without opening the popup. Shared by both content scripts
// (isolated world), which own the data and pass state via ammitWidget.update().
var ammitWidget = (() => {
  const COLORS = {
    blocklist: '#e5484d', ai: '#e5484d', unsure: '#f5a524',
    human: '#30a46c', whitelisted: '#30a46c', pending: '#8f8f8f', disabled: '#555',
  };
  const CROC = `
    <svg viewBox="0 0 128 128" width="18" height="18" aria-hidden="true">
      <g fill="#d4a017">
        <path d="M14 48Q14 31 32 29L46 28Q56 27 61 33L114 40Q120 42 118 47L64 51L25 53Q15 53 14 48Z"/>
        <path d="M38 53l4.5 10 4.5-10Z"/><path d="M56 52l4.5 10 4.5-10Z"/>
        <path d="M74 50.5l4.5 10 4.5-10Z"/><path d="M92 49l4.5 10 4.5-10Z"/><path d="M106 48l4 9 4-9Z"/>
        <path d="M28 64Q26 60 32 61L104 79Q110 81 106 87L46 99Q38 100 36 93Z"/>
        <path d="M46 66.5l4 -11 5 8.5Z"/><path d="M64 71l4 -11 5 8.5Z"/>
        <path d="M82 75.5l4 -11 5 8.5Z"/><path d="M97 79l3.5 -10 4.5 8Z"/>
      </g>
      <circle cx="34" cy="40" r="5" fill="#131313"/><circle cx="34" cy="40" r="2.2" fill="#d4a017"/>
    </svg>`;
  const msg = (k, subs) => chrome.i18n.getMessage(k, subs) || k;

  let root, btn, panel, nameEl, chipEl, blockBtn, notAiBtn;
  let handlers = {};
  let state = { artist: null, verdict: 'pending', score: null };

  function el(tag, css, parent) {
    const e = document.createElement(tag);
    Object.assign(e.style, css);
    if (parent) parent.appendChild(e);
    return e;
  }

  function build(bottom) {
    // A previous extension life (reload/update) may have left its widget in the
    // DOM with dead listeners — replace it, don't stack a second badge.
    document.getElementById('ammit-widget')?.remove();
    root = el('div', { position: 'fixed', right: '16px', bottom, zIndex: 99998, display: 'none', fontFamily: 'system-ui, sans-serif' });
    root.id = 'ammit-widget';

    panel = el('div', {
      position: 'absolute', right: '0', bottom: '42px', width: '224px', display: 'none',
      background: '#1b1b1e', color: '#ececf0', borderRadius: '12px', padding: '10px 12px',
      boxShadow: '0 8px 28px rgba(0,0,0,.55)', border: '1px solid #2c2c30', fontSize: '13px',
    }, root);
    const head = el('div', { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }, panel);
    nameEl = el('div', { fontWeight: '600', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, head);
    chipEl = el('span', { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', whiteSpace: 'nowrap' }, head);
    const row = el('div', { display: 'flex', gap: '6px' }, panel);
    const mkBtn = (label, color) => {
      const b = el('button', {
        flex: '1', background: '#232327', color: '#ececf0', border: `1px solid ${color}`,
        borderRadius: '8px', padding: '5px 8px', cursor: 'pointer', fontSize: '12px',
      }, row);
      b.textContent = label;
      return b;
    };
    blockBtn = mkBtn(msg('blockArtist'), '#e5484d');
    notAiBtn = mkBtn(msg('notAi'), '#30a46c');
    blockBtn.addEventListener('click', () => { handlers.onBlock?.(); hidePanel(); });
    notAiBtn.addEventListener('click', () => { handlers.onNotAi?.(); hidePanel(); });

    btn = el('button', {
      width: '34px', height: '34px', borderRadius: '50%', cursor: 'pointer',
      background: 'rgba(19,19,19,.92)', border: '2px solid #8f8f8f',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: '.6', transition: 'opacity .15s', padding: '0',
    }, root);
    btn.id = 'ammit-badge';
    btn.innerHTML = CROC;
    btn.title = 'Ammit';
    btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
    btn.addEventListener('mouseleave', () => { if (panel.style.display === 'none') btn.style.opacity = '.6'; });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Context invalidated (extension reloaded/updated under us): every
      // chrome.* call throws, nothing can work — remove the corpse instead of
      // presenting a badge that silently swallows clicks.
      if (!chrome.runtime?.id) { root.remove(); return; }
      panel.style.display === 'none' ? showPanel() : hidePanel();
    });
    document.addEventListener('click', (e) => { if (!root.contains(e.target)) hidePanel(); });
    document.documentElement.appendChild(root);
  }

  function showPanel() { render(); panel.style.display = 'block'; btn.style.opacity = '1'; }
  function hidePanel() { panel.style.display = 'none'; btn.style.opacity = '.6'; }

  function render() {
    const color = COLORS[state.verdict] ?? COLORS.pending;
    btn.style.borderColor = color;
    nameEl.textContent = state.artist ?? '';
    nameEl.title = state.artist ?? '';
    chipEl.textContent = msg('verdict_' + state.verdict) + (state.score != null ? ` · ${state.score}` : '');
    chipEl.style.background = color + '26'; // 15% alpha
    chipEl.style.color = color;
    // Nothing to act on for tracks we already blocked/whitelisted or can't identify.
    const actionable = !!state.artist && ['ai', 'unsure', 'human', 'pending'].includes(state.verdict);
    blockBtn.disabled = notAiBtn.disabled = !actionable;
    blockBtn.style.opacity = notAiBtn.style.opacity = actionable ? '1' : '.4';
  }

  // ammitWidget.init({ bottom: '84px', onBlock, onNotAi })
  function init(opts) {
    handlers = opts;
    if (!root) build(opts.bottom ?? '84px');
  }

  // ammitWidget.update({ artist, verdict, score }) — hides itself with no artist.
  function update(s) {
    if (!root) return;
    state = { ...state, ...s };
    root.style.display = state.artist ? 'block' : 'none';
    render();
  }

  return { init, update };
})();
