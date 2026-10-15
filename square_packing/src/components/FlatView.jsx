// 视图 2：Ricci 流之后的**平直铺展** —— 每个三角形按实长度铺到平面上。
//
// 内边按 REL 的颜色画：蓝 = 上下相邻（决定 y），红 = 左右相邻（决定 x）。
// 注意铺展图不保证是嵌入的（可能自交叠）—— 那只是画出来不好看，组合信息没毛病。
import Panel, { fitTransform } from './Panel.jsx';
import { edgeRepairOf } from '../core/maps/index.js';

export default function FlatView({ result, hover, setHover, show, big }) {
  const { mesh, flat, rel, c, rectResidual, flow, aspect, preset } = result;
  const W = big ? 820 : 560, H = big ? 620 : 420;
  const t = fitTransform(flat, W, H);
  const roleOf = { [c.S]: 'S', [c.E]: 'E', [c.N]: 'N', [c.W]: 'W' };

  return (
    <Panel title="② 平直铺展（Ricci 流解出来的度量）"
      subtitle={flow.converged
        ? `矩形 ${rectResidual.W.toFixed(4)} × ${rectResidual.H.toFixed(4)}　长宽比 ${rectResidual.aspect.toFixed(5)}`
        : (
          <>
            <span className="warn">⚠ 本图的 Ricci 流没收敛</span>
            {`（max|K−K̄| = ${flow.err.toExponential(1)}）：下面是流停住时的度量，边界不保证是直线。`
              + (aspect.source === 'reference'
                ? `长宽比改用参考值 ${aspect.used.toFixed(5)}（只由输入四边形决定，见 README）`
                : `长宽比只能用本图铺展值 ${aspect.used.toFixed(5)}（参考值也拿不到）`)}
          </>
        )}
      width={W} height={H} transform={t}>
      {(tr) => (
        <>
          {mesh.faces.map((f, i) => (
            <polygon key={`f${i}`} className="tri flat"
              points={f.map((v) => tr.pt(flat[v]).join(',')).join(' ')} />
          ))}
          {mesh.edges.map(([a, b], e) => {
            const inner = mesh.facesOfEdge[e].length === 2;
            const lab = rel.edgeColor.get(e);
            const rep = edgeRepairOf(preset, a, b);       // 地图上不是真实相邻的边
            const cls = rep
              ? `g-edge ${rep.kind === 'artificial' || rep.kind === 'point' ? 'repair' : 'dummy-edge'}`
              : !inner ? 'g-edge boundary'
                : (show.rel && lab ? `rel ${lab.color === 'B' ? 'blue' : 'red'}` : 'g-edge');
            // 有标号时按 from → to 画（箭头才表示得对：蓝 = 从下往上，红 = 从左往右）
            const [p, q] = !rep && show.rel && inner && lab ? [lab.from, lab.to] : [a, b];
            return (
              <line key={`e${e}`} className={cls}
                x1={tr.x(flat[p][0])} y1={tr.y(flat[p][1])}
                x2={tr.x(flat[q][0])} y2={tr.y(flat[q][1])}
                markerEnd={!rep && show.rel && inner && lab ? `url(#arrow-${lab.color})` : undefined} />
            );
          })}
          <defs>
            {['B', 'R'].map((col) => (
              <marker key={col} id={`arrow-${col}`} viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={col === 'B' ? '#60a5fa' : '#f87171'} />
              </marker>
            ))}
          </defs>
          {show.ids && mesh.nv <= 80 ? flat.map((p, v) => (
            <text key={`t${v}`} className="g-id" x={tr.x(p[0]) + 4} y={tr.y(p[1]) - 4}>{v}</text>
          )) : null}
          {mesh.edges.map(([a, b], e) => (hover === a || hover === b ? (
            <line key={`h${e}`} className="g-edge hot"
              x1={tr.x(flat[a][0])} y1={tr.y(flat[a][1])}
              x2={tr.x(flat[b][0])} y2={tr.y(flat[b][1])} />
          ) : null))}
          {show.labels ? Object.entries(roleOf).map(([v, r]) => (
            <text key={r} className="g-corner" x={tr.x(flat[v][0])} y={tr.y(flat[v][1]) + (r === 'S' || r === 'E' ? -8 : 16)}>
              {r}
            </text>
          )) : null}
        </>
      )}
    </Panel>
  );
}
