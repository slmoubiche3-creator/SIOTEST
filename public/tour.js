// A small guided tour: highlights one element at a time and explains it in a
// popover. Steps can prepare the page first (open a view, a conversation...).
//   step = { title, text, target?, before?, ready?, skip? }
// `target` is a CSS selector (none = centred card). `before` runs when the step
// opens; `ready` says when the page is ready; `skip` hides the step when the
// data it needs does not exist.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(50);
  }
  return false;
}

const visible = (el) => el && el.getClientRects().length > 0;

export function createTour(allSteps, { onEnd } = {}) {
  let steps = [];
  let index = 0;
  let layer = null;
  let timer = null;
  let token = 0;

  function build() {
    const blocker = document.createElement('div');
    blocker.className = 'tour-blocker';
    const highlight = document.createElement('div');
    highlight.className = 'tour-highlight';
    const pop = document.createElement('div');
    pop.className = 'tour-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'tourTitle');
    pop.innerHTML = `
      <div class="tour-meta"><span class="tour-count"></span><button class="icon-btn tour-close" aria-label="Skip the tour">✕</button></div>
      <h2 id="tourTitle"></h2>
      <p class="tour-text"></p>
      <div class="tour-dots" aria-hidden="true"></div>
      <div class="tour-nav"><button class="btn tour-back">Back</button><button class="btn primary tour-next">Next</button></div>`;
    pop.querySelector('.tour-close').addEventListener('click', end);
    pop.querySelector('.tour-back').addEventListener('click', () => go(index - 1));
    pop.querySelector('.tour-next').addEventListener('click', () => (index === steps.length - 1 ? end() : go(index + 1)));
    document.body.append(blocker, highlight, pop);
    layer = { blocker, highlight, pop };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    timer = setInterval(place, 250); // the page re-renders live; keep the box on target
  }

  function onKey(e) {
    if (!layer) return;
    if (e.key === 'Escape') { e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight') go(Math.min(index + 1, steps.length - 1));
    else if (e.key === 'ArrowLeft') go(Math.max(index - 1, 0));
  }

  async function go(n) {
    if (!layer || n < 0 || n >= steps.length) return;
    const my = ++token;
    index = n;
    const step = steps[n];
    layer.pop.classList.add('loading');
    try { await step.before?.(); } catch { /* keep the tour going */ }
    await waitFor(() => (step.ready ? step.ready() : true) && (!step.target || visible(document.querySelector(step.target))));
    if (my !== token || !layer) return;
    const el = step.target ? document.querySelector(step.target) : null;
    if (visible(el)) el.scrollIntoView({ block: 'nearest' });
    const { pop } = layer;
    pop.querySelector('.tour-count').textContent = `Step ${n + 1} of ${steps.length}`;
    pop.querySelector('#tourTitle').textContent = step.title;
    pop.querySelector('.tour-text').textContent = typeof step.text === 'function' ? step.text() : step.text;
    pop.querySelector('.tour-dots').replaceChildren(...steps.map((_, i) => {
      const d = document.createElement('span');
      if (i === n) d.className = 'on';
      return d;
    }));
    pop.querySelector('.tour-back').disabled = n === 0;
    pop.querySelector('.tour-next').textContent = n === steps.length - 1 ? 'Finish' : 'Next';
    pop.classList.remove('loading');
    place();
    pop.querySelector('.tour-next').focus();
  }

  // Highlight the target and put the card where it fits: below, above, left,
  // right, or docked at the bottom (always on small screens).
  function place() {
    if (!layer) return;
    const { highlight, pop } = layer;
    const step = steps[index];
    const el = step?.target ? document.querySelector(step.target) : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const gap = 12;
    pop.classList.remove('docked');
    if (!visible(el)) {
      highlight.style.display = 'none';
      layer.blocker.classList.add('dim');
      pop.style.left = `${Math.max(16, (vw - pw) / 2)}px`;
      pop.style.top = `${Math.max(16, (vh - ph) / 2)}px`;
      return;
    }
    layer.blocker.classList.remove('dim');
    const r = el.getBoundingClientRect();
    const box = { top: Math.max(r.top, 4), left: Math.max(r.left, 4), bottom: Math.min(r.bottom, vh - 4), right: Math.min(r.right, vw - 4) };
    Object.assign(highlight.style, {
      display: 'block', top: `${box.top - 4}px`, left: `${box.left - 4}px`,
      width: `${box.right - box.left + 8}px`, height: `${Math.max(0, box.bottom - box.top) + 8}px`,
    });
    const clampX = (x) => Math.min(Math.max(16, x), vw - pw - 16);
    const clampY = (y) => Math.min(Math.max(16, y), vh - ph - 16);
    const options = vw < 600 ? [] : [
      [box.bottom + gap + ph < vh, clampX(box.left), box.bottom + gap],
      [box.top - gap - ph > 0, clampX(box.left), box.top - gap - ph],
      [box.left - gap - pw > 0, box.left - gap - pw, clampY(box.top)],
      [box.right + gap + pw < vw, box.right + gap, clampY(box.top)],
    ];
    const fit = options.find(([ok]) => ok);
    if (fit) {
      pop.style.left = `${fit[1]}px`;
      pop.style.top = `${fit[2]}px`;
    } else {
      pop.classList.add('docked');
      pop.style.left = `${Math.max(16, (vw - pw) / 2)}px`;
      pop.style.top = `${vh - ph - 16}px`;
    }
  }

  async function start() {
    if (layer) return;
    steps = [];
    for (const s of allSteps()) if (!(await s.skip?.())) steps.push(s);
    if (!steps.length) return;
    build();
    go(0);
  }

  function end() {
    if (!layer) return;
    token += 1;
    clearInterval(timer);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    Object.values(layer).forEach((el) => el.remove());
    layer = null;
    onEnd?.();
  }

  return { start, end, get active() { return Boolean(layer); } };
}
