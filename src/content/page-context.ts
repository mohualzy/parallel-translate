import type { PageContext } from '@/lib/messages';
import { autoProfile, resolveProfile, type ProfileId } from '@/lib/profiles';

const SUMMARY_MAX = 300;

/** 按 name / property 取 meta 内容，名称不区分大小写（有些站点写成 name="Description"） */
function metaContent(attr: 'name' | 'property', value: string): string {
  for (const meta of document.querySelectorAll<HTMLMetaElement>(`meta[${attr}]`)) {
    if (meta.getAttribute(attr)?.toLowerCase() === value) return meta.content.trim();
  }
  return '';
}

/** 页面摘要：meta description，退而取 og:description */
export function pageSummary(): string {
  const text = metaContent('name', 'description') || metaContent('property', 'og:description');
  return text.replace(/\s+/g, ' ').slice(0, SUMMARY_MAX);
}

/** 页面是不是论文：arXiv、期刊、会议论文页普遍用 citation_* meta 标注书目信息（Google Scholar 规范） */
export function hasCitationMeta(): boolean {
  return document.querySelector('meta[name="citation_title"]') !== null;
}

/** 当前页面的翻译风格档案（用户为网站指定的优先） */
export function pageProfile(siteProfiles: Record<string, string>): ProfileId {
  return resolveProfile(location.hostname, siteProfiles, hasCitationMeta());
}

/** 不考虑用户指定时，当前页面自动选择的档案（弹窗显示「自动（当前：…）」） */
export function pageAutoProfile(): ProfileId {
  return autoProfile(location.hostname, hasCitationMeta());
}

/** 随翻译请求附带的页面上下文。title 由调用方传入原始标题（标签页标题可能已被翻译） */
export function pageContext(title: string = document.title, siteProfiles: Record<string, string> = {}): PageContext {
  return { title: title.trim(), summary: pageSummary(), profile: pageProfile(siteProfiles) };
}
