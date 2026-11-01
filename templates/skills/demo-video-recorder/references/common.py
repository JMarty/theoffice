import os, glob, json, time, subprocess
OVERLAY_JS = r"""
(() => { const init = () => { if (window.__ov) return; window.__ov = 1;
  const st = document.createElement('style'); st.textContent = `
   #dcap{position:fixed;left:6%;right:6%;bottom:40px;z-index:0;padding:16px 28px;border-radius:12px;background:rgba(20,20,22,.80);color:#fff;font:600 30px/1.35 Arial,sans-serif;text-align:center;opacity:0;transition:opacity .4s;pointer-events:none}
   #dcap.on{opacity:1}
   #dcur{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #ff7a1a;background:rgba(255,122,26,.20);box-shadow:0 0 12px rgba(255,122,26,.6);z-index:0;pointer-events:none;left:-60px;top:-60px;transition:transform .12s}
   #dcur.down{transform:scale(.65);background:rgba(255,122,26,.6)}
   .dpulse{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:3px solid #ff7a1a;z-index:0;pointer-events:none;animation:dp .6s ease-out forwards}
   @keyframes dp{to{transform:scale(3.2);opacity:0}}
   input:focus,textarea:focus,select:focus{outline:3px solid #ff7a1a !important;box-shadow:0 0 0 6px rgba(255,122,26,.25) !important}`;
  document.documentElement.appendChild(st);
  const c = document.createElement('div'); c.id = 'dcap'; document.documentElement.appendChild(c);
  const u = document.createElement('div'); u.id = 'dcur'; document.documentElement.appendChild(u); setInterval(() => { const d = document.querySelector('dialog[open]'); const h = d || document.documentElement; if (u.parentNode !== h) h.appendChild(u); }, 100);
  document.addEventListener('mousemove', e => { u.style.left = e.clientX + 'px'; u.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', e => { u.classList.add('down'); const p = document.createElement('div'); p.className = 'dpulse'; p.style.left = e.clientX + 'px'; p.style.top = e.clientY + 'px'; document.documentElement.appendChild(p); setTimeout(() => p.remove(), 700); }, true);
  document.addEventListener('mouseup', () => u.classList.remove('down'), true);
  window.__cap = t => { let e = document.getElementById('dcap'); if (!e) { e = document.createElement('div'); e.id = 'dcap'; } const d = document.querySelector('dialog[open]'); const host = d || document.documentElement; if (e.parentNode !== host) host.appendChild(e); if (!t) { e.classList.remove('on'); return; } e.textContent = t; e.classList.add('on'); };
  // keep earlier test inquiries out of the picture (DOM only)
  setInterval(() => { document.querySelectorAll('a,tr,li,.card').forEach(e => { if (e.children.length < 8 && /ZZZNEVERMATCH/.test(e.textContent || '') && !/Teszt –/.test(e.textContent||'')) e.style.display = 'none'; }); }, 150);
 }; if (document.documentElement) init(); else document.addEventListener('DOMContentLoaded', init); })();
"""

T0 = time.time()
def log(*a): print(f"[{time.time()-T0:6.1f}s]", *a, flush=True)

class Seg:
    """one recorded segment = one browser context with video"""
    def __init__(self, br, state, n):
        self.ctx = br.new_context(viewport={"width": W, "height": H}, storage_state=state, record_video_dir=RAW,
                                  record_video_size={"width": W, "height": H}, accept_downloads=True)
        self.ctx.add_init_script(OVERLAY_JS); self.pg = self.ctx.new_page(); self.n = n
        self.pg.on("pageerror", lambda e: log("JS ERROR", e))
        self.pg.on("dialog", lambda d: d.accept())
    def close(self):
        v = self.pg.video; self.ctx.close(); p = v.path(); dst = os.path.join(RAW, f"seg{self.n:02d}.webm"); os.replace(p, dst); log("segment", dst)
    # helpers
    def cap(self, k, hold=0):
        self.pg.evaluate("t => window.__cap && window.__cap(t)", CAP.get(k) if k else "")
        if hold: self.pg.wait_for_timeout(int(hold * 1000))
    def wait(self, s): self.pg.wait_for_timeout(int(s * 1000))
    def box(self, sel, nth=0):
        loc = self.pg.locator(sel).nth(nth); loc.scroll_into_view_if_needed(); self.wait(0.4); b = loc.bounding_box()
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    def hover(self, sel, nth=0, pause=0.5):
        x, y = self.box(sel, nth); self.pg.mouse.move(x, y, steps=25); self.wait(pause); return x, y
    def click(self, sel, nth=0, pause=1.5):
        self.hover(sel, nth, pause=0.35)
        x, y = self.box(sel, nth)          # re-measure: late layout shifts (map tiles) move targets
        self.pg.mouse.move(x, y, steps=6); self.pg.mouse.down(); self.wait(0.09); self.pg.mouse.up(); self.wait(pause)
    def type(self, sel, text, nth=0, delay=55, pause=0.4):
        self.click(sel, nth, pause=0.2); self.pg.keyboard.type(text, delay=delay); self.wait(pause)
    def select(self, sel, label, pause=0.6):
        self.click(sel, pause=0.3); self.pg.select_option(sel, label=label); self.wait(pause)
    def scroll(self, dy, secs=1.4):
        self.pg.evaluate("([dy,ms])=>new Promise(r=>{const y0=scrollY,t0=performance.now();const f=t=>{const k=Math.min(1,(t-t0)/ms),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;scrollTo(0,y0+dy*e);k<1?requestAnimationFrame(f):r()};requestAnimationFrame(f)})", [dy, secs * 1000]); self.wait(0.3)
    def scroll_to(self, sel, nth=0, offset=140, secs=1.4):
        y = self.pg.locator(sel).nth(nth).evaluate("e=>e.getBoundingClientRect().top+scrollY") - offset
        self.scroll(y - self.pg.evaluate("scrollY"), secs)
    def btn(self, text_regex):   # css selector for a visible button/link whose text matches
        return f"xpath=//*[(self::button or self::a) and contains(normalize-space(.), {json.dumps(text_regex, ensure_ascii=False)})]"

