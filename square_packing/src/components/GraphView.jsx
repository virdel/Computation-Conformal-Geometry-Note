// 视图 1：输入图（Tutte 嵌入，四个角点钉在输入四边形上）。
// 这是「原始图」—— 后面所有东西都是从它算出来的。
//
// 地图预设另给了一套经纬度（preset.geo + geoKind:'geo'）：那就**按地理坐标画**，
// 好认出美国和中国的形状。导入的图如果文件里给了 pos，也按它画（geoKind:'xy'），
// 但那时照常画三角形 —— 用户的坐标一般就是个真嵌入。
// 注意这只是显示 —— 算法内部用的是 Tutte 嵌入，而「2-连通平面图 + 指定外面」
// 的嵌入是唯一的，与坐标无关（见 mapgraph.js）。
import Panel, { fitTransform } from './Panel.jsx';
import { edgeRepairOf, vertexKindOf, vertexNameOf } from '../core/maps/index.js';

const CORNER_NAME = [['S', '左下'], ['E', '右下'], ['N', '右上'], ['W', '左上']];

export default function GraphView({ result, hover, setHover, show, big }) {
  const { input, mesh, c, preset } = result;
  const W = big ? 820 : 560, H = big ? 620 : 420;
  const geo = preset.geo || null;
  const landOnly = preset.geoKind === 'geo';       // 经纬度布局：只画陆块轮廓，不画三角形
  const pts = geo || input.verts;
  const t = fitTransform(pts, W, H, landOnly ? 30 : 14);
  const roleOf = { [c.S]: 'S', [c.E]: 'E', [c.N]: 'N', [c.W]: 'W' };
  const names = preset.names || null;
  const nameSize = mesh.nv > 40 ? 7 : 9;

  return (
    <Panel title="① 输入图"
      subtitle={landOnly
        ? <>地理布局（仅用于显示），算法用的是 Tutte 嵌入　V={mesh.nv} E={mesh.ne} F={mesh.nf}</>
        : geo
          ? <>文件里的坐标（仅用于显示），算法用的是 Tutte 嵌入　V={mesh.nv} E={mesh.ne} F={mesh.nf}</>
          : `V=${mesh.nv}  E=${mesh.ne}  F=${mesh.nf}`}
      width={W} height={H}
      transform={t}>
      {(tr) => (
        <>
          {landOnly ? (
            // 地理布局下三角形是「Tutte 嵌入里的三角形用经纬度画」，会互相压在一起，
            // 所以只填外边界围出的陆块轮廓 —— 州界/省界由边表示。
            <polygon className="geo-land"
              points={mesh.boundary.map((v) => tr.pt(geo[v]).join(',')).join(' ')} />
          ) : input.faces.map((f, i) => (
            <polygon key={`f${i}`} className="tri"
              points={f.map((v) => tr.pt(pts[v]).join(',')).join(' ')} />
          ))}
          {mesh.edges.map(([a, b], e) => {
            const rep = edgeRepairOf(preset, a, b);
            const cls = !rep ? (mesh.facesOfEdge[e].length === 2 ? 'g-edge' : 'g-edge boundary')
              : `g-edge ${rep.kind === 'artificial' || rep.kind === 'point' ? 'repair' : 'dummy-edge'}`;
            return (
              <line key={`e${e}`} className={cls}
                x1={tr.x(pts[a][0])} y1={tr.y(pts[a][1])}
                x2={tr.x(pts[b][0])} y2={tr.y(pts[b][1])} />
            );
          })}
          {pts.map((p, v) => {
            const kd = vertexKindOf(preset, v);
            return (
              <g key={`v${v}`}>
                <circle className={`g-node${hover === v ? ' hot' : ''}${roleOf[v] ? ' corner' : ''}${kd === 'real' ? '' : ' dummy'}`}
                  cx={tr.x(p[0])} cy={tr.y(p[1])} r={roleOf[v] ? 7 : kd === 'real' ? 4.5 : 5.5}
                  onMouseEnter={() => setHover(v)} onMouseLeave={() => setHover(-1)} />
                {show.ids && mesh.nv <= 80 ? (
                  <text className="g-id" x={tr.x(p[0]) + 7} y={tr.y(p[1]) - 5}>{v}</text>
                ) : null}
              </g>
            );
          })}
          {names ? pts.map((p, v) => (
            <text key={`n${v}`} className={`g-name${hover === v ? ' hot' : ''}${vertexKindOf(preset, v) === 'real' ? '' : ' dummy'}`}
              x={tr.x(p[0])} y={tr.y(p[1]) + 12} fontSize={nameSize}>
              {vertexNameOf(preset, v)}
            </text>
          )) : null}
          {show.labels ? CORNER_NAME.map(([r]) => {
            const v = c[r];
            return (
              <text key={r} className="g-corner" x={tr.x(pts[v][0])} y={tr.y(pts[v][1]) - 12}>
                {r}
              </text>
            );
          }) : null}
        </>
      )}
    </Panel>
  );
}
