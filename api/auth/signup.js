const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 메서드' });

  const { email, password } = req.body || {};

  if (!email || !password) return res.status(400).json({ error: '이메일과 비밀번호를 입력해주세요.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '올바른 이메일 형식이 아니에요.' });
  if (password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 해요.' });

  try {
    // 이메일 중복 확인
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) return res.status(409).json({ error: '이미 사용 중인 이메일이에요.' });

    // 비밀번호 해싱
    const password_hash = await bcrypt.hash(password, 10);

    // 유저 생성
    const { data: user, error } = await supabase
      .from('users')
      .insert([{ email: email.toLowerCase(), password_hash }])
      .select('id, email')
      .single();

    if (error) throw error;

    // JWT 발급
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(201).json({ token, email: user.email });
  } catch (e) {
    console.error('[signup]', e.message);
    return res.status(500).json({ error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
  }
};
