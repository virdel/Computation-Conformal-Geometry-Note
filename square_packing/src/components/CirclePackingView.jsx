// 视图 4：圆盘填充（circle packing）—— 每个顶点一颗圆，图上相邻的两颗**正好相切**。
//
// 和方块填充的关系：同一条流水线，只换度量族（l_ij = r_i + r_j），目标曲率**完全一样**
//（4 个角点 π/2、其余 0）。所以解出来：4 个角点的角度和 = 90°、墙点 = 180°（边界圆心链
// 在墙上走直线）、内点 = 360°，于是 4 条墙的圆心链围成一个**矩形**（外边界只有 4 个点时
// 更是正方形）。这条链就画成实线外框 —— 它穿过圆心，所以圆会探出框外，这是对的：
// 外框是「圆心链」，不是容器的边。
//
// 填充只由三角剖分的组合结构决定 —— 输入四边形、长宽比这两个滑杆都动不了它。
//
// 圆小到亚像素时（真实地图上会有一批）画成一个点：照实画，不放大、不隐藏，
// 面板底部的「固有退化」提示会给出数字和原因。
import { useMemo } from 'react';
import Panel, { fitTransform } from './Panel.jsx';
import { hueOf } from './PackingView.jsx';
import { vertexKindOf, vertexNameOf } from '../core/maps/index.js';

const DEGENERATE_RATIO = 30;   // 边界半径比超过这个数就标「固有退化」

export default function CirclePackingView({ result, cp, hover, setHover, show, big }) {
  const { mesh, preset } = result;
  const px = big ? 820 : 560, py = big ? 620 : 420;
  const { pos, r, frame } = cp;
  // 视图范围 = 所有圆盘的并（圆心 ± 半径），照实画：小圆就该小。
  const t = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < pos.length; v++) {
      x0 = Math.min(x0, pos[v][0] - r[v]); x1 = Math.max(x1, pos[v][0] + r[v]);
      y0 = Math.min(y0, pos[v][1] - r[v]); y1 = Math.max(y1, pos[v][1] + r[v]);
    }
    const pad = 0.02 * Math.max(x1 - x0, y1 - y0);
    return fitTransform([[x0 - pad, y0 - pad], [x1 + pad, y0 - pad],
      [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]], px, py);
  }, [pos, r, px, py]);
  const names = preset.names || null;
  const minPx = 1.2 / t.s;                 // 画面上 1.2px 对应的世界长度
  const degenerate = cp.ratioBoundary > DEGENERATE_RATIO;
  const roleOf = result.c ? { [result.c.S]: 'S', [result.c.E]: 'E', [result.c.N]: 'N', [result.c.W]: 'W' } : {};

  // 外框 = 4 个角点之间的 4 条弦（每条弦的中间是边界圆心链，链上每点角度和都是 180° ⟹ 共线）
  const ring = frame.cornerRing;
  const frameEdges = ring.map((v, i) => [v, ring[(i + 1) % 4]]);

  const sub = (
    <>
      {mesh.nv} 颗圆　四角 = 90°（墙点 180°、内点 360°）
      　外框 {frame.chords[0].toFixed(4)} × {frame.chords[1].toFixed(4)}
      　对边比 {frame.aspect.toFixed(4)}
      {degenerate ? <span className="warn">　← 固有退化，见下</span> : null}
    </>
  );

  return (
    <Panel title="④ 圆盘填充（相切圆盘，四角 90°）" subtitle={sub} width={px} height={py} transform={t}>
      {(tr) => (
        <>
          {frameEdges.map(([a, b]) => (
            <line key={`f${a}-${b}`} className="cp-frame"
              x1={tr.x(pos[a][0])} y1={tr.y(pos[a][1])}
              x2={tr.x(pos[b][0])} y2={tr.y(pos[b][1])} />
          ))}
          {mesh.edges.map(([a, b]) => (
            <line key={`e${a}-${b}`} className="cp-edge"
              x1={tr.x(pos[a][0])} y1={tr.y(pos[a][1])}
              x2={tr.x(pos[b][0])} y2={tr.y(pos[b][1])} />
          ))}
          {pos.map((p, v) => {
            const on = hover === v;
            const dummy = vertexKindOf(preset, v) !== 'real';
            const rr = Math.max(r[v], minPx);
            return (
              <circle key={`c${v}`}
                className={`cp-circle${on ? ' hot' : ''}`}
                cx={tr.x(p[0])} cy={tr.y(p[1])} r={tr.s * rr}
                fill={on ? '#fbbf24' : dummy ? '#64748b' : hueOf(v)}
                fillOpacity={on ? 0.9 : dummy ? 0.4 : show.rel ? 0.35 : 0.3}
                stroke={on ? '#fde68a' : dummy ? '#94a3b8' : hueOf(v)}
                strokeWidth={on ? 2 : 1}
                onMouseEnter={() => setHover(v)} onMouseLeave={() => setHover(-1)} />
            );
          })}
          {names ? pos.map((p, v) => {
            const d = 2 * r[v] * t.s;
            const full = vertexNameOf(preset, v) || '';
            const short = full.replace(/（.*?）/g, '').replace(/\+.*$/, '');
            const fs = Math.min(10, Math.max(7, d * 0.5));
            const label = [full, short].find((x) => x && x.length * fs * 1.08 <= d - 2);
            if (!label || d < 16) return null;
            return (
              <text key={`n${v}`} className={`cp-name${vertexKindOf(preset, v) === 'real' ? '' : ' dummy'}`}
                x={tr.x(p[0])} y={tr.y(p[1]) + fs * 0.36} fontSize={fs}>{label}</text>
            );
          }) : null}
          {show.labels ? Object.entries(roleOf).map(([v, s]) => (
            <text key={`r${v}`} className="g-corner"
              x={tr.x(pos[v][0])} y={tr.y(pos[v][1]) + 5}>{s}</text>
          )) : null}
          {show.ids && mesh.nv <= 80 ? pos.map((p, v) => (
            <text key={`i${v}`} className="g-id" x={tr.x(p[0])} y={tr.y(p[1]) + 3.5}>{v}</text>
          )) : null}
        </>
      )}
    </Panel>
  );
}

/**
 * 「固有退化」说明（放在数字面板里）。
 * 机制：外框是边界圆心的矩形，边长 = Σ(r_i + r_{i+1})，整圈周长 ≈ 2·Σr_boundary 被内点的
 * 尺度锁住；边界点一多，边界半径就必然两极分化。墙上度 2 的「耳朵」更狠：它只有一个三角形，
 * 要求角度和恰好 180°，只能靠 r → 0 逼近 —— 那是解的边界，不是解析解。
 * 同一个三角剖分换成极大填充（所有边界圆共外圆）数字不同（美国 754 对这里 1.2e4），
 * 两种边界条件都躲不掉大比值，README 有对照表。
 */
export function degenerateNote(cp, mesh) {
  if (!cp || cp.ratioBoundary <= DEGENERATE_RATIO) return null;
  const lo = cp.r.reduce((m, x) => Math.min(m, x), Infinity);
  const nB = mesh.boundary.length;
  return `边界半径比 ${cp.ratioBoundary.toFixed(0)} ＝ 这张三角剖分的固有性质，不是数值问题：`
    + `外框是边界圆心的矩形（第 t 条边 = Σ(r_i + r_{i+1})），它的周长被内点的尺度锁住，`
    + `于是边界点 ${nB} 个、内点 ${mesh.nv - nB} 个这种情况下，边界半径必然两极分化，`
    + `最小半径 ${lo.toExponential(2)}。换一种边界条件（极大填充：所有边界圆共外圆）也躲不掉，`
    + `只是数字不同 —— README 里两种都列了。`;
}
