const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyIdToken } = require('../utils/firebaseAdmin');

/**
 * Placeholder UID 차단 리스트
 * - 출시 후엔 절대 통과되면 안 되는 가짜 UID
 */
const BLOCKED_UIDS = new Set([
  'test_uid_001',
  'test_uid_002',
  'test_uid_003',
  'placeholder',
]);

/**
 * 로그인 / 회원가입 (Firebase UID + ID Token 기반)
 * 
 * Body: { firebase_uid, phone, name, role }
 * Header: Authorization: Bearer <firebase_id_token>
 * 
 * 동작:
 * 1. Authorization 헤더에 토큰이 있으면 검증 (강력 추천)
 * 2. 토큰 검증 시: uid 변조 차단, phone은 토큰 값 우선
 * 3. test_uid_001 같은 placeholder UID는 거부
 * 4. 기존 사용자는 조회, 신규는 생성
 */
router.post('/login', async (req, res) => {
  const { firebase_uid, phone, name, role } = req.body;

  // 필수 파라미터 검증
  if (!firebase_uid || !role) {
    return res.status(400).json({
      success: false,
      error: 'firebase_uid와 role은 필수입니다',
    });
  }

  // Placeholder UID 차단
  if (BLOCKED_UIDS.has(firebase_uid)) {
    console.warn(`⛔ Placeholder UID 거부: ${firebase_uid}`);
    return res.status(401).json({
      success: false,
      error: 'PLACEHOLDER_UID_BLOCKED',
      message: '유효하지 않은 인증 정보입니다.',
    });
  }

  // Authorization 헤더에서 토큰 추출
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // 토큰이 있으면 검증
  let verifiedPhone = phone;
  if (idToken) {
    try {
      const decoded = await verifyIdToken(idToken);

      // UID 변조 방지: 토큰의 uid와 body의 firebase_uid 일치 확인
      if (decoded.uid !== firebase_uid) {
        console.warn(`⛔ UID 변조 시도 - token.uid: ${decoded.uid}, body.firebase_uid: ${firebase_uid}`);
        return res.status(401).json({
          success: false,
          error: 'UID_MISMATCH',
          message: '토큰과 UID가 일치하지 않습니다.',
        });
      }

      // 토큰의 phone_number 우선 (변조 방지)
      if (decoded.phone_number) {
        verifiedPhone = decoded.phone_number;
      }
      console.log(`✅ ID Token 검증 성공 - UID: ${firebase_uid}, phone: ${verifiedPhone}`);
    } catch (tokenErr) {
      console.error('⛔ ID Token 검증 실패:', tokenErr.message);
      return res.status(401).json({
        success: false,
        error: 'INVALID_TOKEN',
        message: '유효하지 않은 인증 토큰입니다.',
      });
    }
  } else {
    // 토큰 없을 때: 경고만 하고 진행 (개발 편의를 위해)
    // ⚠️ 출시 전에는 이 분기를 제거하고 토큰을 강제해야 함
    console.warn(`⚠️ ID Token 없이 로그인 요청 - UID: ${firebase_uid} (개발 모드)`);
  }

  try {
    // 이미 있으면 조회, 없으면 생성
    let result = await db.query(
      'SELECT * FROM users WHERE firebase_uid = $1',
      [firebase_uid]
    );

    if (result.rows.length === 0) {
      // 신규 가입
      result = await db.query(
        'INSERT INTO users (firebase_uid, phone, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
        [firebase_uid, verifiedPhone, name, role]
      );
      console.log(`✅ 신규 사용자 생성 - id: ${result.rows[0].id}, uid: ${firebase_uid}`);
    } else {
      console.log(`✅ 기존 사용자 로그인 - id: ${result.rows[0].id}, uid: ${firebase_uid}`);
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('❌ /login DB 에러:', err);
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