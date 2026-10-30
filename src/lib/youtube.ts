import type { CaptionTrackInfo } from './subtitles';

/** YouTube 字幕功能在页面世界与内容脚本之间的消息约定 */

export const YOUTUBE_MATCHES = ['*://www.youtube.com/*'];

/** window.postMessage 的来源标记，用于过滤页面里其他脚本的消息 */
export const HOOK_SOURCE = 'ptx-youtube-hook';
export const CONTENT_SOURCE = 'ptx-youtube-content';

/** 页面世界 → 内容脚本：旁听到一次播放器字幕请求的响应，或按 fetch-track 拉到的字幕 */
export interface TimedtextMessage {
  source: typeof HOOK_SOURCE;
  type: 'timedtext';
  url: string;
  /** 拉取失败时为空 */
  body: string;
  /** 按 fetch-track 拉到的（不是播放器自己的请求） */
  fetched?: boolean;
  /** 播放器请求时附带：视频的字幕轨列表，供内容脚本挑原文轨 */
  tracks?: CaptionTrackInfo[];
  /** 播放器请求时附带：视频标题和简介，没有自动字幕时用来判断视频语音的语言 */
  videoText?: string;
}

/** 内容脚本 → 页面世界：内容脚本已就绪，请补发缓存的字幕 */
export interface ReadyMessage {
  source: typeof CONTENT_SOURCE;
  type: 'ready';
}

/** 内容脚本 → 页面世界：拉取这条字幕（地址已带上播放器请求里的令牌参数，见 sourceTrackUrl） */
export interface FetchTrackMessage {
  source: typeof CONTENT_SOURCE;
  type: 'fetch-track';
  url: string;
}

export function isTimedtextUrl(url: string): boolean {
  return url.includes('/api/timedtext');
}
