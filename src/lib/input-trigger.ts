/** 输入框连按三次空格触发翻译的判定（见 docs/specs/2026-10-23-input-translate-design.md） */

export const SPACE_TRIGGER_COUNT = 3;
/** 相邻两次空格的最大间隔 */
export const SPACE_TRIGGER_GAP_MS = 800;

export interface InputEventInfo {
  inputType: string;
  data: string | null;
  isComposing: boolean;
  isTrusted: boolean;
  timeStamp: number;
}

/** 连续空格计数器：只认可信的、非组合输入的 insertText ' '，中间夹着别的输入或停顿太久就清零 */
export class SpaceTrigger {
  private count = 0;
  private last = 0;

  /** 喂一个 input 事件；凑满三次返回 true 并清零 */
  feed(e: InputEventInfo): boolean {
    const space = e.isTrusted && !e.isComposing && e.inputType === 'insertText' && e.data === ' ';
    if (!space) {
      this.count = 0;
      return false;
    }
    this.count = this.count > 0 && e.timeStamp - this.last <= SPACE_TRIGGER_GAP_MS ? this.count + 1 : 1;
    this.last = e.timeStamp;
    if (this.count < SPACE_TRIGGER_COUNT) return false;
    this.count = 0;
    return true;
  }

  reset() {
    this.count = 0;
  }
}

const TRAILING_SPACES = new RegExp(`[ \\u00a0]{${SPACE_TRIGGER_COUNT}}$`);

/**
 * 光标前后的文本是否满足触发条件：光标前以三个空格结尾、光标后没有内容、光标所在行不是纯空白（行首空格是缩进）。
 * 返回去掉触发空格后要翻译的全文；不满足时返回 null。
 */
export function textForSpaceTrigger(before: string, after: string): string | null {
  if (!TRAILING_SPACES.test(before) || after.trim() !== '') return null;
  const body = before.slice(0, -SPACE_TRIGGER_COUNT);
  const line = body.slice(body.lastIndexOf('\n') + 1);
  if (line.trim() === '') return null;
  return body.trim() === '' ? null : body;
}
