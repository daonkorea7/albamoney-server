const express = require('express');
const router = express.Router();
const db = require('../db');

// 출근 체크
router.post('/checkin', async (req, res) => {
  const { contract_id, method } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO attendance_logs (contract_id, clock_in, method) VALUES ($1, NOW(), $2) RETURNING *',
      [contract_id, method]
    );
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 퇴근 체크
router.put('/checkout/:id', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE attendance_logs SET clock_out = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 출퇴근 기록 조회 (계약별)
router.get('/:contract_id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM attendance_logs WHERE contract_id = $1 ORDER BY clock_in DESC',
      [req.params.contract_id]
    );
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 수동 출퇴근 승인/거절 (사업자)
router.put('/approve/:id', async (req, res) => {
  const { status } = req.body; // 'approved' or 'rejected'
  try {
    const result = await db.query(
      'UPDATE attendance_logs SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
