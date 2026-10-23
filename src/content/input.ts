import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { SpaceTrigger, textForSpaceTrigger } from '@/lib/input-trigger';
import { getLanguage } from '@/lib/languages';
import { sendToBackground } from '@/lib/messages';
import type { Settings } from '@/lib/settings';
import { showToast } from './ui/toast';

/** 一次最多翻译的字数 */
export const MAX_INPUT_CHARS = 5000;
const TEXT_INPUT_TYPES = new Set(['text', 'search']);
/** 代码编辑器里连按空格多是缩进/对齐，不触发 */
const CODE_EDITORS = '.monaco-editor, .cm-editor, .CodeMirror, .ace_editor';

type TextControl = HTMLInputElement | HTMLTextAreaElement;
export type Editable = TextControl | HTMLElement;

function isTextControl(el: Editable): el is TextControl {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** 焦点所在元素，穿过 open shadow root */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** 元素是不是可以翻译的输入框；contenteditable 返回最外层的可编辑根。密码框、邮箱等一律不算 */
export function editableOf(el: Element | null): Editable | null {
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled ? el : null;
  }
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return null;
  let root = el;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE)$/;

/**
 * 输入框的完整文本。contenteditable 由一个个段落组成时（ProseMirror、Lexical），逐段取文本用单个换行连接：
 * innerText 会因段落外边距在段间多出空行，写回后每段之间多一个空段落。
 */
export function fullText(el: Editable): string {
  if (isTextControl(el)) return el.value;
  const nodes = [...el.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()));
  const blocks = nodes.length > 0 && nodes.every((n) => n instanceof HTMLElement && BLOCK_TAGS.test(n.tagName));
  if (!blocks) return el.innerText;
  return nodes.map((n) => (n as HTMLElement).innerText.replace(/\n$/, '')).join('\n');
}

/** 要翻译的范围：选区（有选中文字时）或整个输入框 */
export interface InputTarget {
  el: Editable;
  /** 发起时的全文，回来时内容变了就不写回 */
  snapshot: string;
  /** 待翻译文本（未去首尾空白） */
  text: string;
  whole: boolean;
  /** 输入框的选区；contenteditable 为 Range */
  start?: number;
  end?: number;
  range?: Range;
}

/** 读取输入框里要翻译的内容：有选中文字时只取选区 */
export function readTarget(el: Editable): InputTarget {
  const snapshot = fullText(el);
  if (isTextControl(el)) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (end > start && el.value.slice(start, end).trim()) {
      return { el, snapshot, text: el.value.slice(start, end), whole: false, start, end };
    }
    return { el, snapshot, text: snapshot, whole: true };
  }
  const sel = getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (range && !range.collapsed && el.contains(range.commonAncestorContainer) && range.toString().trim()) {
    return { el, snapshot, text: range.toString(), whole: false, range: range.cloneRange() };
  }
  return { el, snapshot, text: snapshot, whole: true };
}

/** 光标前后的文本，用于三次空格判定 */
function textAroundCaret(el: Editable): [string, string] | null {
  if (isTextControl(el)) {
    const at = el.selectionEnd ?? el.value.length;
    return [el.value.slice(0, at), el.value.slice(at)];
  }
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const caret = sel.getRangeAt(0);
  if (!el.contains(caret.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(el);
  before.setEnd(caret.endContainer, caret.endOffset);
  const after = document.createRange();
  after.selectNodeContents(el);
  after.setStart(caret.endContainer, caret.endOffset);
  return [before.toString(), after.toString()];
}

const normalize = (s: string) => s.replace(/[\s ]+/g, ' ').trim();
/** 校验富文本编辑器的写回结果：不计较空白多少，但换行要在（段落间 innerText 会多出空行） */
const normalizeLines = (s: string) =>
  s
    .replace(/[ \t ]*\n\s*/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .trim();

/** 富文本编辑器（Lexical 等）靠异步的 selectionchange 同步内部选区，选中后要等一下再写入 */
const SELECTION_SETTLE_MS = 50;
const settle = () => new Promise((resolve) => setTimeout(resolve, SELECTION_SETTLE_MS));

/** 绕过 React 等框架对 value 的缓存：用原型上的原生 setter 赋值，再派发 input 事件 */
function setNativeValue(el: TextControl, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 写回的结果：native 进入了浏览器撤销栈（Ctrl+Z 原生可撤销）；manual 由扩展记录原文自行撤销；
 * pasted 交给编辑器的粘贴处理（编辑器自己记撤销）；failed 没写进去。
 */
export type WriteResult = 'native' | 'manual' | 'pasted' | 'failed';

function selectTarget(target: InputTarget): Range | null {
  const { el } = target;
  el.focus();
  if (isTextControl(el)) {
    if (target.whole) el.setSelectionRange(0, el.value.length);
    else el.setSelectionRange(target.start ?? 0, target.end ?? 0);
    return null;
  }
  const range = target.whole || !target.range ? document.createRange() : target.range;
  if (target.whole || !target.range) range.selectNodeContents(el);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return range;
}

/** execCommand 已废弃，但仍是唯一能让写入进入浏览器撤销栈、并被各种框架感知的方式 */
function insertText(text: string): boolean {
  return document.execCommand?.('insertText', false, text) ?? false;
}

/** 派发合成粘贴事件：浏览器不会执行默认粘贴，只有自己处理粘贴的编辑器（Lexical、Slack、Draft.js）会写入 */
function pasteText(el: HTMLElement, text: string) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

/** 把译文写回输入框，依次尝试几种方式，每步读回校验（见设计文档「写回」） */
export async function writeBack(target: InputTarget, replacement: string): Promise<WriteResult> {
  const { el } = target;
  if (isTextControl(el)) {
    const expected = target.whole
      ? replacement
      : el.value.slice(0, target.start) + replacement + el.value.slice(target.end);
    selectTarget(target);
    if (insertText(replacement) && el.value === expected) return 'native';
    const caret = (target.whole ? 0 : (target.start ?? 0)) + replacement.length;
    setNativeValue(el, expected);
    el.setSelectionRange(caret, caret);
    return el.value === expected ? 'manual' : 'failed';
  }

  const want = normalizeLines(replacement);
  const written = () => {
    const now = normalizeLines(el.innerText);
    return target.whole ? now === want : now.includes(want);
  };
  // 多行内容：Lexical 等编辑器用 insertText 写入会丢掉换行，先试粘贴（编辑器按行解析，也能一次撤销）
  const attempts: [WriteResult, () => void][] = [
    ['native', () => insertText(replacement)],
    ['pasted', () => pasteText(el, replacement)],
  ];
  if (replacement.includes('\n')) attempts.reverse();
  for (const [result, attempt] of attempts) {
    selectTarget(target);
    await settle();
    attempt();
    if (written()) return result;
    // 选区替换失败后原 Range 可能已失效，不再尝试下一种
    if (!target.whole) return 'failed';
  }
  return 'failed';
}

/** 走 manual 写回时由扩展记录的一次撤销 */
interface UndoRecord {
  el: TextControl;
  before: string;
  after: string;
}

/**
 * 输入框翻译：Alt+I 或末尾连按三次空格，
 * 把焦点输入框的内容（或其中的选区）译成 inputTargetLang 后写回。
 */
export class InputTranslator {
  private readonly spaces = new SpaceTrigger();
  private lastTarget: EventTarget | null = null;
  private busy = false;
  private undo?: UndoRecord;

  constructor(
    private readonly ctx: ContentScriptContext,
    private readonly settings: () => Settings,
  ) {
    document.addEventListener('input', (e) => this.onInput(e as InputEvent), true);
    document.addEventListener('keydown', (e) => this.onKeyDown(e), true);
  }

  /** Alt+I：只有拿着焦点的 frame 响应（命令会发给标签页的所有 frame） */
  translateFocused() {
    if (!document.hasFocus()) return;
    const el = editableOf(deepActiveElement());
    if (!el) {
      void showToast(this.ctx, '请先点进一个输入框再按快捷键');
      return;
    }
    void this.run(readTarget(el), false);
  }

  private onInput(e: InputEvent) {
    const target = e.composedPath()[0] ?? null;
    if (target !== this.lastTarget) {
      this.spaces.reset();
      this.lastTarget = target;
    }
    // 用户自己改了内容，扩展记录的撤销作废
    if (this.undo && e.isTrusted) this.undo = undefined;
    const hit = this.spaces.feed({
      inputType: e.inputType ?? '',
      data: e.data ?? null,
      isComposing: e.isComposing,
      isTrusted: e.isTrusted,
      timeStamp: e.timeStamp,
    });
    if (!hit || !this.settings().inputSpaceTrigger) return;
    const el = editableOf(target instanceof Element ? target : null);
    if (!el || el.closest(CODE_EDITORS)) return;
    const around = textAroundCaret(el);
    if (!around || textForSpaceTrigger(around[0], around[1]) === null) return;
    // 整框翻译，末尾的触发空格一并替换掉
    void this.run({ el, snapshot: fullText(el), text: fullText(el), whole: true }, true);
  }

  private onKeyDown(e: KeyboardEvent) {
    const undo = this.undo;
    if (!undo || e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (!e.composedPath().includes(undo.el) || undo.el.value !== undo.after) return;
    e.preventDefault();
    this.undo = undefined;
    setNativeValue(undo.el, undo.before);
  }

  private async run(target: InputTarget, dropTrailing: boolean) {
    const lang = getLanguage(this.settings().inputTargetLang).name;
    const core = target.text.trim();
    if (!core) return;
    if (this.busy) {
      void showToast(this.ctx, '上一次输入框翻译还没完成');
      return;
    }
    if (core.length > MAX_INPUT_CHARS) {
      void showToast(this.ctx, `内容超过 ${MAX_INPUT_CHARS} 字，请选中一部分再按 Alt+I`);
      return;
    }
    this.busy = true;
    void showToast(this.ctx, `正在翻译成 ${lang}…`, 60_000);
    try {
      const translated = await sendToBackground({ type: 'translate-input', text: core });
      if (fullText(target.el) !== target.snapshot) {
        void showToast(this.ctx, '输入框内容已改变，没有写入译文');
        return;
      }
      if (normalize(translated) === normalize(core)) {
        void showToast(this.ctx, `内容已经是 ${lang}，无需翻译`);
        return;
      }
      const lead = target.text.match(/^\s*/)?.[0] ?? '';
      const trail = dropTrailing ? '' : (target.text.match(/\s*$/)?.[0] ?? '');
      const replacement = lead + translated + trail;
      const result = await writeBack(target, replacement);
      if (result === 'manual' && isTextControl(target.el)) {
        this.undo = { el: target.el, before: target.snapshot, after: target.el.value };
      }
      if (result === 'failed') await this.fallbackToClipboard(translated);
      else void showToast(this.ctx, `已翻译成 ${lang}，按 Ctrl+Z 撤销`);
    } catch (err) {
      void showToast(this.ctx, `输入框翻译失败：${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      this.busy = false;
    }
  }

  private async fallbackToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      void showToast(this.ctx, '这个输入框不支持自动写入，译文已复制到剪贴板，请手动粘贴', 6000);
    } catch {
      void showToast(this.ctx, `这个输入框不支持自动写入，译文：${text}`, 10_000);
    }
  }
}
