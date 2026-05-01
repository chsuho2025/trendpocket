const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-05-06:generateContent';

// ── 유틸 ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getDateStr = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const today = getDateStr(0);

// ── 그물 키워드 (다양한 카테고리) ──
const NET_KEYWORDS = [
  '맛집', '신상', '리뷰', '추천', '할인',
  '뷰티', '패션', '여행', '육아', '건강',
  '운동', '레시피', '인테리어', '재테크', '취미',
];

// ── Step 1: 블로그 제목 수집 ──
async function collectTitles() {
  const recentTitles = []; // 최근 3일
  const olderTitles = [];  // 이전 3일
  const titlesPerKeyword = {}; // 카테고리별 추적

  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - 3);
  const recentStr = recentDate.toISOString().slice(0, 10).replace(/-/g, '');

  await Promise.all(NET_KEYWORDS.map(async (kw, idx) => {
    await sleep(idx * 80); // rate limit 방지
    titlesPerKeyword[kw] = [];
    try {
      // 최근 3일
      const res = await fetch(
        `https://openapi.naver.com/v1/search/blog?query=${encodeURIComponent(kw)}&display=30&sort=date&start=1`,
        { headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET } }
      );
      const data = await res.json();
      if (!data.items) return;
      for (const item of data.items) {
        const title = item.title.replace(/<[^>]+>/g, '').replace(/&quot;/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#[0-9]+;/g, '').trim();
        const pubDate = item.postdate || '';
        if (pubDate >= recentStr) {
          recentTitles.push(title);
          titlesPerKeyword[kw].push(title);
        } else {
          olderTitles.push(title);
        }
      }
    } catch(e) {
      console.log(`[collect] ${kw} 오류:`, e.message);
    }
  }));

  console.log(`[collect] 최근3일 ${recentTitles.length}개, 이전3일 ${olderTitles.length}개`);
  return { recentTitles, olderTitles, titlesPerKeyword, allTitles: [...recentTitles, ...olderTitles] };
}

// ── Step 2: 빈도 분석 (코드로, AI 없이) ──
function analyzeFrequency(recentTitles, olderTitles, titlesPerKeyword) {
  // n-gram 빈도 계산
  const countNgrams = (titles) => {
    const freq = {};
    for (const title of titles) {
      const clean = title.replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s]/g, ' ').trim();
      const words = clean.split(/\s+/).filter(w => w.length >= 3 && !/^[a-zA-Z0-9]+$/.test(w));
      for (const word of words) {
        freq[word] = (freq[word] || 0) + 1;
      }
    }
    return freq;
  };

  const recentFreq = countNgrams(recentTitles);
  const olderFreq = countNgrams(olderTitles);

  // 교차 카테고리 점수
  const crossScore = {};
  for (const [kw, titles] of Object.entries(titlesPerKeyword)) {
    const kwFreq = countNgrams(titles);
    for (const [word, cnt] of Object.entries(kwFreq)) {
      if (cnt < 2) continue;
      if (!crossScore[word]) crossScore[word] = new Set();
      crossScore[word].add(kw);
    }
  }

  // 급등률 계산
  const STOP = new Set([
    // 범용어
    '있는', '하는', '이런', '그런', '어떤', '정말', '너무', '진짜', '매우',
    '아주', '정도', '이번', '오늘', '어제', '지금', '리뷰', '후기', '추천', '소개', '정보',
    '방법', '이유', '가격', '할인', '이벤트', '정리', '공유', '사용', '구매', '신상', '맛집',
    '좋은', '위한', '일상', '스타일', '브랜드', '총정리', '가볼만한곳', '편한',
    // HTML 엔티티 잔재
    'quot', 'amp', 'lt', 'gt', 'nbsp', 'apos',
    // 날짜/숫자 단독
    '1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월',
    '2024', '2025', '2026', '2027',
    // 영문 불용어
    'BEST', 'TOP', 'No', 'NO', 'the', 'and',
  ]);

  const candidates = [];
  for (const [word, recentCnt] of Object.entries(recentFreq)) {
    if (STOP.has(word)) continue;
    if (word.length < 2) continue;
    const olderCnt = olderFreq[word] || 0;
    const cross = crossScore[word]?.size || 0;
    if (cross < 2) continue; // 최소 2개 카테고리에서 등장
    if (recentCnt < 3) continue;

    const growthRate = olderCnt > 0 ? (recentCnt / olderCnt - 1) * 100 : 100;
    const score = growthRate * 0.6 + cross * 10;
    candidates.push({ word, recentCnt, olderCnt, growthRate, cross, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  console.log('[analyze] 후보:', candidates.slice(0, 10).map(c => `${c.word}(${Math.round(c.growthRate)}%,${c.cross}cat)`));
  return candidates.slice(0, 40); // 상위 40개 Gemini에 전달
}

// ── Step 3: Gemini로 TOP 10 확정 ──
async function geminiRank(candidates, allTitles) {
  const candidateStr = candidates.map((c, i) =>
    `${i+1}. "${c.word}" — 최근 ${c.recentCnt}회, 증가율 +${Math.round(c.growthRate)}%, ${c.cross}개 카테고리`
  ).join('\n');

  // 샘플 제목 100개 (컨텍스트용)
  const titleSample = allTitles.sort(() => Math.random() - 0.5).slice(0, 100).join('\n');

  const prompt = `너는 네이버 블로그 트렌드 분석 전문가야.
아래는 오늘 네이버 블로그에서 빈도가 급상승한 키워드 후보들이야.
블로그 제목 샘플도 참고해서, 실제로 지금 유행하는 트렌드 키워드 TOP 10을 골라줘.

[키워드 후보]
${candidateStr}

[블로그 제목 샘플 (100개)]
${titleSample}

조건:
- 실제 트렌드를 대표하는 구체적인 키워드 (단순 단어가 아닌 의미있는 키워드)
- 광고성/스팸 제외
- 사람 이름 단독 제외
- 범용어 단독 제외 (맛집, 후기, 추천 등)
- 가능하면 "브랜드+제품" 또는 "시즌+카테고리" 형태

반드시 JSON만 반환:
{
  "keywords": [
    { "keyword": "키워드명", "comment": "한 줄 설명 (20자 이내)", "trend": "급상승|유행중|유행지남" },
    ...
  ]
}`;

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
    }),
  });

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  return parsed.keywords || [];
}

// ── Step 4: 포스팅 수 조회 (pool 키워드 전체) ──
async function getPostCounts(keywords) {
  const results = {};
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    await Promise.all(chunk.map(async kw => {
      try {
        const res = await fetch(
          `https://openapi.naver.com/v1/search/blog?query=${encodeURIComponent(kw)}&display=1`,
          { headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET } }
        );
        const data = await res.json();
        results[kw] = data.total || 0;
      } catch { results[kw] = 0; }
    }));
    if (i + 5 < keywords.length) await sleep(120);
  }
  return results;
}

// ── Step 5: post_history 업데이트 + daily/rate 계산 ──
async function updatePostHistory(keywords, postCounts) {
  const historyData = {};

  await Promise.all(keywords.map(async kw => {
    try {
      const key = `post_history:${kw}`;
      let hist = [];
      const stored = await redis.get(key);
      if (stored) hist = typeof stored === 'string' ? JSON.parse(stored) : stored;

      // 30일 초과 제거
      const cutoff = getDateStr(-30);
      hist = hist.filter(h => h.date >= cutoff);

      const total = postCounts[kw] || 0;
      const yesterday = hist.find(h => h.date === getDateStr(-1));
      const daily = yesterday ? Math.max(0, total - yesterday.total) : null;
      const dayBefore = hist.find(h => h.date === getDateStr(-2));
      const yesterdayDaily = yesterday && dayBefore
        ? Math.max(0, yesterday.total - dayBefore.total) : null;
      const rate = (daily != null && yesterdayDaily != null && yesterdayDaily > 0)
        ? ((daily - yesterdayDaily) / yesterdayDaily * 100) : null;

      // 오늘 데이터 저장
      hist = hist.filter(h => h.date !== today);
      hist.push({ date: today, total, daily, rate });
      await redis.set(key, JSON.stringify(hist));

      historyData[kw] = {
        history: hist,
        todayTotal: total,
        todayDaily: daily,
        todayRate: rate,
        // 최근 7일 daily 배열
        postValues: hist.sort((a,b) => a.date.localeCompare(b.date)).slice(-7).map(h => h.daily),
        rateValues: hist.sort((a,b) => a.date.localeCompare(b.date)).slice(-7).map(h => h.rate),
      };
    } catch(e) {
      console.log(`[history] ${kw} 오류:`, e.message);
    }
  }));

  return historyData;
}

// ── pool 관리 ──
async function updatePool(newKeywords) {
  let pool = [];
  const stored = await redis.get('keyword_pool');
  if (stored) pool = typeof stored === 'string' ? JSON.parse(stored) : stored;

  const cutoff = getDateStr(-14);
  pool = pool.filter(p => p.addedAt >= cutoff); // 14일 초과 제거

  const existingSet = new Set(pool.map(p => p.keyword));
  for (const kw of newKeywords) {
    if (!existingSet.has(kw.keyword)) {
      pool.push({ keyword: kw.keyword, addedAt: today, isNew: true });
      existingSet.add(kw.keyword);
    }
  }

  // 최대 100개
  if (pool.length > 100) pool = pool.slice(-100);
  await redis.set('keyword_pool', JSON.stringify(pool));
  console.log(`[pool] 크기: ${pool.length}개`);
  return pool;
}

// ── 메인 ──
module.exports = async (req, res) => {
  const step = parseInt(req.query?.step || '0');

  // step 없으면 cron 모드 — 순차 실행
  if (!req.query?.step) {
    console.log('[refresh] cron 모드 시작');
    const base = `https://${req.headers.host}`;
    for (const s of [1, 2, 3]) {
      try {
        const r = await fetch(`${base}/api/refresh?step=${s}`);
        const d = await r.json();
        console.log(`[refresh] step${s} 완료:`, d.msg || '');
        if (!r.ok) throw new Error(d.error || `step${s} 실패`);
      } catch(e) {
        console.error(`[refresh] step${s} 오류:`, e.message);
        return res.status(500).json({ error: e.message });
      }
    }
    return res.status(200).json({ success: true, mode: 'cron' });
  }

  try {
    // ── STEP 1: 수집 + 빈도 분석 ──
    if (step === 1) {
      const { recentTitles, olderTitles, titlesPerKeyword, allTitles } = await collectTitles();
      const candidates = analyzeFrequency(recentTitles, olderTitles, titlesPerKeyword);

      await redis.set('refresh_step1', JSON.stringify({
        candidates,
        allTitles: allTitles.slice(0, 1000), // 토큰 절약
        totalCollected: allTitles.length,
      }));

      return res.status(200).json({ success: true, step: 1, msg: `후보 ${candidates.length}개` });
    }

    // ── STEP 2: Gemini TOP 10 + 포스팅 수 ──
    if (step === 2) {
      const s1 = await redis.get('refresh_step1');
      if (!s1) throw new Error('step1 데이터 없음');
      const { candidates, allTitles, totalCollected } = typeof s1 === 'string' ? JSON.parse(s1) : s1;

      // Gemini로 TOP 10 확정
      const top10 = await geminiRank(candidates, allTitles);
      if (!top10.length) throw new Error('Gemini 결과 없음');
      console.log('[gemini] TOP10:', top10.map(k => k.keyword));

      // pool 업데이트
      const pool = await updatePool(top10);

      // pool 전체 포스팅 수 조회
      const poolKeywords = pool.map(p => p.keyword);
      const postCounts = await getPostCounts(poolKeywords);

      await redis.set('refresh_step2', JSON.stringify({
        top10, pool, postCounts, totalCollected,
      }));

      return res.status(200).json({ success: true, step: 2, msg: `TOP10 확정, pool ${pool.length}개` });
    }

    // ── STEP 3: 히스토리 업데이트 + trend_data 저장 ──
    if (step === 3) {
      const s2 = await redis.get('refresh_step2');
      if (!s2) throw new Error('step2 데이터 없음');
      const { top10, pool, postCounts, totalCollected } = typeof s2 === 'string' ? JSON.parse(s2) : s2;

      // 포스팅 히스토리 업데이트
      const historyData = await updatePostHistory(pool.map(p => p.keyword), postCounts);

      // trend_data 구성
      const poolAddedMap = Object.fromEntries(pool.map(p => [p.keyword, p.addedAt]));

      // 이전 랭킹 로드 (prevRank 계산용)
      let prevRankMap = {};
      try {
        const prev = await redis.get('trend_data');
        if (prev) {
          const prevData = typeof prev === 'string' ? JSON.parse(prev) : prev;
          prevRankMap = Object.fromEntries((prevData.keywords || []).map(k => [k.keyword, k.rank]));
        }
      } catch {}

      const keywords = top10.map((k, i) => {
        const hist = historyData[k.keyword] || {};
        const addedAt = poolAddedMap[k.keyword] || today;
        const daysInPool = Math.floor((new Date(today) - new Date(addedAt)) / 86400000);

        return {
          rank: i + 1,
          prevRank: prevRankMap[k.keyword] || null,
          keyword: k.keyword,
          comment: k.comment || '',
          trend: k.trend || '유행중',
          isNew: daysInPool <= 1 && !prevRankMap[k.keyword],
          addedAt,
          postCount: hist.todayTotal || postCounts[k.keyword] || 0,
          todayNew: hist.todayDaily,
          todayRate: hist.todayRate,
          postValues: hist.postValues || [],
          rateValues: hist.rateValues || [],
          isMemetic: false, // 향후 확장
        };
      });

      const result = {
        updatedAt: new Date().toISOString(),
        totalCollected,
        keywords,
      };

      await redis.set('trend_data', JSON.stringify(result));

      // trend_history 저장
      try {
        let history = [];
        const stored = await redis.get('trend_history');
        if (stored) history = typeof stored === 'string' ? JSON.parse(stored) : stored;
        history = history.filter(h => h.date !== today);
        history.push({
          date: today,
          keywords: keywords.slice(0, 10).map(k => ({ keyword: k.keyword, rank: k.rank, trend: k.trend })),
        });
        history = history.sort((a,b) => b.date.localeCompare(a.date)).slice(0, 30);
        await redis.set('trend_history', JSON.stringify(history));
        console.log(`[trend_history] 저장: ${today}, 누적 ${history.length}일치`);
      } catch(e) { console.log('[trend_history] 저장 실패:', e.message); }

      // 임시 키 정리
      await redis.del('refresh_step1');
      await redis.del('refresh_step2');

      console.log('[refresh] step3 완료 — trend_data 저장');
      return res.status(200).json({ success: true, step: 3, msg: 'trend_data 저장 완료' });
    }

    return res.status(400).json({ error: '알 수 없는 step' });

  } catch(e) {
    console.error(`[refresh] step${step} 오류:`, e.message);
    return res.status(500).json({ error: e.message });
  }
};
