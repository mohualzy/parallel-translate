import type { CaptionTrackInfo } from './subtitles';

/** YouTube 字幕功能在页面世界与内容脚本之间的消息约定 */

export const YOUTUBE_MATCHES = ['*://www.youtube.com/*'];

/** window.postMessage 的来源标记，用于过滤页面里其他脚本的消息 */
export const HOOK_SOURCE = 'ptx-youtube-hook';
export const CONTENT_SOURCE = 'ptx-youtube-content';

/** 页面世界 → 内容脚本：旁听到一次字幕请求的响应 */
export interface TimedtextMessage {
  source: typeof HOOK_SOURCE;
  type: 'timedtext';
  url: string;
  body: string;
  /** 旁听到的是自动字幕时附带播放器的字幕轨列表，供内容脚本挑选人工字幕 */
  tracks?: CaptionTrackInfo[];
}

/** 内容脚本 → 页面世界：内容脚本已就绪，请补发缓存的字幕 */
export interface ReadyMessage {
  source: typeof CONTENT_SOURCE;
  type: 'ready';
}

/** 内容脚本 → 页面世界：切换到指定的人工字幕轨（钩子只在收到这条指令时才改动播放器） */
export interface SelectTrackMessage {
  source: typeof CONTENT_SOURCE;
  type: 'select-track';
  vssId: string;
  languageCode: string;
}

export function isTimedtextUrl(url: string): boolean {
  return url.includes('/api/timedtext');
}
