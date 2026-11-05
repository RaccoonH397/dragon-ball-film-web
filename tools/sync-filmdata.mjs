/**
 * sync-filmdata.mjs —— 一键同步 filmdata.js
 *
 * 功能：
 *   1. 从 B 站官方 API 拉取你的全部投稿（自动 WBI 签名，无需登录）
 *   2. 按标题自动匹配「影片XX / 番外XX」，更新 BV 链接
 *   3. YouTube RSS 拉取最新投稿，按标题匹配更新 yt 链接（需代理）
 *   4. 新影片自动下载 B 站封面到 imgs/cover/ 并新增条目
 *   5. 修改前自动备份 filmdata.js -> filmdata.js.bak
 *
 * 用法：在项目根目录运行  node tools/sync-filmdata.mjs
 * 选项：node tools/sync-filmdata.mjs --dry   只预览，不写文件
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============ 配置区（按需修改） ============
const CONFIG = {
  // 你的 B 站 UID（已自动探测填好）
  BILIBILI_MID: '193386165',
  // YouTube 频道 ID（UC 开头）。留空则自动从视频链接探测（支持 @handle）
  YT_CHANNEL_ID: 'UC0fCELZu7tKCOX0h-QgHtqA',
  // 本地代理地址（访问 YouTube 用，Clash 默认 7890）。为空则尝试直连
  YT_PROXY: 'http://127.0.0.1:7890',
  // 标题里带这些词的视频不算正片（预告 PV 等），匹配时跳过
  SKIP_KEYWORDS: ['预告', 'PV', 'Teaser', 'Trailer', '宣传', '专题', 'Dedicated', '花絮', '制作过程', '幕后'],
  // 【可选】B 站 Cookie。填入后风控概率大幅降低。
  // 获取方式：浏览器登录 bilibili.com → F12 → Network → 任意 api.bilibili.com 请求 → 复制完整 Cookie 值粘贴到这里
  BILIBILI_COOKIE: '',
};
// ===========================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Cookie 优先读环境变量（避免写进文件后被部署公开）：
//   Windows: set BILIBILI_COOKIE=xxx  然后运行脚本
const COOKIE = process.env.BILIBILI_COOKIE || CONFIG.BILIBILI_COOKIE || 'buvid3=ABCDEF12-3456-7890-ABCD-EF12345678901234infoc';
const DRY = process.argv.includes('--dry');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'js', 'filmdata.js');
const COVER_DIR = path.join(ROOT, 'imgs', 'cover');

// ---------- WBI 签名（B 站） ----------
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function mixinKey(orig) {
  return MIXIN_TAB.map(i => orig[i]).join('').slice(0, 32);
}
function signQuery(params, key) {
  const enc = v => encodeURIComponent(String(v)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  params = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(params).sort().map(k => `${k}=${enc(params[k])}`).join('&');
  return q + '&w_rid=' + crypto.createHash('md5').update(q + key).digest('hex');
}

// ---------- 通用工具 ----------
function curlFetch(url, { proxy = '', headers = {} } = {}) {
  const args = ['-s', '--max-time', '20', '-A', UA];
  if (proxy) args.push('--proxy', proxy);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** fetch JSON（B 站 API 专用，遇风控自动重试） */
async function fetchJson(url, headers = {}, retries = 4) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      const body = await res.text();
      const j = JSON.parse(body);
      if (j.code === -412 || j.code === -352) throw new Error('风控 ' + j.code);
      return j;
    } catch (e) {
      console.log(`  接口请求异常（第 ${i} 次尝试）：${e.message}`);
      if (i === retries) throw new Error('接口连续 ' + retries + ' 次被 B 站风控拦截。建议在 CONFIG.BILIBILI_COOKIE 里填入浏览器 Cookie 后重试');
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

const pad2 = n => String(n).padStart(2, '0');
const isSkippable = title => CONFIG.SKIP_KEYWORDS.some(k => title.includes(k));

/** 影片名转封面文件名（纯 ASCII，避免部署到 CDN 后中文路径 404）：影片08 → 08.png，番外07 → extra07.png */
function coverFileName(filmname) {
  const m = filmname.match(/^(影片|番外)(\d+)$/);
  if (!m) return 'cover' + Date.now() + '.png';
  return (m[1] === '番外' ? 'extra' : '') + m[2] + '.png';
}

/** 从标题解析影片编号，返回 '影片07' / '番外05' / null */
function parseFilmName(title) {
  let m = title.match(/【龙珠影片番外(\d+)】/);
  if (m) return '番外' + pad2(m[1]);
  m = title.match(/【龙珠影片(\d+)】/);
  if (m) return '影片' + pad2(m[1]);
  return null;
}

// ---------- 1. 读取现有数据 ----------
const raw = fs.readFileSync(DATA_FILE, 'utf8');
const { filmdata, extradata } = vm.runInNewContext(raw + '\n;({ filmdata, extradata })');
console.log(`已读取现有数据：正片 ${filmdata.length} 条，番外 ${extradata.length} 条`);

const allEntries = [...filmdata, ...extradata];

// ---------- 2. 拉取 B 站投稿（双通道：网页 API → App API 兜底） ----------
console.log('正在拉取 B 站投稿列表...');
const BILI_HEADERS = {
  'User-Agent': UA,
  Cookie: COOKIE,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 通道 A：网页 API（需 WBI 签名） */
async function fetchViaWeb() {
  const navRes = await fetchJson('https://api.bilibili.com/x/web-interface/nav', BILI_HEADERS);
  if (navRes.code !== 0 && navRes.code !== -101) throw new Error('nav 接口异常: ' + navRes.message);
  const imgKey = navRes.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = navRes.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  const wbiKey = mixinKey(imgKey + subKey);
  const out = [];
  let pn = 1;
  for (;;) {
    const q = signQuery({ mid: CONFIG.BILIBILI_MID, pn, ps: 30, order: 'pubdate', platform: 'web' }, wbiKey);
    const j = await fetchJson('https://api.bilibili.com/x/space/wbi/arc/search?' + q, {
      ...BILI_HEADERS,
      Referer: `https://space.bilibili.com/${CONFIG.BILIBILI_MID}/`,
      Origin: 'https://space.bilibili.com',
    });
    if (j.code !== 0) throw new Error('投稿接口异常: ' + j.message);
    const list = j.data.list.vlist || [];
    out.push(...list);
    if (out.length >= j.data.page.count || list.length === 0) break;
    pn++;
    await new Promise(r => setTimeout(r, 800));
  }
  return out;
}

/** 通道 B：App API（独立域名，网页 API 被风控时兜底） */
const APP_KEY = '1d8b6e7d45233436';
const APP_SEC = '560c52ccd288fed045859ed18bffd973';
const APP_UA = 'Mozilla/5.0 BiliDroid/7.0.0 (bbcallen@gmail.com)';
function signApp(params) {
  const q = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  return q + '&sign=' + crypto.createHash('md5').update(q + APP_SEC).digest('hex');
}
async function fetchViaApp() {
  const out = [];
  for (let pn = 1; ; pn++) {
    const q = signApp({
      appkey: APP_KEY, build: 7000000, mobi_app: 'android', platform: 'android',
      ts: Math.floor(Date.now() / 1000), pn, ps: 30, vmid: CONFIG.BILIBILI_MID,
    });
    const res = await fetch('https://app.bilibili.com/x/v2/space/archive?' + q, { headers: { 'User-Agent': APP_UA } });
    const j = await res.json();
    if (j.code !== 0) throw new Error('App 接口异常: ' + (j.message || j.code));
    const items = j.data.item || [];
    out.push(...items.map(v => ({ bvid: v.bvid, title: v.title, pic: v.cover, created: v.ctime })));
    if (items.length === 0 || out.length >= (j.data.count || 0)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

let videos = [];
let biliChannel = '';
try {
  videos = await fetchViaWeb();
  biliChannel = '网页 API';
} catch (e) {
  console.log(`  网页 API 不可用（${e.message}），切换到 App 接口...`);
  videos = await fetchViaApp();
  biliChannel = 'App 接口（兜底）';
}
console.log(`B 站共拉取 ${videos.length} 个投稿（通道：${biliChannel}）`);

// 每个影片编号 -> 最新的一条非预告投稿
const filmMap = new Map(); // filmname -> { bvid, title, pic, created }
for (const v of videos) {
  const name = parseFilmName(v.title);
  if (!name || isSkippable(v.title)) continue;
  if (!filmMap.has(name)) filmMap.set(name, v); // 列表按 pubdate 降序，第一条即最新
}

// ---------- 3. YouTube（解析频道页，无需 API key） ----------
/** from title like "《Dragon Ball Film》07：..." or "... Side Story :Part 06..." */
function parseYtFilmName(title) {
  let m = title.match(/Side\s*Story\s*[:：]?\s*Part\s*(\d+)/i);
  if (m) return '番外' + pad2(m[1]);
  m = title.match(/Dragon\s*Ball\s*Film\s*》?\s*(\d+)\s*[：:—\-]/i);
  if (m) return '影片' + pad2(m[1]);
  return null;
}

function resolveChannelId() {
  if (CONFIG.YT_CHANNEL_ID) return CONFIG.YT_CHANNEL_ID;
  const sample = allEntries.find(e => e.yt);
  if (!sample) return '';
  const vid = sample.yt.match(/[?&]v=([\w-]{11})/)?.[1];
  if (!vid) return '';
  for (const proxy of [CONFIG.YT_PROXY, '']) {
    try {
      console.log(`正在探测 YouTube 频道 ID${proxy ? '（经代理 ' + proxy + '）' : '（直连）'}...`);
      const body = curlFetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}&format=json`,
        { proxy, headers: { Referer: 'https://www.youtube.com/' } });
      const authorUrl = JSON.parse(body).author_url || '';
      const cid = authorUrl.match(/channel\/(UC[\w-]{22})/)?.[1];
      if (cid) { console.log('频道 ID:', cid); return cid; }
      // handle 形式（@xxx）：抓频道页 canonical 链接解析
      const handle = authorUrl.match(/@([\w.-]+)/)?.[1];
      if (handle) {
        const html = curlFetch(`https://www.youtube.com/@${handle}`, { proxy });
        const cid2 = html.match(/<link rel="canonical" href="[^"]*channel\/(UC[\w-]{22})"/)?.[1];
        if (cid2) { console.log(`频道 ID: ${cid2}（@${handle}）`); return cid2; }
      }
    } catch { /* 换下一个方式 */ }
  }
  return '';
}

/** 抓频道 /videos 页的 ytInitialData，解析出 videoId + 标题 */
function scrapeChannelVideos(channelId, proxy) {
  const html = curlFetch(`https://www.youtube.com/channel/${channelId}/videos`, { proxy });
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.*?\});/s);
  if (!m) throw new Error('页面里找不到 ytInitialData');
  const data = JSON.parse(m[1]);
  const found = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoId && o.title) {
      const t = o.title.runs ? o.title.runs.map(r => r.text).join('') : (o.title.simpleText || '');
      if (t) found.push({ id: o.videoId, title: t });
    }
    if (o.lockupViewModel && o.lockupViewModel.contentId) {
      const t = JSON.stringify(o.lockupViewModel.metadata || {}).match(/"content":"([^"]{3,120})"/);
      if (t) found.push({ id: o.lockupViewModel.contentId, title: t[1] });
    }
    for (const k in o) walk(o[k]);
  })(data);
  return [...new Map(found.map(x => [x.id, x])).values()];
}

const ytMap = new Map(); // filmname -> videoId
let ytOk = false;
const channelId = resolveChannelId();
if (channelId) {
  for (const proxy of [CONFIG.YT_PROXY, '']) {
    try {
      console.log(`正在抓取 YouTube 频道视频${proxy ? '（经代理 ' + proxy + '）' : '（直连）'}...`);
      const list = scrapeChannelVideos(channelId, proxy);
      for (const v of list) {
        const name = parseYtFilmName(v.title);
        if (!name || isSkippable(v.title) || ytMap.has(name)) continue;
        ytMap.set(name, v.id);
      }
      console.log(`YouTube 解析到 ${list.length} 个视频，匹配 ${ytMap.size} 部作品`);
      ytOk = true;
      break;
    } catch (e) { console.log('  YouTube 抓取失败：' + e.message); }
  }
}
if (!ytOk) console.log('⚠️  YouTube 不可达（检查 CONFIG.YT_PROXY 代理端口），本次跳过 yt 链接更新');

function findYtVideo(filmname) {
  return ytMap.get(filmname) || null;
}

// ---------- 4. 更新 & 新增条目 ----------
const report = { updated: [], normalized: [], added: [], unmatched: [] };
const vidOf = u => (String(u).match(/(BV[\w]{10})/) || [])[1] || (String(u).match(/[?&]v=([\w-]{11})/) || [])[1] || '';

function mergeEntry(entry) {
  const bili = filmMap.get(entry.filmname);
  if (bili) {
    const newUrl = 'https://www.bilibili.com/video/' + bili.bvid;
    if (entry.url !== newUrl) {
      const oldId = vidOf(entry.url);
      if (oldId && oldId === bili.bvid) report.normalized.push(entry.filmname);
      else report.updated.push(`${entry.filmname} → 新 BV: ${bili.bvid}`);
      entry.url = newUrl;
    }
  }
  if (ytOk) {
    const vid = findYtVideo(entry.filmname);
    if (vid) {
      const newYt = 'https://www.youtube.com/watch?v=' + vid;
      if (entry.yt !== newYt) {
        if (vidOf(entry.yt) === vid) report.normalized.push(entry.filmname + '（yt）');
        else report.updated.push(`${entry.filmname} → 新 YT: ${vid}`);
        entry.yt = newYt;
      }
    }
  }
  if (!bili && !filmMap.has(entry.filmname)) report.unmatched.push(`B 站未找到「${entry.filmname}」的正片投稿`);
}

function downloadCover(url, dest) {
  const args = ['-s', '--max-time', '30', '-A', UA, '-H', 'Referer: https://www.bilibili.com/', '-L', url, '-o', dest];
  execFileSync('curl', args);
  return fs.statSync(dest).size > 1000;
}

const existingNames = new Set(allEntries.map(e => e.filmname));
for (const [name, v] of filmMap) {
  if (existingNames.has(name)) continue;
  // 新影片：下载封面并新增
  const coverFile = coverFileName(name);
  const coverPath = path.join(COVER_DIR, coverFile);
  let coverOk = false;
  if (!DRY) {
    fs.mkdirSync(COVER_DIR, { recursive: true });
    try { coverOk = downloadCover(v.pic.startsWith('http') ? v.pic : 'https:' + v.pic, coverPath); }
    catch (e) { console.log(`封面下载失败（${name}）：${e.message}`); }
  }
  const entry = {
    filmname: name,
    cover: coverOk || DRY ? '../imgs/cover/' + coverFile : v.pic,
    url: 'https://www.bilibili.com/video/' + v.bvid,
    yt: '',
  };
  if (ytOk) {
    const vid = findYtVideo(name);
    if (vid) entry.yt = 'https://www.youtube.com/watch?v=' + vid;
  }
  // 番外排在 extradata，正片排在 filmdata
  (name.startsWith('番外') ? extradata : filmdata).push(entry);
  report.added.push(`${name}（${v.title}）封面${coverOk ? '已下载' : '使用 B 站图床链接'}`);
}

allEntries.forEach(mergeEntry);

// ---------- 5. 写回文件 ----------
function serialize(name, arr) {
  const body = arr.map(e =>
    `\t{\n\t\tfilmname: '${e.filmname}',\n\t\tcover: '${e.cover}',\n\t\turl: '${e.url}',\n\t\tyt: '${e.yt}'\n\t}`
  ).join(',\n');
  return `const ${name} = [${body.replace(/^\t\{/, '{')}\n]`;
}

const newContent = serialize('filmdata', filmdata) + '\n' + serialize('extradata', extradata) + '\n';
const changed = newContent.trim() !== raw.trim();

console.log('\n========== 同步报告 ==========');
if (report.updated.length) report.updated.forEach(s => console.log('  更新: ' + s));
if (report.added.length) report.added.forEach(s => console.log('  新增: ' + s));
if (report.normalized.length) console.log(`  清理链接参数: ${report.normalized.length} 处（BV/视频 ID 未变）`);
if (report.unmatched.length) report.unmatched.forEach(s => console.log('  提示: ' + s));
if (!report.updated.length && !report.added.length && !report.normalized.length) console.log('  没有需要变更的内容，数据已是最新的。');

if (DRY) {
  console.log('\n（--dry 预览模式，未写入任何文件）');
} else if (!changed) {
  console.log('\n文件未改动。');
} else {
  fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak');
  fs.writeFileSync(DATA_FILE, newContent, 'utf8');
  console.log(`\n✅ 已写回 ${DATA_FILE}（原文件备份为 filmdata.js.bak）`);
}
