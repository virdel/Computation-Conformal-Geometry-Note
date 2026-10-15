// 全流程串起来：
//   输入图（Tutte 嵌入，4 个角点钉在一个凸四边形上）
//   → 离散 Ricci 流（目标曲率：角点 π/2，其余 0）
//   → 等距铺展成矩形
//   → 由斜率符号定 REL
//   → union-find + 最长路造矩形对偶
//   → 逐条校验填充
//
// 默认四边形特意画成不是矩形：这样角点初始不是 π/2，Ricci 流才真的有活干。
// 输入四边形的形状决定了共形模（长宽比），和图的内部结构无关。

import { Mesh } from './mesh.js';
import { tutteEmbed, orientCCW } from './embed.js';
import { ricciFlow } from './ricci.js';
import { develop, cornerOrder, normalizeFrame, rectangleResiduals } from './unfold.js';
import { solveREL, addOuterEdges, checkREL, blockSummary, wallChains } from './rel.js';
import { buildRectangles } from './rectdual.js';
import { verifyPacking } from './verify.js';
import { PRESETS } from './presets.js';

/** 默认输入四边形（凸、非矩形、非平行四边形）。*/
export const DEFAULT_QUAD = [[0, 0], [1.35, 0.12], [1.08, 1.42], [-0.08, 0.86]];

/** 正方形输入（这时流没事干 —— 输入已经满足 π/2）。*/
export const SQUARE_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** 按强度 t ∈ [0,1] 在正方形和默认斜四边形之间插值。*/
export function quadBlend(t) {
  const a = SQUARE_QUAD, b = DEFAULT_QUAD;
  return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
}

/**
 * 「输入四边形」滑杆：t = 0 是正方形（角点本来就是 π/2，Ricci 流没事干），
 * t = 1 是这张图自己的四边形 —— 老预设用 DEFAULT_QUAD，地图用它自己的地理四边形
 * （由 4 个角点的经纬度归一化得到，见 mapgraph.js 的 quadFromGeo，
 * 这样填充的长宽比看起来和这块「真实四边形」的共形模一致）。
 *
 * 两个凸四边形的对应顶点做凸组合还是凸的（这里是逐顶点插值，且两端的绕序相同），
 * 所以插值出来的边界圈永远合法，Tutte 嵌入不会因此翻面。
 */
export function quadForPreset(preset, t = 1) {
  const b = (preset && preset.quad) || DEFAULT_QUAD;
  const a = SQUARE_QUAD;
  return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
}

/**
 * 由铺展后的坐标认四个角点的角色：左下 = S、右下 = E、右上 = N、左上 = W。
 * （铺展框架已经把 order[0] 放到原点、order[1] 放到 x 轴上，所以直接按坐标就近认。）
 * @returns {{S:number,E:number,N:number,W:number}}
 */
export function cornerRoles(flat, order, W, H) {
  const near = (v, x, y) => Math.hypot(flat[v][0] - x, flat[v][1] - y);
  const pick = (x, y) => order.reduce((best, v) => (near(v, x, y) < near(best, x, y) ? v : best), order[0]);
  return { S: pick(0, 0), E: pick(W, 0), N: pick(W, H), W: pick(0, H) };
}

/**
 * 长宽比的「参考值」：**长宽比只由输入四边形决定，和图的内部结构无关**
 * （实测：8 个预设 + 所有收敛的随机图给出的长宽比全都是 1.233827475168，
 *  即该四边形的共形模；见 README 的校验表）。
 *
 * 于是当某张图上的流没收敛（离散共形类的平直度量落在需要翻边的剖分上，见
 * ricci.js 里的说明），填充用的长宽比仍然可以从小图上取 —— 用最小的预设 W₅
 * 在**同一个四边形**上跑一次流即可（毫秒级，结果按四边形缓存）。
 *
 * @returns {number|null} 取不到（小图上也没收敛）时返回 null
 */
const aspectCache = new Map();
export function referenceAspect(quad = DEFAULT_QUAD) {
  const key = quad.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
  if (!aspectCache.has(key)) {
    const r = runPipeline(PRESETS[0], { quad, useReferenceAspect: false });
    aspectCache.set(key, r.flow.converged ? r.rectResidual.aspect : null);
  }
  return aspectCache.get(key);
}

/** 把循环序旋转到从 v 开始。*/
function rotateToStart(list, v) {
  const i = list.indexOf(v);
  return i < 0 ? list.slice() : list.slice(i).concat(list.slice(0, i));
}

/**
 * 输入图：Tutte 嵌入（外边界钉在输入四边形上）+ 定向。方块填充、圆盘填充共用这一份 ——
 * 两个填充只是往同一张 Mesh 上换一套度量，输入完全一样。
 *
 * @param {{faces:number[][], nv:number, corners?:object, quad?:number[][]}} preset
 *   preset.corners：地图这类「外边界有 k > 4 个点」的图**必须**给，声明哪 4 个顶点
 *   是 S/E/N/W；给了它就断言铺展出来的次序与它一致（防止把镜像的四边形吃进去）。
 * @param {{quad?:number[][], refine?:number}} opts
 */
export function buildInputMesh(preset, opts = {}) {
  const { quad = preset.quad || DEFAULT_QUAD, refine = 3 } = opts;
  const dec = preset.corners ?? null;
  const declaredCCW = dec ? [dec.S, dec.E, dec.N, dec.W] : null;
  const emb = tutteEmbed(preset.faces, preset.nv,
    { refine, shape: 'quad', quad, corners: declaredCCW });
  const faces = orientCCW(emb.verts, preset.faces);
  const mesh = new Mesh(emb.verts, faces);
  const corners = declaredCCW ? declaredCCW.slice() : mesh.boundary.slice();
  return {
    emb, faces, mesh, corners, declaredCCW, quad,
    inputEmbedding: mesh.checkEmbedding(),
  };
}

/**
 * @param {{id:string,name:string,nv:number,faces:number[][],
 *          corners?:{S:number,E:number,N:number,W:number}, quad?:number[][]}} preset
 * @param {{quad?:number[][], tol?:number, refine?:number, aspect?:number|null,
 *          useReferenceAspect?:boolean}} opts
 */
export function runPipeline(preset, opts = {}) {
  const { quad = preset.quad || DEFAULT_QUAD, tol = 1e-12, refine = 3, aspect = null,
    useReferenceAspect = true } = opts;

  // ---- 1. 输入图 ----
  const { emb, faces, mesh, corners, declaredCCW, inputEmbedding } = buildInputMesh(preset, { quad, refine });

  // ---- 2. Ricci 流 ----
  const flow = ricciFlow(mesh, { corners, tol, maxIter: 300 });

  // ---- 3. 铺展 ----
  const { pos } = develop(mesh);
  const orderRaw = cornerOrder(mesh, corners);
  const order = declaredCCW ? rotateToStart(orderRaw, corners[0]) : orderRaw;
  if (declaredCCW && order.some((v, i) => v !== corners[i])) {
    throw new Error(`runPipeline: 铺展出来的角点逆时针次序 [${order.join(', ')}] `
      + `与数据声明的 [${corners.join(', ')}] 不一致（多半是外边界圈的方向反了）`);
  }
  const flat = normalizeFrame(pos, order);
  const rectResidual = rectangleResiduals(flat, mesh, order);

  // ---- 4. 角点角色 + 解 REL ----
  // 老预设（4 个边界点）沿用「按铺展坐标就近认角色」；地图用数据声明的角色，
  // 同时把就近认出来的那一份记下来做交叉核对。
  const rolesGeo = cornerRoles(flat, order, rectResidual.W, rectResidual.H);
  const c = declaredCCW
    ? { S: order[0], E: order[1], N: order[2], W: order[3] }
    : rolesGeo;
  const cornerRolesDeclared = declaredCCW
    ? { declared: { ...c }, geo: rolesGeo, agrees: ['S', 'E', 'N', 'W'].every((k) => rolesGeo[k] === c[k]) }
    : null;

  const solved = solveREL(mesh, flat, c);
  const edgeColorFull = addOuterEdges(mesh, solved.edgeColor, c);
  const relCheck = checkREL(mesh, edgeColorFull, c);
  const relOk = solved.ok && relCheck.ok;
  const rel = {
    edgeColor: edgeColorFull, check: relCheck, solved,
    blocks: blockSummary(mesh, edgeColorFull), relOk,
  };

  // ---- 5. 矩形对偶 ----
  const walls = wallChains(mesh, c, flat);
  const packing = buildRectangles(mesh, edgeColorFull, walls);
  let rects = packing.rects;
  let W = packing.W, H = packing.H;

  // 填充用的长宽比。优先级：显式指定 > 本图流算出来的 > 同四边形的参考值。
  // 把长宽比拉到指定值只是 x 方向整体缩放（层间距自由），组合结构不变。
  let aspectUsed = rectResidual.aspect;
  let aspectSource = 'flow';
  if (aspect) {
    aspectUsed = aspect;
    aspectSource = 'override';
  } else if (!flow.converged && useReferenceAspect) {
    const ref = referenceAspect(quad);
    if (ref) { aspectUsed = ref; aspectSource = 'reference'; }
    else aspectSource = 'flow（未收敛）';
  }
  if (H > 0 && Math.abs(aspectUsed / (W / H) - 1) > 1e-15) {
    const s = aspectUsed / (W / H);
    rects = rects.map((r) => ({ ...r, x1: r.x1 * s, x2: r.x2 * s }));
    W *= s;
  }

  // ---- 6. 校验 ----
  const verification = verifyPacking(mesh, rects, W, H, c, walls);

  return {
    preset, quad,
    input: { verts: emb.verts, faces, planarity: emb.planarity, embedding: inputEmbedding },
    mesh, corners, cornersCCW: emb.cornersCCW, walls,
    flow, flat, order, c, cornerRolesDeclared,
    rel,
    // aspectFlow = 本图流铺展出来的长宽比；aspect = 实际用来定填充形状的那个
    aspect: { used: aspectUsed, source: aspectSource, flow: rectResidual.aspect },
    packing: { ...packing, rects, W, H },
    rectResidual,
    verification,
  };
}

/** 一句人话总结（给界面/终端用）。*/
export function summarize(result) {
  const f = result.flow, v = result.verification;
  return {
    converged: f.converged,
    flowNote: f.note,
    flowErr: f.err,
    flowIters: f.iterations,
    aspect: result.aspect.used,
    aspectSource: result.aspect.source,
    aspectFlow: result.aspect.flow,
    rectLineDev: result.rectResidual.maxLineDevRel,
    rectCornerDev: result.rectResidual.maxCornerDev,
    relOk: result.rel.relOk,
    packingOk: v.ok,
    packingProblems: v.problems,
  };
}
