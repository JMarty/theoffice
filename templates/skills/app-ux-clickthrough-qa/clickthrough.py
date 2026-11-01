#!/usr/bin/env python3
"""Parameterised click-through of a web app: every route, every role, phone + laptop, one screenshot per step.

Generalised from Toby's the company dashboard privacy crawl (agents/toby/evidence/2026-10-21-kops-dashboard-privacy/ui.py)
and the portal walks (darryl/work/kops-poll/tests/portal_ui_walk.py, toby/audits/portal-fixes-b35ad53-shots/common.py).

Run:  python3 -I clickthrough.py --links LINKS.txt --routes routes.txt --out DIR [--roles OWNER,PARTNER]
        [--forbid forbid.txt --forbid-role PARTNER --control CANARY] [--dark] [--wait 700]

--links   file with lines "ROLE: https://host/one-click-login-or-personal-link" (QA-LINKS.txt / app-links.txt format).
          The link is opened once per context; it must set the session cookie. Links are never printed.
--routes  one route per line: "name<TAB>/path" or "name<TAB>#/hash". '#' lines are comments.
--forbid  one term per line that must NOT appear for --forbid-role (privacy crawl): checked in the rendered text
          of every step AND in every same-host network response body.
--control a term that MUST appear somewhere for the forbidden role (positive control: proves the crawl can see data).
Output: DIR/<role>-<phone|laptop>[-dark]-<nn>-<name>.png, DIR/results.json. Exit 1 on any FAIL.
"""
import argparse, json, os, re, site, sys
sys.path.append(site.getusersitepackages())  # playwright lives in ~/.local; -I drops user site
from playwright.sync_api import sync_playwright

VIEWPORTS = {
    'phone': dict(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2),
    'laptop': dict(viewport={'width': 1366, 'height': 768}),
}

def read_lines(p):
    return [l.rstrip('\n') for l in open(p, encoding='utf-8') if l.strip() and not l.lstrip().startswith('#')]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--links', required=True); ap.add_argument('--routes', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--roles'); ap.add_argument('--forbid'); ap.add_argument('--forbid-role'); ap.add_argument('--control')
    ap.add_argument('--dark', action='store_true'); ap.add_argument('--wait', type=int, default=700)
    a = ap.parse_args()
    links = dict(re.findall(r'^\s*([A-Za-z0-9_ .-]+?):\s*(https?://\S+)', open(a.links, encoding='utf-8').read(), re.M))
    roles = a.roles.split(',') if a.roles else list(links)
    routes = [l.split('\t', 1) for l in read_lines(a.routes)]
    forbid = read_lines(a.forbid) if a.forbid else []
    os.makedirs(a.out, exist_ok=True)
    res = []
    def rec(name, ok, ev=''):
        res.append({'check': name, 'ok': bool(ok), 'evidence': str(ev)[:500]}); print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(ev)[:300] if ev else ''), flush=True)
    schemes = ['light', 'dark'] if a.dark else ['light']
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        for role in roles:
            if role not in links: rec(f'{role}: link present in links file', False); continue
            base = re.match(r'(https?://[^/]+)', links[role]).group(1)
            for vp, opts in VIEWPORTS.items():
                for cs in schemes:
                    tag = f'{role}-{vp}' + ('-dark' if cs == 'dark' else '')
                    ctx = br.new_context(color_scheme=cs, **opts); pg = ctx.new_page()
                    errs, bodies, texts = [], [], []
                    pg.on('pageerror', lambda e: errs.append(str(e)))
                    def onresp(r, base=base):
                        if r.url.startswith(base):
                            try: bodies.append((r.url, r.status, r.text()))
                            except Exception: pass
                    pg.on('response', onresp)
                    pg.on('dialog', lambda d: d.dismiss())
                    pg.goto(links[role]); pg.wait_for_timeout(a.wait * 2)
                    for i, (name, path) in enumerate(routes, 1):
                        if path.startswith('#'): pg.evaluate('h => location.hash = h', path)
                        else: pg.goto(base + path)
                        pg.wait_for_timeout(a.wait)
                        t = pg.inner_text('body'); texts.append(t)
                        pg.screenshot(path=os.path.join(a.out, f'{tag}-{i:02d}-{re.sub(r"[^A-Za-z0-9_-]", "_", name)}.png'), full_page=True)
                        hs = pg.evaluate('document.documentElement.scrollWidth > innerWidth')
                        rec(f'{tag} {name}: no horizontal scroll', not hs)
                    rec(f'{tag}: no page JS errors', not errs, errs[:3])
                    bad = [(u, s) for u, s, _ in bodies if s >= 500]
                    rec(f'{tag}: no 5xx responses', not bad, bad[:5])
                    if forbid and role == a.forbid_role:
                        dom = '\n'.join(texts); net = '\n'.join(b for _, _, b in bodies)
                        rec(f'{tag}: privacy - forbidden terms absent from rendered text', not [f for f in forbid if f in dom], [f for f in forbid if f in dom][:10])
                        rec(f'{tag}: privacy - forbidden terms absent from network bodies ({len(bodies)} responses)', not [f for f in forbid if f in net], [f for f in forbid if f in net][:10])
                        if a.control:
                            rec(f'{tag}: positive control "{a.control}" seen (crawl can see data)', a.control in dom or a.control in net, f'dom {dom.count(a.control)} net {net.count(a.control)}')
                    ctx.close()
        br.close()
    json.dump(res, open(os.path.join(a.out, 'results.json'), 'w'), ensure_ascii=False, indent=1)
    fails = [r for r in res if not r['ok']]
    print(f'{len(res)} checks, {len(fails)} FAIL; shots + results.json in {a.out}')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()
