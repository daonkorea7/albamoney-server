// server/routes/shift.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ✅ 사업장의 시간대 목록 조회
// GET /api/shift/list/:workplace_id
router.get('/list/:workplace_id', async (req, res) => {
  try {
    const { workplace_id } = req.params;
    const result = await db.query(
      `SELECT * FROM workplace_shifts 
       WHERE workplace_id = $1
       ORDER BY start_time ASC`,
      [workplace_id]
    );
    res.json({ success: true, shifts: result.rows });
  } catch (err) {
    console.error('shift list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 시간대 추가
// POST /api/shift/create
// Body: { workplace_id, name, start_time, end_time, max_workers }
router.post('/create', async (req, res) => {
  try {
    const { workplace_id, name, start_time, end_time, max_workers } = req.body;

    if (!workplace_id || !name || !start_time || !end_time) {
      return res.status(400).json({ 
        error: '사업장, 이름, 시작/종료 시간이 필요합니다' 
      });
    }

    const result = await db.query(
      `INSERT INTO workplace_shifts 
        (workplace_id, name, start_time, end_time, max_workers)
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [workplace_id, name, start_time, end_time, max_workers || 1]
    );

    res.json({ success: true, shift: result.rows[0] });
  } catch (err) {
    console.error('shift create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 시간대 수정
// PUT /api/shift/:shift_id
// Body: { name, start_time, end_time, max_workers }
router.put('/:shift_id', async (req, res) => {
  try {
    const { shift_id } = req.params;
    const { name, start_time, end_time, max_workers } = req.body;

    const result = await db.query(
      `UPDATE workplace_shifts 
       SET name = $1, start_time = $2, end_time = $3, max_workers = $4
       WHERE id = $5 
       RETURNING *`,
      [name, start_time, end_time, max_workers || 1, shift_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '시간대를 찾을 수 없습니다' });
    }

    res.json({ success: true, shift: result.rows[0] });
  } catch (err) {
    console.error('shift update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 시간대 삭제
// DELETE /api/shift/:shift_id
router.delete('/:shift_id', async (req, res) => {
  try {
    const { shift_id } = req.params;

    // 이 시간대를 사용하는 알바가 있는지 확인
    const usageCheck = await db.query(
      `SELECT COUNT(*) as count FROM staff_contracts 
       WHERE shift_id = $1 AND status = 'active'`,
      [shift_id]
    );

    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: '이 시간대에 연결된 알바생이 있어 삭제할 수 없습니다' 
      });
    }

    const result = await db.query(
      `DELETE FROM workplace_shifts WHERE id = $1 RETURNING *`,
      [shift_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '시간대를 찾을 수 없습니다' });
    }

    res.json({ success: true, message: '시간대가 삭제되었습니다' });
  } catch (err) {
    console.error('shift delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;