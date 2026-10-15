// 数字面板：每一步的关键量都摆出来，方便对照 README 里的校验表。
// 地图预设还多一块「修补账」：人工块 / 人工边 / 点接触 / 合并 / 排除，每条带理由 ——
// 这是这套例子最该被看见的东西（真实相邻关系不是原样保持的，偏离处全部公开）。
import { KIND_LABEL, EDGE_LABEL } from '../core/maps/index.js';
import { degenerateNote } from './CirclePackingView.jsx';

const e = (x, d = 2) => (Number.isFinite(x) ? x.toExponential(d) : '—');
const deg = (x) => (x * 180) / Math.PI;

const ASPECT_SRC = {
  flow: '本图的 Ricci 流',
  override: '手动指定',
  reference: '参考图（本图流未收敛）',
  'flow（未收敛）': '本图流（未收敛）',
};

function Row({ k, v, cls }) {
  return (
    <div className={`stat-row${cls ? ' ' + cls : ''}`}>
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </div>
  );
}

export default function Stats({ result, rects, W, H, verify, cp }) {
  const { mesh, flow, rectResidual: rr, rel, packing, aspect, preset } = result;
  const s = rel.solved;
  const n = verify.numbers;
  const a = cp ? cp.audit : null;
  const isMap = !!(preset && preset.report);
  const isFile = isMap && preset.report.source === 'file';   // 从文件导入的图，措辞换一套
  const cnt = isMap ? preset.report.counts : null;
  const nReal = isMap ? preset.kind.filter((k) => k === 'real').length : 0;
  const idToName = (id) => {
    const i = (preset.ids || []).indexOf(id);
    return i >= 0 ? preset.names[i] : id;
  };
  // 修补账里的条目名（两边共用同一套渲染，只有标题的说法不同）
  const REPAIR_TITLE = { point: '点接触对角线', flip: '翻边（分离三角形）' };
  return (
    <div className="stats">
      <h3>图</h3>
      <Row k="V / E / F" v={`${mesh.nv} / ${mesh.ne} / ${mesh.nf}`} />
      <Row k="外边界" v={`${mesh.boundary.length} 个点（${mesh.boundary
        .map((v) => (isMap ? preset.names[v] : v)).join(isMap ? ' → ' : ', ')}）`} />

      {isMap ? (
        <>
          <h3>{isFile ? '导入与修补（逐条公开）' : '地图数据（手写）'}</h3>
          <Row k={isFile ? '顶点' : '区域'} v={isFile
            ? `${mesh.nv} 个：原有 ${nReal} + 修补时插的人工点 ${mesh.nv - nReal}`
            : `${mesh.nv} 个：真实 ${nReal} + 人工块 ${mesh.nv - nReal}`} />
          <Row k={isFile ? '原有边' : '真实相邻'} v={`${cnt.real} 条（每条都在填充里贴边）`} cls="ok" />
          <Row k={isFile ? '人工点贴的边' : '人工块贴的边'} v={cnt.water + cnt.patch} />
          <Row k={isFile ? '补的边 / 点接触' : '人工边 / 点接触'} v={`${cnt.artificial} / ${cnt.point}`} />
          <div className="stat-list">
            <div className="stat-note">
              {isFile
                ? '下面每一条都是为了让这张图变成「外圈 4 个角点的圆盘三角剖分」而自动做的改动，'
                  + '全部公开：只有**原有边**是文件里本来就有的，其余都是修补出来的。'
                : '下面每一条都是对真实相邻关系的偏离，全部公开：人工块是真实地理实体'
                  + '（湖、海），人工边 / 点接触是纯拓扑障碍的最小修补，其余区域被合并或排除。'}
            </div>
            {preset.dummies.map((d) => (
              <div key={d.id}><b>人工块 {d.name}</b>［{KIND_LABEL[d.kind] || d.kind}］← {d.neighbours.map(idToName).join('、')}
                <div className="stat-why">{d.why}</div>
              </div>
            ))}
            {preset.extra.map((x) => (
              <div key={`${x.a}-${x.b}`}><b>{EDGE_LABEL[x.kind] || x.kind} {idToName(x.a)}–{idToName(x.b)}</b>
                <div className="stat-why">{x.why}</div>
              </div>
            ))}
            {preset.repairs.map((r, i) => (
              <div key={`p${i}`}><b>{REPAIR_TITLE[r.kind] || '修补'} {r.face.join('-')}</b>
                <div className="stat-why">{r.why}</div>
              </div>
            ))}
            {preset.merges.map((m, i) => (
              <div key={`m${i}`}><b>并入：{m.name} → {m.into}</b>
                <div className="stat-why">{m.why}</div>
              </div>
            ))}
            {preset.excluded.map((x, i) => (
              <div key={`x${i}`}><b>{isFile ? '被删掉的顶点' : '不在图里'}：{x.name}</b>
                <div className="stat-why">{x.why}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <h3>Ricci 流</h3>
      <Row k="收敛" v={flow.converged ? '是' : '否（见下）'} cls={flow.converged ? 'ok' : 'bad'} />
      <Row k="迭代次数" v={flow.iterations} />
      <Row k="max|K̄−K|" v={e(flow.err, 2)} />
      {!flow.converged ? <div className="stat-note">{flow.note}</div> : null}

      <h3>平直铺展</h3>
      <Row k="矩形 W × H" v={`${rr.W.toFixed(6)} × ${rr.H.toFixed(6)}`} />
      <Row k="本图长宽比" v={rr.aspect.toFixed(6)} />
      <Row k="填充用长宽比" v={aspect.used.toFixed(6)}
        cls={aspect.source === 'flow' ? 'ok' : undefined} />
      <Row k="长宽比来源" v={ASPECT_SRC[aspect.source] || aspect.source}
        cls={aspect.source === 'reference' ? 'bad' : undefined} />
      <Row k="边界直线偏差" v={e(rr.maxLineDevRel, 2)} />
      <Row k="角点直角偏差" v={e(rr.maxCornerDev, 2)} />
      {aspect.source === 'reference' ? (
        <div className="stat-note">
          长宽比只由输入四边形决定（共形模），与图的内部结构无关，所以这里直接取同一四边形在
          W₅ 上收敛到的值 {aspect.used.toFixed(12)}；本图铺展出来的 {aspect.flow.toFixed(6)} 因流未收敛而不可信。
        </div>
      ) : null}

      <h3>REL（矩形对偶的组合骨架）</h3>
      <Row k="解出" v={s.ok ? `是（图案 ${s.pattern}）` : '否'} cls={s.ok ? 'ok' : 'bad'} />
      <Row k="回溯次数" v={s.backtracks} />
      <Row k="与斜率标号一致" v={`${s.slopeAgree.same} / ${s.slopeAgree.total}`} />
      <Row k="公理校验" v={rel.check.ok ? '通过' : '不通过'} cls={rel.check.ok ? 'ok' : 'bad'} />
      <Row k="内点最小块" v={mesh.boundary.length === mesh.nv ? '（没有内点）' : rel.blocks.minBlocks} />
      <Row k="空块顶点" v={rel.blocks.vertsWithEmptyBlock} cls={rel.blocks.vertsWithEmptyBlock ? 'bad' : 'ok'} />

      <h3>铺满校验</h3>
      <Row k="矩形数" v={`${rects.length}（= V）`} cls={rects.length === mesh.nv ? 'ok' : 'bad'} />
      <Row k="面积和 − W·H" v={`相对误差 ${e(n.areaRelErr, 2)}`} />
      <Row k="两两不重叠" v={n.overlappingPairs === 0 ? '是' : `否（${n.overlappingPairs} 对）`} cls={n.overlappingPairs ? 'bad' : 'ok'} />
      <Row k="接触 ⇒ 有边" v={`缺 ${n.missingAdjacency} / 多 ${n.extraAdjacency}`} cls={n.missingAdjacency + n.extraAdjacency ? 'bad' : 'ok'} />
      <Row k="接触对（图上的边）" v={n.pairsTouching} />
      <Row k="十字点 / 自捏" v={`${n.crossPoints} / ${n.pinchPoints}`} cls={n.crossPoints + n.pinchPoints ? 'bad' : 'ok'} />
      <Row k="四角 = vS/vE/vN/vW" v={n.cornerMatch ? '对' : `错（${JSON.stringify(n.cornerGot)}）`} cls={n.cornerMatch ? 'ok' : 'bad'} />
      {n.boundaryOnFrame !== undefined ? (
        <Row k="边界点贴框 / 内点贴框"
          v={`${n.boundaryOnFrame} / ${n.wallVerts} · ${n.interiorOnFrame}`}
          cls={n.boundaryOnFrame === n.wallVerts && !n.interiorOnFrame ? 'ok' : 'bad'} />
      ) : null}
      <Row k="总校验" v={verify.ok ? '✓ 通过' : '✗ 失败'} cls={verify.ok ? 'ok' : 'bad'} />
      <Row k="层数（x × y）" v={`${packing.xLevels.length} × ${packing.yLevels.length}`} />
      <Row k="当前 W / H" v={`${W.toFixed(3)} / ${H.toFixed(3)}`} />

      {cp ? (
        <>
          <h3>圆盘填充（相切圆盘，四角 90°）</h3>
          <Row k="圆数" v={`${cp.mesh.nv}（= V）`} cls={cp.mesh.nv === mesh.nv ? 'ok' : 'bad'} />
          <Row k="相切对 = 图上边" v={`${a.tangentPairs} / ${mesh.ne}`} cls={a.tangentPairs === mesh.ne ? 'ok' : 'bad'} />
          <Row k="边相切误差 max" v={e(a.maxEdgeErr, 1)} cls={a.maxEdgeErr < 1e-9 ? 'ok' : 'bad'} />
          <Row k="两两不重叠 / 无多余相切" v={`${a.overlaps} / ${a.extraTangencies}`}
            cls={a.overlaps + a.extraTangencies ? 'bad' : 'ok'} />
          <Row k="最近的非边间隙" v={`${e(a.minGap, 1)}${a.minGapPair ? `（v${a.minGapPair[0]}–v${a.minGapPair[1]}）` : ''}`} />
          <Row k="角点角度和（4 个）" v={`${deg(cp.angles.cornerSums[0]).toFixed(6)}° ×4`}
            cls={cp.angles.cornerErr < 1e-12 ? 'ok' : 'bad'} />
          <Row k="角点 max|90° − 角度和|" v={`${e(cp.angles.cornerErr * 180 / Math.PI, 1)}°`}
            cls={cp.angles.cornerErr < 1e-12 ? 'ok' : 'bad'} />
          <Row k="墙点角度和" v={`${cp.angles.nWall} 个：${deg(cp.angles.wallMin).toFixed(6)}° … ${deg(cp.angles.wallMax).toFixed(6)}°（= 180°）`}
            cls={cp.angles.wallErr < 1e-12 ? 'ok' : 'bad'} />
          <Row k="内点角度和" v={`${cp.angles.nInt} 个：${deg(cp.angles.intMin).toFixed(6)}° … ${deg(cp.angles.intMax).toFixed(6)}°（= 360°）`}
            cls={cp.angles.intErr < 1e-12 ? 'ok' : 'bad'} />
          <Row k="外框 4 条边" v={cp.frame.chords.map((x) => x.toFixed(4)).join(' / ')} />
          <Row k="对边相等（矩形）" v={`偏差 ${e(cp.frame.oppositeErr, 1)}`}
            cls={cp.frame.oppositeErr < 1e-9 ? 'ok' : 'bad'} />
          <Row k="墙是直的（弦 = 折线）" v={`偏差 ${e(cp.frame.straightErr, 1)}`}
            cls={cp.frame.straightErr < 1e-9 ? 'ok' : 'bad'} />
          <Row k="四角转弯 = 90°" v={`偏差 ${e(cp.frame.turnErr * 180 / Math.PI, 1)}°`}
            cls={cp.frame.turnErr < 1e-9 ? 'ok' : 'bad'} />
          <Row k="外框对边比" v={cp.frame.aspect.toFixed(6)} />
          <Row k="边界半径比" v={cp.ratioBoundary.toFixed(1)} />
          <Row k="全部半径比 max/min" v={cp.ratio.toExponential(2)} />
          <Row k="K̄ 残差 max|K̄−K|" v={`${e(cp.err, 1)}（${cp.iterations} 步）`}
            cls={cp.converged ? 'ok' : 'bad'} />
          <Row k="耗时" v={`${cp.ms} ms`} />
          <div className="stat-note">
            同一套目标曲率（4 个角点 π/2、其余 0）配上相切度量 l_ij = r_i + r_j，解出来逐条可验：
            <b>图上相邻 ⟺ 正好相切</b>（误差 {e(a.maxEdgeErr, 1)}）、<b>非边不接触</b>（最近间隙 {e(a.minGap, 1)}）、
            <b>四角各 90°</b>、<b>墙点各 180°</b>（于是边界圆心链是直线，4 条链围成矩形 —— 上面对边、
            直线、转角三行就是它的三个数值判据）。
          </div>
          {degenerateNote(cp, cp.mesh) ? <div className="stat-note warn-note">{degenerateNote(cp, cp.mesh)}</div> : null}
          <div className="stat-note">
            这个填充只由三角剖分的组合结构决定：相切度量 l_ij = r_i + r_j 里没有坐标，
            所以拖动「输入四边形」「长宽比」都不会改变它（方块填充的长宽比才会变）。
          </div>
        </>
      ) : null}

      {verify.problems.length ? (
        <div className="stat-problems">{verify.problems.slice(0, 4).map((p, i) => <div key={i}>⚠ {p}</div>)}</div>
      ) : null}
    </div>
  );
}
