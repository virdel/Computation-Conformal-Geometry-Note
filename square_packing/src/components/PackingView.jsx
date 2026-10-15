// 视图 3：矩形对偶（铺满）—— 每个顶点一个矩形，图上相邻的矩形正好贴边。
//
// 地图预设多了三样人和机器都该一眼看见的东西：
//   · 每个方块上写州名/省名（太小放不下就不写，悬停看全名）；
//   · 人工块（五大湖、大西洋这类水域块）画成灰色虚线框，标「人工块」；
//   · 人工补出来的接触（缅因–马萨诸塞、Four Corners）画成橙色虚线。
import { useMemo } from 'react';
import Panel, { fitTransform } from './Panel.jsx';
import { contactSegment } from '../core/verify.js';
import { edgeRepairOf, vertexKindOf, vertexNameOf } from '../core/maps/index.js';

/** 按顶点号给一个低饱和度、彼此可区分的颜色（色相按黄金角散开）。*/
export function hueOf(v) {
  return `hsl(${(v * 137.508) % 360} 46% 58%)`;
}

const DUMMY_FILL = '#64748b';

export default function PackingView({ result, rects, W, H, hover, setHover, show, big }) {
  const { c, mesh, preset } = result;
  const px = big ? 820 : 560, py = big ? 620 : 420;
  const t = fitTransform([[0, 0], [W, H]], px, py);
  const roleOf = { [c.S]: 'S', [c.E]: 'E', [c.N]: 'N', [c.W]: 'W' };
  const names = preset.names || null;

  // 人工补出来的接触画在哪：直接取两个矩形共享的那条边段。
  const seams = useMemo(() => {
    if (!preset.edgeKind) return [];
    const out = [];
    for (let e = 0; e < mesh.ne; e++) {
      const [a, b] = mesh.edges[e];
      const rep = edgeRepairOf(preset, a, b);
      if (!rep || (rep.kind !== 'artificial' && rep.kind !== 'point')) continue;
      const seg = contactSegment(rects[a], rects[b]);
      if (seg) out.push({ ...rep, a, b, seg });
    }
    return out;
  }, [preset, mesh, rects]);

  return (
    <Panel title="③ 方块填充（矩形对偶）"
      subtitle={`${rects.length} 块　W×H = ${W.toFixed(2)} × ${H.toFixed(2)}　长宽比 ${(W / H).toFixed(4)}`}
      width={px} height={py} transform={t}>
      {(tr) => (
        <>
          <rect className="pack-bg" x={tr.x(0)} y={tr.y(H)} width={tr.s * W} height={tr.s * H} />
          {rects.map((r) => {
            const on = hover === r.v;
            const kd = vertexKindOf(preset, r.v);
            const dummy = kd !== 'real';
            return (
              <rect key={`r${r.v}`}
                className={`pack${on ? ' hot' : ''}${dummy ? ' dummy' : ''}`}
                x={tr.x(r.x1)} y={tr.y(r.y2)}
                width={Math.max(0, tr.s * (r.x2 - r.x1))} height={Math.max(0, tr.s * (r.y2 - r.y1))}
                fill={on ? '#fbbf24' : dummy ? DUMMY_FILL : show.rel ? hueOf(r.v) : '#334155'}
                fillOpacity={on ? 0.95 : dummy ? 0.45 : 0.55}
                onMouseEnter={() => setHover(r.v)} onMouseLeave={() => setHover(-1)} />
            );
          })}
          {seams.map((s) => (
            <line key={`s${s.a}-${s.b}`} className="pack-seam"
              x1={tr.x(s.seg[0][0])} y1={tr.y(s.seg[0][1])}
              x2={tr.x(s.seg[1][0])} y2={tr.y(s.seg[1][1])} />
          ))}
          {names ? rects.map((r) => {
            const w = tr.s * (r.x2 - r.x1), h = tr.s * (r.y2 - r.y1);
            const full = vertexNameOf(preset, r.v) || '';
            const short = full.replace(/（.*?）/g, '').replace(/\+.*$/, '');
            const fs = h > 22 ? 9.5 : 8;
            const label = [full, short].find((x) => x && x.length * fs * 1.08 <= w - 4);
            if (!label || h < 12) return null;
            return (
              <text key={`nm${r.v}`} className={`pack-name${vertexKindOf(preset, r.v) === 'real' ? '' : ' dummy'}`}
                x={tr.x((r.x1 + r.x2) / 2)} y={tr.y((r.y1 + r.y2) / 2) + fs * 0.36} fontSize={fs}>
                {label}
              </text>
            );
          }) : null}
          {show.labels ? rects.filter((r) => roleOf[r.v]).map((r) => (
            <text key={`c${r.v}`} className="g-corner"
              x={tr.x((r.x1 + r.x2) / 2)} y={tr.y((r.y1 + r.y2) / 2) + 5}>
              {roleOf[r.v]}
            </text>
          )) : null}
          {show.ids && rects.length <= 80 ? rects.map((r) => (
            <text key={`i${r.v}`} className="g-id"
              x={tr.x((r.x1 + r.x2) / 2)} y={tr.y((r.y1 + r.y2) / 2) + 4}>{r.v}</text>
          )) : null}
        </>
      )}
    </Panel>
  );
}
