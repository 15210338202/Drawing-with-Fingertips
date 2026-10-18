/**
 * 风格知识库的共享规则常量。
 *
 * 为什么单独一个文件：`validate-styles.mjs`（校验）和 `styles-from-csv.mjs`（转换）
 * 必须用**同一套**词表和禁用词，否则会出现「转换器放行、校验器报错」的怪事。
 * 改这里等于同时改两个脚本，改完请重跑 `node scripts/validate-styles.mjs`。
 */

/**
 * 大类：用户选风格时的「心理入口」，可以是流派、地域或媒材。
 *
 * 注意：这里**故意混了流派（国风/超现实）与媒材（水彩/油画/像素）**。
 * 因为孩子会想"我要水彩的"，也会想"我要国风的"——硬按艺术学分类反而难用。
 * 它服务的不是艺术史，是「用户能不能快速找到想试的画风」。
 *
 * 共 18 类，分 5 族（见 CATEGORY_GROUP）。新增要同时改 PREFIX 与 EN。
 */
export const CATEGORIES = [
  // 东方传统
  '国风', '川渝', '民俗',
  // 西方古典与近代
  '古典西画', '印象派', '油画',
  // 现代与当代
  '现代主义', '抽象', '超现实', '波普', '极简',
  // 童趣与治愈
  '绘本', '治愈', '梦幻', '水彩',
  // 数字与亚文化
  '二次元', '像素', '赛博',
]

/** UI 分组用的「族」：前端按它做两级筛选，不需要在 JSON 里存字段 */
export const CATEGORY_GROUP = {
  东方传统: ['国风', '川渝', '民俗'],
  西方古典与近代: ['古典西画', '印象派', '油画'],
  现代与当代: ['现代主义', '抽象', '超现实', '波普', '极简'],
  童趣与治愈: ['绘本', '治愈', '梦幻', '水彩'],
  数字与亚文化: ['二次元', '像素', '赛博'],
}

/** 大类 → styleKey 前缀（自动生成 id 用）。已有类别的前缀不要改，否则老条目 id 会漂。 */
export const CATEGORY_PREFIX = {
  国风: 'gf',
  川渝: 'cy',
  民俗: 'ms',
  古典西画: 'cl',
  印象派: 'im',
  油画: 'ol',
  现代主义: 'md',
  抽象: 'ab',
  超现实: 'su',
  波普: 'pp',
  极简: 'mn',
  绘本: 'hb',
  治愈: 'zy',
  梦幻: 'mh',
  水彩: 'wc',
  二次元: 'an',
  像素: 'px',
  赛博: 'sf',
}

/** 大类 → styleKey 的英文段（自动生成 styleKey 用） */
export const CATEGORY_EN = {
  国风: 'guofeng',
  川渝: 'chuanyu',
  民俗: 'folk',
  古典西画: 'classical',
  印象派: 'impressionist',
  油画: 'oil',
  现代主义: 'modernist',
  抽象: 'abstract',
  超现实: 'surreal',
  波普: 'pop',
  极简: 'minimal',
  绘本: 'picturebook',
  治愈: 'healing',
  梦幻: 'dream',
  水彩: 'watercolor',
  二次元: 'anime',
  像素: 'pixel',
  赛博: 'cyber',
}

/** 题材词表：供前端「你想画什么？」筛选器用。 */
export const THEMES = ['动物', '人物', '自然', '风景', '城市', '静物', '抽象', '幻想', '日常', '传统', '未来', '游戏']

/**
 * 硬题材名词：出现在 styleModifiers 里 = 必错。
 * 依据 2026-10-18 的 X2 组实验：画风提示词里的 "misty mountains" 会被真的画进背景。
 */
export const HARD_SUBJECTS = [
  'cat', 'dog', 'bird', 'fish', 'panda', 'rabbit', 'fox', 'bear', 'horse', 'deer', 'tiger', 'dragon',
  'flower', 'tree', 'leaf', 'house', 'car', 'person', 'people', 'man', 'woman', 'child', 'kids',
  'face', 'mask', 'building', 'boat', 'mountain', 'river', 'street', 'alley', 'hotpot', 'food',
  'animal', 'character', 'sketch of',
]

/** 体裁 / 场景词：会带偏构图，警告即可（个别体裁名可接受）。 */
export const SOFT_SCENE = ['landscape', 'scene', 'portrait', 'cityscape', 'background', 'still life', 'skyline', 'interior']

/** 判断某个词是否作为独立单词出现在文本里（避免 "cat" 误伤 "catalog"）。 */
export function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(text)
}

/** 把中文顿号/逗号/斜杠/空格分隔的多值字段拆成数组，去重去空。 */
export function splitMulti(value) {
  return [...new Set(
    String(value ?? '')
      .split(/[、,，;；/|\s]+/)
      .map(s => s.trim())
      .filter(Boolean),
  )]
}
