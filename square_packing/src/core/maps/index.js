// 两个真实地图的例子：美国各州 / 中国各省 → 方块填充。
//
// 这两个预设和 presets.js 里的那几个**完全同构**：buildMapGraph 的输出就是
// runPipeline 能直接吃的 preset（nv / faces / corners / quad 都在里面），
// 所以界面、校验、长宽比逻辑没有任何特殊分支 —— 唯一多出来的是给人看的元数据
// （names / kind / geo / repairs / merges / excluded）。
import { buildMapGraph, mapSummary } from '../mapgraph.js';
import { US } from './us.js';
import { CN } from './cn.js';

export { mapSummary };

/** 手写数据（自检脚本要拿它跟算出来的图逐条对账）。*/
export const MAP_DATA = [US, CN];

/** 两个地图预设（模块加载时构建一次；每个几十毫秒）。*/
export const MAP_PRESETS = MAP_DATA.map((d) => buildMapGraph(d));

/** chip 上显示的名字。*/
export const MAP_CHIPS = ['美国', '中国'];

/**
 * 这条边是不是「不是真实相邻」的边（人工块 / 人工边 / 点接触）。
 * 非地图预设返回 null。
 * @returns {{kind:string, why:string}|null}
 */
export function edgeRepairOf(preset, a, b) {
  if (!preset || !preset.edgeKind || !preset.nv) return null;
  const key = a < b ? a * preset.nv + b : b * preset.nv + a;
  const k = preset.edgeKind.get(key);
  if (!k || k === 'real') return null;
  return { kind: k, why: preset.edgeWhy?.get(key) || '' };
}

/** 顶点类型：'real' 是真实区域，'water' / 'patch' 是人工块。非地图返回 'real'。*/
export function vertexKindOf(preset, v) {
  return preset?.kind?.[v] || 'real';
}

/** 顶点名（非地图返回 undefined）。*/
export function vertexNameOf(preset, v) {
  return preset?.names?.[v];
}

export const KIND_LABEL = { real: '真实区域', water: '人工水域块', patch: '人工补块' };
export const EDGE_LABEL = { water: '贴人工水域块', patch: '贴人工补块', artificial: '人工边（补的）', point: '点接触（只交于一点）' };
