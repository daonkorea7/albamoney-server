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

module.exports = router;
