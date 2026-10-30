import { pickLyrics, type Lyrics, type LyricsRecord } from '@/lib/lyrics';
import * as cache from './cache';

const API = 'https://lrclib.net/api/search';
const TIMEOUT_MS = 5000;

async function search(params: Record<string, string>): Promise<LyricsRecord[]> {
  const url = new URL(API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { 'Lrclib-Client': 'parallel-translate' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return (await res.json()) as LyricsRecord[];
}

/**
 * 查同步歌词（硬性规则 8：只发歌手和歌名）。先按歌手、歌名精确查，查不到再全文搜索。
 * 只缓存查到的结果：查不到的歌以后可能被收录。
 */
export async function lookupLyrics(artist: string, track: string, seconds: number, lang: string): Promise<Lyrics | null> {
  const key = await cache.sha256(JSON.stringify(['lyrics', artist, track, lang]));
  const hit = (await cache.getMany([key])).get(key);
  if (hit !== undefined) return JSON.parse(hit) as Lyrics;
  const lyrics =
    pickLyrics(await search({ artist_name: artist, track_name: track }), seconds, lang) ??
    pickLyrics(await search({ q: `${artist} ${track}` }), seconds, lang);
  if (!lyrics) return null;
  await cache.setMany([[key, JSON.stringify(lyrics)]]).catch(() => undefined);
  return lyrics;
}
