/**
 * PDF 译文的中文字体栈（设置项 Settings.pdfCjkFont，决策见 D56）。
 * 只决定中文用什么字体；英文、数字仍优先用 PDF 原字体（见 pdf/draw.ts）。
 */

/** 内置预设：设置值以 @ 开头，其他非空值是字体族名 */
export const CJK_PRESETS = {
  '@song': '宋体',
  '@hei': '黑体',
  '@kai': '楷体',
  '@fang': '仿宋',
} as const;

export type CjkPreset = keyof typeof CJK_PRESETS;

/**
 * Windows 版 Noto / 思源的族名是 Noto Serif SC、Source Han Serif SC，
 * macOS / Linux 发行版常见的是 Noto Serif CJK SC，两种都要写。
 */
const STACKS: Record<CjkPreset, string> = {
  '@song': '"Songti SC","Noto Serif SC","Noto Serif CJK SC","Source Han Serif SC","SimSun",serif',
  '@hei': '"PingFang SC","Microsoft YaHei","Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC",sans-serif',
  '@kai': '"Kaiti SC","STKaiti","KaiTi","楷体",serif',
  '@fang': '"STFangsong","FangSong","仿宋",serif',
};

const KAI_NAME = /kai|楷/i;

export const isPreset = (value: string): value is CjkPreset => value in STACKS;

/** CSS 字体族名加引号；名字里的引号、反斜杠去掉（字体名里本不该有） */
export const quoteFamily = (name: string) => `"${name.replace(/["\\]/g, '').trim()}"`;

/** 设置值是不是楷体类：主字体是楷体时，斜体改用仿宋表示，否则强调看不出来 */
function isKai(value: string): boolean {
  return value === '@kai' || (!isPreset(value) && KAI_NAME.test(value));
}

/**
 * 中文字体栈。auto（设置为空）时按原文选：无衬线用黑体，否则宋体。
 * 原文斜体处用楷体（中文排版里强调、引文的习惯写法）。
 * 自定义字体后面接自动的字体栈，字体里缺的字（生僻字、符号）由它兜底。
 */
export function cjkStack(setting: string, style: { sans: boolean; italic: boolean }): string {
  const value = setting.trim();
  const auto = style.sans ? STACKS['@hei'] : STACKS['@song'];
  if (style.italic) return isKai(value) ? STACKS['@fang'] : STACKS['@kai'];
  if (value === '') return auto;
  if (isPreset(value)) return STACKS[value];
  return `${quoteFamily(value)},${auto}`;
}

/** 设置值在界面上的名字 */
export function cjkFontLabel(setting: string): string {
  const value = setting.trim();
  if (value === '') return '自动';
  return isPreset(value) ? CJK_PRESETS[value] : value;
}
