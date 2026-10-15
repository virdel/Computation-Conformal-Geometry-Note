// 界面状态 + 四个视图的编排。
//
// 两次计算就得到了四幅图要用的全部数据：
//   runPipeline：① 输入图（Tutte 嵌入） ② Ricci 流之后的平直铺展 ③ 矩形对偶（铺满）
//   circlePack ：④ 相切圆盘填充（同一条流水线、同一套目标曲率，只换度量族；四角 90°）
// 悬停某个顶点时四幅图同步高亮 —— 这是「同一个顶点在四种表示里长什么样」的关键。
//
// 图的来源有三条，但**只**在 preset 这一层分开（`imported` / `rnd` / 内建预设），
// 后面两个 useMemo 和四个视图组件一行都不用改 —— 这就是「导入的图」能白拿四幅图的原因。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRESETS, randomPTP } from './core/presets.js';
import { MAP_PRESETS, MAP_CHIPS, mapSummary, vertexNameOf } from './core/maps/index.js';
import { runPipeline, quadForPreset, buildInputMesh } from './core/pipeline.js';
import { circlePack, auditPacking } from './core/circlepack.js';
import { verifyPacking } from './core/verify.js';
import GraphView from './components/GraphView.jsx';
import FlatView from './components/FlatView.jsx';
import PackingView from './components/PackingView.jsx';
import CirclePackingView from './components/CirclePackingView.jsx';
import Stats from './components/Stats.jsx';
import Help from './components/Help.jsx';
import ImportPanel from './components/ImportPanel.jsx';

const VIEW_NAMES = ['全部视图', '只看输入图', '只看平直铺展', '只看方块填充', '只看圆盘填充'];

// 可选项 = 8 个预设 + 2 个真实地图，用一个下标统一管理（← / → 能一路翻过去）。
const NP = PRESETS.length;
const TOTAL = NP + MAP_PRESETS.length;

/** 侧栏那一行小结：地图和导入的图各自的说法。*/
function reportLine(P) {
  if (!P.report) return null;
  if (P.report.source !== 'file') return mapSummary(P);
  const r = P.report;
  return `V=${r.nv} E=${r.ne} F=${r.nf}，外圈 ${r.boundaryLen} 点`
    + `，自动修补 ${r.repairs} 条（逐条列在右边的「导入与修补」里）`;
}

export default function App() {
  const [sel, setSel] = useState(0);               // 0..NP−1 预设，NP.. 两个地图
  const [rnd, setRnd] = useState(null);            // 随机图 {nv, seed}；非空时盖过预设
  const [imported, setImported] = useState(null);  // 从文件导入的 preset；非空时盖过上面两个
  const [impOpen, setImpOpen] = useState(false);   // 导入浮层
  const [blend, setBlend] = useState(1);           // 输入四边形：0 = 正方形，1 = 本图自己的四边形
  const [scale, setScale] = useState(1);           // 长宽比相对共形值的倍数
  const [view, setView] = useState(0);
  const [hover, setHover] = useState(-1);
  const [help, setHelp] = useState(false);
  const [show, setShow] = useState({ rel: true, labels: true, ids: false });

  const preset = useMemo(() => {
    if (imported) return imported;
    if (rnd) {
      const g = randomPTP(rnd.nv, rnd.seed);
      return { id: `rnd${rnd.nv}-${rnd.seed}`, name: `随机 PTP（${g.nv} 点，种子 ${rnd.seed}）`, note: '插点 + 洗牌生成的 PTP 图', ...g };
    }
    return sel < NP ? PRESETS[sel] : MAP_PRESETS[sel - NP];
  }, [imported, rnd, sel]);

  // 主计算。预设图几十毫秒；随机图到 200 点也就一两百毫秒，地图（26 / 48 点）更快，直接同步算。
  // 包一层 try/catch：拖「输入四边形」滑杆换到某个流不收敛的四边形时，tutteEmbed / Mesh /
  // ricciFlow 都会抛 —— 抛了就给一张错误卡片，别让整页白屏。
  const run = useMemo(() => {
    try {
      return { ok: true, result: runPipeline(preset, { quad: quadForPreset(preset, blend) }) };
    } catch (err) {
      return { ok: false, err: (err && err.message) || String(err) };
    }
  }, [preset, blend]);
  const result = run.ok ? run.result : null;

  // 圆盘填充：只依赖三角剖分的组合结构，**不**依赖输入四边形 —— 相切度量 l_ij = r_i + r_j
  // 里根本没有坐标，Tutte 嵌入只用来给出一个合法的 Mesh（找外面、定边界圈）。
  // 所以这里故意不把 blend 放进依赖里：拖四边形滑杆时这幅图不该动。
  const cp = useMemo(() => {
    if (!run.ok) return null;
    const { mesh, corners } = buildInputMesh(preset);
    const out = circlePack(mesh, { corners });     // 默认 mode:'angles'：四个角各 90°
    return { mesh, ...out, audit: auditPacking(mesh, out.pos, out.r) };
  }, [run.ok, preset]);

  // 长宽比只整体拉伸 x（层间距自由），所以组合结构和校验结论都不变 —— 这里重算一遍校验
  // 是为了让面板上的数字和画出来的图一致。
  const { rects, W, H, verification } = useMemo(() => {
    if (!run.ok) return { rects: null, W: 0, H: 0, verification: null };
    const r0 = run.result.packing.rects;
    const rs = scale === 1 ? r0 : r0.map((r) => ({ ...r, x1: r.x1 * scale, x2: r.x2 * scale }));
    const w = run.result.packing.W * scale, h = run.result.packing.H;
    // 带上 walls，就能连「边界点贴框 / 内点贴框」一起查（拉伸只改 x，结论不变）。
    return { rects: rs, W: w, H: h, verification: verifyPacking(run.result.mesh, rs, w, h, run.result.c, run.result.walls) };
  }, [run, scale]);

  // 换图时把悬停清掉：新图的顶点数可能更少，留着旧的下标会让悬停那一行去读不存在的矩形。
  useEffect(() => { setHover(-1); }, [preset]);

  // 切回内建图（预设或地图）。所有会离开「导入的图」的地方都走这一个口，
  // 免得哪天漏改一处，出现「chip 高亮在内建图、画的却是导入的图」。
  const selectBuiltin = useCallback((i) => {
    if (i != null) setSel(i);
    setRnd(null);
    setImported(null);
    setScale(1);
  }, []);

  const next = useCallback((d) => {
    setRnd(null);
    setImported(null);
    setSel((i) => (i + d + TOTAL) % TOTAL);
    setScale(1);
  }, []);

  const newRandom = useCallback((dn = 0) => {
    setImported(null);
    setRnd((old) => {
      const nv = Math.max(8, Math.min(240, (old ? old.nv : 60) + dn));
      return { nv, seed: (old ? old.seed : 1) + 1 };
    });
    setScale(1);
  }, []);

  useEffect(() => {
    const onKey = (ev) => {
      // 焦点在输入框/滑杆/文本域里时不要抢按键（否则在文本框里打不出 r、q、l…）
      const el = ev.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
        if (ev.key === 'Escape') el.blur();
        return;
      }
      if (ev.key === '?') { setHelp((h) => !h); return; }
      if (ev.key === 'Escape') { setHelp(false); setImpOpen(false); return; }
      if (help || impOpen) return;
      const k = ev.key;
      if (k >= '1' && k <= '8') selectBuiltin(Number(k) - 1);
      else if (k === '9') selectBuiltin(NP);                                // 美国
      else if (k === '0') selectBuiltin(NP + 1);                            // 中国
      else if (k === 'u') setImpOpen(true);                                 // 导入自己的图
      else if (k === 'ArrowRight') next(1);
      else if (k === 'ArrowLeft') next(-1);
      else if (k === 'r') newRandom(0);
      else if (k === ']') newRandom(10);
      else if (k === '[') newRandom(-10);
      else if (k === 'v') setView((v) => (v + 1) % VIEW_NAMES.length);
      else if (k === 'c') setScale(1);
      else if (k === '-') setScale((s) => Math.max(0.4, s * 0.95));
      else if (k === '=' || k === '+') setScale((s) => Math.min(2.5, s / 0.95));
      else if (k === 'q') setBlend((b) => Math.max(0, b - 0.25));
      else if (k === 'Q') setBlend((b) => Math.min(1, b + 0.25));
      else if (k === 'l') setShow((s) => ({ ...s, ids: !s.ids }));
      else if (k === 'f') setShow((s) => ({ ...s, rel: !s.rel }));
      else return;
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, impOpen, next, newRandom, selectBuiltin]);

  const loadImported = useCallback((p) => {
    setImported(p);
    setScale(1);
    // 导入的图多半不大，顺手把顶点编号打开（名字/编号是读这种图最要紧的东西）
    if (p.nv <= 80) setShow((s) => ({ ...s, ids: true }));
  }, []);

  const three = view === 0;              // 「全部视图」：四幅排成 2 × 2
  const big = !three;                    // 单看一幅时画大一点
  const aspectNow = result ? W / H : 0;
  const aspectUsed = result ? result.aspect.used : 0;  // 实际上是它定的填充形状（流没收敛时来自参考图）
  const hoverName = hover >= 0 ? vertexNameOf(preset, hover) : null;

  return (
    <div className="app">
      <header className="top">
        <h1>图 → 铺满</h1>
        <span className="tag">离散 Ricci 流 + 矩形对偶（方块填充）／相切圆盘（圆盘填充）</span>
        <span className="grow" />
        <button className="btn" onClick={() => setImpOpen(true)}>u 导入图…</button>
        <button className="btn" onClick={() => setHelp(true)}>? 说明</button>
      </header>

      <div className="body">
        <aside className="side">
          <h3>图</h3>
          <div className="chips">
            {PRESETS.map((P, i) => (
              <button key={P.id} className={`chip${!rnd && !imported && sel === i ? ' on' : ''}`}
                onClick={() => selectBuiltin(i)}>
                {P.id}
              </button>
            ))}
            <button className={`chip${rnd && !imported ? ' on' : ''}`} onClick={() => newRandom(0)}>随机</button>
          </div>

          <h3>真实地图（手写数据）</h3>
          <div className="chips">
            {MAP_PRESETS.map((M, i) => (
              <button key={M.id} className={`chip map${!rnd && !imported && sel === NP + i ? ' on' : ''}`}
                onClick={() => selectBuiltin(NP + i)}>
                {MAP_CHIPS[i]}
              </button>
            ))}
          </div>

          <h3>导入自己的图</h3>
          <div className="chips">
            <button className={`chip imp${imported ? ' on' : ''}`} onClick={() => setImpOpen(true)}>
              {imported ? imported.name : '导入图…'}
            </button>
            {imported ? <button className="chip" onClick={() => selectBuiltin(null)}>切回内置预设</button> : null}
          </div>

          <div className="hint">
            {preset.name}{preset.note ? ` — ${preset.note}` : ''}
            {reportLine(preset) ? <div className="hint-sub">{reportLine(preset)}</div> : null}
          </div>

          <h3>视图</h3>
          <div className="chips">
            {VIEW_NAMES.map((nm, i) => (
              <button key={nm} className={`chip${i === view ? ' on' : ''}`} onClick={() => setView(i)}>{nm}</button>
            ))}
          </div>

          <h3>长宽比</h3>
          {result ? (
            <>
              <input type="range" min="0.4" max="2.5" step="0.01" value={scale}
                onChange={(ev) => setScale(Number(ev.target.value))} />
              <div className="hint">
                当前 W/H = <b>{aspectNow.toFixed(4)}</b>
                （{result.aspect.source === 'reference' ? '参考值' : '共形值'} {aspectUsed.toFixed(4)} × {scale.toFixed(2)}）
                <button className="btn tiny" onClick={() => setScale(1)}>归位</button>
              </div>
            </>
          ) : <div className="hint">这张图算不出来（原因在右边）</div>}

          <h3>输入四边形</h3>
          <input type="range" min="0" max="1" step="0.05" value={blend}
            onChange={(ev) => setBlend(Number(ev.target.value))} />
          <div className="hint">
            {blend < 0.02 ? '正方形：角点本来就是 π/2，Ricci 流没事干（长宽比 = 1）'
              : `${preset.quad ? '本图的地理四边形（4 个角点的经纬度归一化）'
                : imported ? '默认斜四边形（导入的图没有几何四边形）' : '斜四边形'}`
                + `（混合 ${blend.toFixed(2)}）：流把角点掰回 π/2`}
          </div>

          <h3>显示</h3>
          <label className="check"><input type="checkbox" checked={show.rel}
            onChange={() => setShow((s) => ({ ...s, rel: !s.rel }))} /> REL 颜色（蓝 = 上下 / 红 = 左右）</label>
          <label className="check"><input type="checkbox" checked={show.labels}
            onChange={() => setShow((s) => ({ ...s, labels: !s.labels }))} /> 角点字母 S/E/N/W</label>
          <label className="check"><input type="checkbox" checked={show.ids}
            onChange={() => setShow((s) => ({ ...s, ids: !s.ids }))} /> 顶点编号（≤ 80 点）</label>

          <h3>悬停</h3>
          <div className="hint">
            {result && hover >= 0
              ? <>顶点 v<b>{hover}</b>{hoverName && hoverName !== `v${hover}` ? `（${hoverName}）` : ''}
                ：图上度数 {result.mesh.deg[hover]}，矩形 [{rects[hover].x1.toFixed(2)}, {rects[hover].x2.toFixed(2)}] × [{rects[hover].y1}, {rects[hover].y2}]，
                圆半径 {cp.r[hover].toExponential(3)}{result.mesh.isBoundaryVert[hover] ? '（边界圆）' : ''}</>
              : '把鼠标放到任意一幅图的顶点/矩形/圆上，四幅图同步高亮'}
          </div>
        </aside>

        <main className={`views ${run.ok && view === 0 ? 'grid4' : 'grid1'}`}>
          {!run.ok ? (
            <div className="err-card">
              <h3>这张图跑不出来</h3>
              <div className="stat-why">{run.err}</div>
              <div className="imp-row">
                <button className="btn" onClick={() => selectBuiltin(0)}>回到内置预设</button>
                {imported ? <button className="btn" onClick={() => setImpOpen(true)}>重新导入</button> : null}
                <button className="btn tiny" onClick={() => setBlend(1)}>四边形混回 1</button>
              </div>
              <div className="stat-note">
                最常见的原因是「输入四边形」被拖到了某个本图撑不住的形状（Ricci 流不收敛、
                铺展开的角点次序对不上）。拖回 0（正方形）或按 c 把长宽比归位再试。
              </div>
            </div>
          ) : (
            <>
              {three || view === 1 ? (
                <GraphView result={result} hover={hover} setHover={setHover} show={show} big={big} />
              ) : null}
              {three || view === 2 ? (
                <FlatView result={result} hover={hover} setHover={setHover} show={show} big={big} />
              ) : null}
              {three || view === 3 ? (
                <PackingView result={result} rects={rects} W={W} H={H} hover={hover} setHover={setHover} show={show} big={big} />
              ) : null}
              {three || view === 4 ? (
                <CirclePackingView result={result} cp={cp} hover={hover} setHover={setHover} show={show} big={big} />
              ) : null}
            </>
          )}
        </main>

        <aside className="side right">
          {result && cp && verification ? (
            <Stats result={result} rects={rects} W={W} H={H} verify={verification} cp={cp} />
          ) : (
            <div className="stats">
              <h3>出错</h3>
              <div className="stat-why">这张图没算出来，右侧的数字无从谈起。</div>
            </div>
          )}
        </aside>
      </div>

      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {impOpen ? <ImportPanel onClose={() => setImpOpen(false)} onLoad={loadImported} current={imported ? imported.name : ''} /> : null}
    </div>
  );
}
