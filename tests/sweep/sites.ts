/**
 * 多站点回归检查用的网站：覆盖百科、代码托管、文档站、新闻、问答、论坛、博客、单页应用等不同结构。
 * 选的是内容相对稳定的页面；网站改版后换成同类型的页面即可，名字用作截图文件名。
 */
export const SITES: [name: string, url: string][] = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Large_language_model'],
  ['github', 'https://github.com/microsoft/vscode'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/CSS/display'],
  ['hn', 'https://news.ycombinator.com/'],
  ['bbc', 'https://www.bbc.com/news'],
  // 论坛（Discourse 单页应用）；Stack Overflow 在自动化浏览器里多半停在 Cloudflare 人机验证页，测不到内容
  ['discourse', 'https://discuss.python.org/latest'],
  ['python-docs', 'https://docs.python.org/3/tutorial/classes.html'],
  ['react', 'https://react.dev/learn'],
  // 博客列表；blog.cloudflare.com 在自动化浏览器里加载超过 30 秒，测不到
  ['rust-blog', 'https://blog.rust-lang.org/'],
  ['reddit', 'https://www.reddit.com/r/programming/'],
  ['theverge', 'https://www.theverge.com/'],
  ['arxiv-abs', 'https://arxiv.org/abs/1706.03762'],
  ['arxiv-html', 'https://arxiv.org/html/1706.03762v7'],
  ['kubernetes', 'https://kubernetes.io/docs/concepts/overview/'],
  ['anthropic', 'https://www.anthropic.com/news'],
];
