import './style.css';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { YouTubeSubtitles } from '@/content/subtitles/youtube';
import { YOUTUBE_MATCHES } from '@/lib/youtube';

// YouTube 双语字幕：document_start 就开始监听页面世界钩子发来的字幕，避免错过播放器的第一次请求
export default defineContentScript({
  matches: YOUTUBE_MATCHES,
  runAt: 'document_start',
  main(ctx) {
    void new YouTubeSubtitles(ctx).start();
  },
});
