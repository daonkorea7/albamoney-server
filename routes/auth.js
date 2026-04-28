const express = require('express');
const router = express.Router();
const db = require('../db');

// 로그인 / 회원가입 (Firebase UID 기반)
router.post('/login', async (req, res) => {
  const { firebase_uid, phone, name, role } = req.body;
  try {
    // 이미 있으면 조회, 없으면 생성
    let result = await db.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [firebase_uid]
    );
    if (result.rows.length === 0) {
      result = await db.query(
        'INSERT INTO users (firebase_uid, phone, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [firebase_uid, phone, name, role]
      );
    }
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 유저 정보 조회
router.get('/:firebase_uid', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [req.params.firebase_uid]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🔔 Push Token 저장 (앱 로그인 시 호출)
router.post('/push-token', async (req, res) => {
  const { user_id, push_token } = req.body;

  if (!user_id || !push_token) {
    return res.status(400).json({
      success: false,
      error: 'user_id와 push_token은 필수입니다',
    });
  }

  try {
    const result = await db.query(
      'UPDATE users SET push_token = $1 WHERE id = $2 RETURNING id, push_token',
      [push_token, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '해당 user_id의 사용자를 찾을 수 없습니다',
      });
    }

    console.log(`✅ Push Token 저장 완료 - user_id: ${user_id}`);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('❌ Push Token 저장 실패:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;