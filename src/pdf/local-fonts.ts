import { quoteFamily } from '@/lib/pdf/fonts';

/**
 * 本机已安装的中文字体（Local Font Access API，Chrome 103+）：
 * 首次调用要弹授权框，必须在用户点击里调用；授权后打开阅读器即可直接读取。
 */

interface FontData {
  family: string;
}

type QueryLocalFonts = () => Promise<FontData[]>;

const query = (): QueryLocalFonts | undefined => (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts?.bind(window);

export const localFontsSupported = () => query() !== undefined;

/** 已授权时返回 true（可以不经用户点击直接读取） */
export async function localFontsGranted(): Promise<boolean> {
  if (!localFontsSupported()) return false;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

const SAMPLE = '永和国字';

/**
 * 字体能否显示中文：同一段中文分别以 serif、sans-serif 兜底各画一次，
 * 字体自己有中文字形时两次都用它画，像素相同；没有时落到两种不同的默认中文字体上。
 */
function makeCjkTester(): (family: string) => boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const draw = (font: string) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `24px ${font}`;
    ctx.fillText(SAMPLE, 0, 26);
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  return (family) => {
    const a = draw(`${quoteFamily(family)},serif`);
    const b = draw(`${quoteFamily(family)},sans-serif`);
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) return false;
    return true;
  };
}

/** 本机能显示中文的字体族名（去重、排序）；未授权或不支持时抛错 */
export async function listCjkFonts(): Promise<string[]> {
  const fn = query();
  if (!fn) throw new Error('当前浏览器不支持读取本机字体，可用「手动输入」');
  // 拒绝授权时不报错，只返回空列表
  const all = await fn();
  if (all.length === 0) throw new Error('没有读到本机字体，可能拒绝了授权。可在地址栏左侧的网站设置里允许「字体」后重试');
  const families = [...new Set(all.map((f) => f.family))];
  const hasCjk = makeCjkTester();
  return families.filter(hasCjk).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
