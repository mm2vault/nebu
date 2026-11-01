/* Nebu animated backgrounds. NebuBG.mount(el, {type, color1, color2}) -> {update(opts), destroy()} */
(function () {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function rgba(h, a) { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

  function mount(el, opts) {
    el.classList.add('nebu-bg');
    el.innerHTML = '';
    let o = Object.assign({ type: 'aurora', color1: '#7c5cff', color2: '#19d3c5' }, opts);
    let raf = 0, cleanup = () => {};

    function build() {
      cancelAnimationFrame(raf); cleanup(); el.innerHTML = '';
      el.style.background = '#08070d';
      const t = o.type, c1 = o.color1, c2 = o.color2;
      if (t === 'solid') { el.style.background = `radial-gradient(120% 90% at 50% 0%, ${rgba(c1, .35)}, #08070d 70%)`; return; }
      if (t === 'gradient') {
        el.style.background = `linear-gradient(125deg, ${c1}, #08070d 45%, ${c2})`;
        el.style.backgroundSize = '300% 300%';
        el.style.animation = reduce ? 'none' : 'nebuShift 14s ease-in-out infinite';
        return;
      }
      if (t === 'aurora') {
        for (let i = 0; i < 3; i++) {
          const b = document.createElement('div');
          b.className = 'nebu-blob';
          const col = i === 1 ? c2 : c1;
          b.style.cssText = `background:radial-gradient(circle, ${rgba(col, .75)}, transparent 65%);` +
            `width:${60 + i * 12}vmax;height:${60 + i * 12}vmax;left:${[-15, 40, 10][i]}%;top:${[-20, 10, 45][i]}%;` +
            `animation:nebuFloat${i} ${18 + i * 5}s ease-in-out infinite alternate;${reduce ? 'animation:none;' : ''}`;
          el.appendChild(b);
        }
        return;
      }
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      const ctx = cv.getContext('2d');
      let w = 0, h = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
      const resize = () => {
        w = el.clientWidth || window.innerWidth; h = el.clientHeight || window.innerHeight;
        cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      resize();
      const ro = new ResizeObserver(resize); ro.observe(el);
      cleanup = () => ro.disconnect();
      let tm = 0;
      if (t === 'particles' || t === 'stars') {
        const n = t === 'stars' ? 140 : 70;
        const P = Array.from({ length: n }, () => ({
          x: Math.random(), y: Math.random(), r: Math.random() * 1.6 + .4,
          vx: (Math.random() - .5) * (t === 'stars' ? .00003 : .00018), vy: (Math.random() - .5) * (t === 'stars' ? .00003 : .00018),
          ph: Math.random() * 6.28, col: Math.random() > .5 ? c1 : c2
        }));
        const draw = () => {
          tm += 1;
          ctx.clearRect(0, 0, w, h);
          const g = ctx.createRadialGradient(w / 2, h * .3, 0, w / 2, h * .3, Math.max(w, h) * .8);
          g.addColorStop(0, rgba(c1, .18)); g.addColorStop(1, 'rgba(8,7,13,0)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
          P.forEach((p) => {
            if (!reduce) { p.x = (p.x + p.vx * 16 + 1) % 1; p.y = (p.y + p.vy * 16 + 1) % 1; }
            const a = t === 'stars' ? .35 + .65 * Math.abs(Math.sin(tm / 40 + p.ph)) : .8;
            ctx.beginPath(); ctx.arc(p.x * w, p.y * h, p.r, 0, 6.283);
            ctx.fillStyle = t === 'stars' ? `rgba(255,255,255,${a})` : rgba(p.col, a); ctx.fill();
          });
          if (t === 'particles') {
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
              const dx = (P[i].x - P[j].x) * w, dy = (P[i].y - P[j].y) * h, d = Math.hypot(dx, dy);
              if (d < 120) { ctx.strokeStyle = rgba(c1, (1 - d / 120) * .35); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(P[i].x * w, P[i].y * h); ctx.lineTo(P[j].x * w, P[j].y * h); ctx.stroke(); }
            }
          }
          raf = requestAnimationFrame(draw);
        };
        draw();
      } else if (t === 'waves') {
        const draw = () => {
          tm += reduce ? 0 : .012;
          ctx.clearRect(0, 0, w, h);
          for (let k = 0; k < 4; k++) {
            ctx.beginPath(); ctx.moveTo(0, h);
            for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h * (.55 + k * .1) + Math.sin(x / (110 + k * 40) + tm * (1 + k * .3) + k) * (26 + k * 8));
            ctx.lineTo(w, h); ctx.closePath();
            ctx.fillStyle = rgba(k % 2 ? c2 : c1, .18 + k * .05); ctx.fill();
          }
          raf = requestAnimationFrame(draw);
        };
        draw();
      } else if (t === 'grid') {
        const draw = () => {
          tm += reduce ? 0 : .6;
          ctx.clearRect(0, 0, w, h);
          const hz = h * .42;
          const g = ctx.createLinearGradient(0, 0, 0, hz); g.addColorStop(0, '#08070d'); g.addColorStop(1, rgba(c1, .35));
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, hz);
          ctx.strokeStyle = rgba(c2, .55); ctx.lineWidth = 1;
          for (let i = -20; i <= 20; i++) { ctx.beginPath(); ctx.moveTo(w / 2 + i * 14, hz); ctx.lineTo(w / 2 + i * w * .16, h); ctx.stroke(); }
          for (let i = 0; i < 16; i++) {
            const f = ((i + (tm % 40) / 40) / 16) ** 2.2;
            const y = hz + f * (h - hz); ctx.globalAlpha = .15 + f * .85;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
          }
          ctx.globalAlpha = 1;
          raf = requestAnimationFrame(draw);
        };
        draw();
      }
    }
    build();
    return {
      update(n) { const typeChanged = n.type && n.type !== o.type; const colorChanged = (n.color1 && n.color1 !== o.color1) || (n.color2 && n.color2 !== o.color2); o = Object.assign(o, n); if (typeChanged || colorChanged) build(); },
      destroy() { cancelAnimationFrame(raf); cleanup(); el.innerHTML = ''; }
    };
  }
  window.NebuBG = { mount };

  if (!document.getElementById('nebu-bg-css')) {
    const s = document.createElement('style'); s.id = 'nebu-bg-css';
    s.textContent = `.nebu-bg{position:absolute;inset:0;overflow:hidden;z-index:0}.nebu-bg canvas{position:absolute;inset:0}
.nebu-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.8;will-change:transform}
@keyframes nebuShift{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
@keyframes nebuFloat0{to{transform:translate(18vw,14vh) scale(1.15)}}
@keyframes nebuFloat1{to{transform:translate(-20vw,16vh) scale(.9)}}
@keyframes nebuFloat2{to{transform:translate(14vw,-18vh) scale(1.2)}}`;
    document.head.appendChild(s);
  }
})();
