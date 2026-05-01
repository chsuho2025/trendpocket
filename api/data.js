const { Redis } = require('@upstash/redis');
const jwt = require('jsonwebtoken');

const redis = Redis.fromEnv();

function verifyToken(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  const isLoggedIn = !!user;

  try {
    const raw = await redis.get('trend_data');
    if (!raw) return res.status(404).json({ error: '데이터가 없어요. 잠시 후 다시 시도해주세요.' });

    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // 비회원: top 3만, 나머지 필드 제거
    if (!isLoggedIn) {
      return res.status(200).json({
        updatedAt: data.updatedAt,
        totalCollected: data.totalCollected,
        isGuest: true,
        keywords: (data.keywords || []).slice(0, 3).map(k => ({
          rank: k.rank,
          keyword: k.keyword,
          trend: k.trend,
          isNew: k.isNew,
          todayNew: k.todayNew,
          postCount: k.postCount,
        })),
      });
    }

    // 회원: 전체 데이터
    return res.status(200).json({
      ...data,
      isGuest: false,
    });

  } catch(e) {
    console.error('[data]', e.message);
    return res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
};
