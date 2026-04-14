const express = require('express');
const router = express.Router();
const db = require('../db');

// 근로계약 등록
router.post('/', async (req, res) => {
  const { user_id, workplace_id, hourly_wage, work_days, start_date, end_date } = req.body;
  try {
    const result = await db.query(
      'INSERT INTO staff_contracts (user_id, workplace_id, hourly_wage, work_days, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [user_id, workplace_id, hourly_wage, work_days, start_date, end_date]
    );
    res.json({ success: true, contract: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 알바생의 계약 목록 조회
router.get('/worker/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sc.*, w.name as workplace_name, w.address
       FROM staff_contracts sc
       JOIN workplaces w ON sc.workplace_id = w.id
       WHERE sc.user_id = $1 AND sc.status = 'active'`,
      [req.params.user_id]
    );
    res.json({ success: true, contracts: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 사업자의 알바생 목록 조회
router.get('/owner/:workplace_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sc.*, u.name, u.phone
       FROM staff_contracts sc
       JOIN users u ON sc.user_id = u.id
       WHERE sc.workplace_id = $1 AND sc.status = 'active'`,
      [req.params.workplace_id]
    );
    res.json({ success: true, contracts: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
