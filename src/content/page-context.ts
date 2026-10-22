import type { PageContext } from '@/lib/messages';

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

/** 随翻译请求附带的页面上下文。title 由调用方传入原始标题（标签页标题可能已被翻译） */
export function pageContext(title: string = document.title): PageContext {
  return { title: title.trim(), summary: pageSummary() };
}
