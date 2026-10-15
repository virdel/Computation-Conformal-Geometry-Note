// 三块视图共用的 SVG 画框：自动把内容缩放居中（y 轴翻转成屏幕方向）。
import { useMemo } from 'react';

/**
 * 求一个把点集放进 w×h 画布的仿射变换（等比缩放 + 居中 + y 翻转）。
 * @param {number[][]} points
 */
export function fitTransform(points, w, h, pad = 14) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  if (!Number.isFinite(x0)) { x0 = x1 = y0 = y1 = 0; }
  const dx = Math.max(x1 - x0, 1e-9), dy = Math.max(y1 - y0, 1e-9);
  const s = Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy);
  const ox = pad + (w - 2 * pad - s * dx) / 2 - s * x0;
  const oy = pad + (h - 2 * pad - s * dy) / 2 + s * y1;    // y 翻转
  return {
    s,
    x: (px) => ox + s * px,
    y: (py) => oy - s * py,
    pt: (p) => [ox + s * p[0], oy - s * p[1]],
  };
}

export default function Panel({ title, subtitle, width = 560, height = 420, transform, children }) {
  const vb = useMemo(() => `0 0 ${width} ${height}`, [width, height]);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {subtitle ? <span className="panel-sub">{subtitle}</span> : null}
      </header>
      <svg viewBox={vb} className="panel-svg" style={{ aspectRatio: `${width} / ${height}` }}>
        {transform ? <g>{children(transform)}</g> : children}
      </svg>
    </section>
  );
}
