// 1px check: the trail's branch curves meet the rails (stem, row lines, tail) and start below the node. Exit 1 on any miss over 1 px.
// Usage: AGENTNET_HOME=<scratch home> PW_MOD=<absolute path of playwright's index.js> node scripts/trail-arch-check.mjs http://127.0.0.1:<port> [agent]
import fs from 'node:fs';
const { chromium } = (await import(process.env.PW_MOD)).default ?? (await import(process.env.PW_MOD));
const base = process.argv[2], b = await chromium.launch({ headless: true, channel: 'chrome' });
const tok = fs.readFileSync(process.env.AGENTNET_HOME + '/run/panel.token','utf8').trim();
let bad = 0;
for (const [w,h] of [[390,844],[430,932],[1920,1080]]) for (const scheme of ['dark','light']) {
  const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }), p = await c.newPage();
  const lr = await (await fetch(base + '/api/v1/login/code', { method: 'POST', headers: { authorization: 'Bearer ' + tok } })).json();
  await p.goto(lr.url.startsWith('http') ? lr.url : base + lr.url); await p.waitForTimeout(500);
  await p.goto(`${base}/#/agents?view=2d&agent=${process.argv[3] ?? 'plan-dev-2'}`); await p.waitForTimeout(2000);
  await p.getByText(/^Trail\s*\d/).first().click().catch(()=>{}); await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const st = document.querySelector('.tr-branch'); if (!st) return null;
    const q = (e) => e.getBoundingClientRect(), cx = (e) => q(e).left + q(e).width / 2;
    const stem = st.querySelector('.tr-stem'), tail = st.querySelector('.tr-tail'), node = st.querySelector('.tr-node');
    const rows = [...st.querySelectorAll('.tr-row')], inn = st.querySelector('.tr-br.in'), out = st.querySelector('.tr-br.out');
    const rowX = (e) => q(e).left + 7 + 1, rowTop = (e) => q(e).top + 13, rowEnd = (e) => q(e).bottom - (e === rows.at(-1) ? 6 : -15);
    const px = (e) => (e.getAttribute('class').includes('in') ? 0 : 0);
    const inL = q(inn).left, outL = q(out).left;
    // path start/end x (centre of stroke): in: left+1 .. left+21 ; out: left+21 .. left+1
    const d = {
      inStartX_vs_stem: (inL + 1) - cx(stem), inEndX_vs_row: (inL + 21) - rowX(rows[0]),
      inStartY_vs_stemEnd: q(inn).top - q(stem).bottom, inEndY_vs_rowTop: q(inn).bottom - rowTop(rows[0]),
      outStartX_vs_row: (outL + 21) - rowX(rows.at(-1)), outEndX_vs_tail: (outL + 1) - cx(tail),
      outStartY_vs_rowEnd: q(out).top - rowEnd(rows.at(-1)), outEndY_vs_tailTop: q(out).bottom - q(tail).top,
      nodeX_vs_stem: cx(node) - cx(stem),
    };
    d.nodeRound = Math.abs(q(node).width - q(node).height);
    d.arcBelowNode = Math.min(0, q(inn).top - q(node).bottom); // 0 when the curve starts at or below the node's bottom edge
    d.rowsMeasured = rows.length - rows.length; // rows come from the DOM, not fixed numbers
    return d;
  });
  const worst = r ? Math.max(...Object.values(r).map(Math.abs)) : 99;
  const ok = r && worst <= 1;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${w}x${h} ${scheme} worst=${worst.toFixed(2)}px`, ok ? '' : JSON.stringify(r));
  await c.close();
}
await b.close(); process.exit(bad ? 1 : 0);
