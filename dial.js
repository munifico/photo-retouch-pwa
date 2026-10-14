// 아이폰 보정 화면 같은 가로 스크롤 다이얼. 네이티브 스크롤(관성 포함)을 쓰고 scrollLeft ↔ 값으로 변환한다.
const TICK = 7; // 1단위당 px

export function createDial(container, { min = -100, max = 100, onInput }) {
  container.classList.add('dial');
  container.innerHTML = `
    <div class="dial-value" aria-live="polite">0</div>
    <div class="dial-scroller"><div class="dial-ticks"></div></div>
    <div class="dial-needle"></div>`;
  const scroller = container.querySelector('.dial-scroller');
  const ticks = container.querySelector('.dial-ticks');
  const label = container.querySelector('.dial-value');
  ticks.style.width = `${(max - min) * TICK}px`;
  ticks.style.setProperty('--tick', `${TICK}px`);
  ticks.style.setProperty('--zero', `${-min * TICK}px`);

  let value = 0;
  let snapTimer = 0;

  const show = (v) => {
    label.textContent = v > 0 ? `+${v}` : `${v}`;
    container.classList.toggle('nz', v !== 0);
  };
  const toScroll = (v) => (v - min) * TICK;
  const fromScroll = () => Math.max(min, Math.min(max, Math.round(scroller.scrollLeft / TICK) + min));

  const layout = () => {
    const pad = scroller.clientWidth / 2;
    ticks.style.margin = `0 ${pad}px`;
    scroller.scrollLeft = toScroll(value);
  };
  new ResizeObserver(layout).observe(scroller);

  scroller.addEventListener('scroll', () => {
    const v = fromScroll();
    if (v !== value) {
      value = v;
      show(v);
      onInput?.(v);
    }
    // 스크롤이 멈추면 눈금에 맞춘다
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      const target = toScroll(value);
      if (Math.abs(scroller.scrollLeft - target) > 0.5) scroller.scrollTo({ left: target, behavior: 'smooth' });
    }, 140);
  }, { passive: true });

  function set(v, emit = false) {
    value = Math.max(min, Math.min(max, Math.round(v)));
    show(value);
    scroller.scrollLeft = toScroll(value);
    if (emit) onInput?.(value);
  }

  return { set, get: () => value };
}
