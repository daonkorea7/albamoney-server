// server/routes/qr.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// ✅ 사업자 등록 또는 조회
router.post('/business/register', async (req, res) => {
  const { user_id, business_name, business_number } = req.body;
  try {
    // 이미 등록된 사업자인지 확인
    const existing = await db.query(
      `SELECT * FROM businesses WHERE owner_id = $1`,
      [user_id]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, business: existing.rows[0] });
    }

    // 새 사업자 등록
    const result = await db.query(
      `INSERT INTO businesses (owner_id, name, biz_number)
       VALUES ($1, $2, $3) RETURNING *`,
      [user_id, business_name, business_number || '']
    );
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error('business register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업자 정보 조회
router.get('/business/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT b.*, 
        (SELECT COUNT(*) FROM workplaces w WHERE w.business_id = b.id) as workplace_count
       FROM businesses b
       WHERE b.owner_id = $1`,
      [req.params.user_id]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, message: '사업자 정보 없음' });
    }
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 + QR 코드 발급
router.post('/workplace/create', async (req, res) => {
  const { user_id, workplace_name } = req.body;
  try {
    // 사업자 정보 확인
    const bizResult = await db.query(
      `SELECT * FROM businesses WHERE owner_id = $1`,
      [user_id]
    );
    if (bizResult.rows.length === 0) {
      return res.status(400).json({ error: '사업자 등록이 필요합니다' });
    }
    const business = bizResult.rows[0];

    // QR 코드 고유값 생성
    const qrCode = crypto.randomBytes(16).toString('hex');

    // 사업장 생성
    const result = await db.query(
      `INSERT INTO workplaces (business_id, name, qr_code, qr_issued_at)
       VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [business.id, workplace_name, qrCode]
    );

    const workplace = result.rows[0];

    res.json({
      success: true,
      workplace,
      qr_data: JSON.stringify({
        workplace_id: workplace.id,
        workplace_name: workplace.name,
        qr_code: qrCode,
      })
    });
  } catch (err) {
    console.error('workplace create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 목록 조회
router.get('/workplace/list/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT w.*,
        (SELECT COUNT(*) FROM staff_contracts sc WHERE sc.workplace_id = w.id AND sc.status = 'active') as staff_count
       FROM workplaces w
       JOIN businesses b ON w.business_id = b.id
       WHERE b.owner_id = $1
       ORDER BY w.created_at DESC`,
      [req.params.user_id]
    );
    res.json({ success: true, workplaces: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ QR 스캔으로 알바처 연결 (알바생용)
router.post('/workplace/connect', async (req, res) => {
  const { user_id, workplace_id, qr_code } = req.body;
  try {
    // QR 코드 유효성 확인
    const wpResult = await db.query(
      `SELECT * FROM workplaces WHERE id = $1 AND qr_code = $2`,
      [workplace_id, qr_code]
    );
    if (wpResult.rows.length === 0) {
      return res.status(400).json({ error: '유효하지 않은 QR 코드입니다' });
    }
    const workplace = wpResult.rows[0];

    // 이미 연결됐는지 확인
    const existing = await db.query(
      `SELECT * FROM staff_contracts 
       WHERE user_id = $1 AND workplace_id = $2 AND status = 'active'`,
      [user_id, workplace_id]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, message: '이미 연결된 알바처입니다', contract: existing.rows[0] });
    }

    // 근로계약 생성
    const result = await db.query(
      `INSERT INTO staff_contracts 
        (user_id, workplace_id, workplace_type, workplace_name, hourly_wage, work_days, status)
       VALUES ($1, $2, 'qr', $3, 0, '[]', 'active')
       RETURNING *`,
      [user_id, workplace_id, workplace.name]
    );

    res.json({ success: true, contract: result.rows[0], workplace_name: workplace.name });
  } catch (err) {
    console.error('workplace connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;