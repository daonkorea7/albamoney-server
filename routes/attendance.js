// server/routes/attendance.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ✅ 출근 체크
router.post('/checkin', async (req, res) => {
  const { contract_id, method, clock_in } = req.body;
  try {
    // clock_in이 있으면 사용, 없으면 현재 시간
    const clockInTime = clock_in || new Date().toISOString();

    // 오늘 이미 출근 기록이 있는지 확인
    const today = new Date().toISOString().substring(0, 10);
    const existing = await db.query(
      `SELECT id FROM attendance_logs 
       WHERE contract_id = $1 
         AND DATE(clock_in) = $2
         AND clock_out IS NULL`,
      [contract_id, today]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, id: existing.rows[0].id, message: '이미 출근 기록이 있어요' });
    }

    const result = await db.query(
      `INSERT INTO attendance_logs (contract_id, clock_in, method, status)
       VALUES ($1, $2, $3, 'approved') RETURNING *`,
      [contract_id, clockInTime, method || 'manual']
    );
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 퇴근 체크
router.put('/checkout/:id', async (req, res) => {
  const { clock_out } = req.body;
  try {
    const clockOutTime = clock_out || new Date().toISOString();
    const result = await db.query(
      `UPDATE attendance_logs SET clock_out = $1 WHERE id = $2 RETURNING *`,
      [clockOutTime, req.params.id]
    );
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 출퇴근 기록 조회 (이번달)
router.get('/:contract_id', async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const result = await db.query(
      `SELECT * FROM attendance_logs 
       WHERE contract_id = $1
         AND EXTRACT(YEAR FROM clock_in) = $2
         AND EXTRACT(MONTH FROM clock_in) = $3
       ORDER BY clock_in ASC`,
      [req.params.contract_id, year, month]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('getLogs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 수동 출퇴근 승인/거절
router.put('/approve/:id', async (req, res) => {
  const { status } = req.body;
  try {
    const result = await db.query(
      `UPDATE attendance_logs SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 날짜+시간 지정 출퇴근 저장 (manual-checkin에서 사용)
router.post('/save-day', async (req, res) => {
  const { contract_id, date, clock_in_time, clock_out_time, status } = req.body;
  // date: "2026-04-15", clock_in_time: "09:00", clock_out_time: "18:00"
  try {
    const clockIn = `${date}T${clock_in_time}:00`;
    const clockOut = `${date}T${clock_out_time}:00`;

    // 같은 날 기록이 있으면 업데이트, 없으면 삽입
    const existing = await db.query(
      `SELECT id FROM attendance_logs WHERE contract_id = $1 AND DATE(clock_in) = $2`,
      [contract_id, date]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_in = $1, clock_out = $2, status = $3
         WHERE id = $4 RETURNING *`,
        [clockIn, clockOut, status || 'approved', existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO attendance_logs (contract_id, clock_in, clock_out, method, status)
         VALUES ($1, $2, $3, 'manual', $4) RETURNING *`,
        [contract_id, clockIn, clockOut, status || 'approved']
      );
    }
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error('save-day error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===================================================================
// 승인 대기 + 처리 완료 출퇴근 목록 조회 (사업자용)
// GET /api/attendance/pending/:business_id
// ===================================================================
router.get('/pending/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    // 승인 대기 목록 (status = 'pending')
    const pendingResult = await pool.query(`
      SELECT 
        al.id,
        al.contract_id,
        al.clock_in,
        al.clock_out,
        al.method,
        al.status,
        al.created_at,
        u.name AS worker_name,
        u.phone AS worker_phone,
        w.name AS workplace_name,
        sc.hourly_wage,
        CASE 
          WHEN al.clock_out IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600
          ELSE 0
        END AS hours_worked
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1
        AND al.status = 'pending'
      ORDER BY al.created_at DESC
    `, [business_id]);

    // 처리 완료 목록 (최근 10건)
    const doneResult = await pool.query(`
      SELECT 
        al.id,
        al.contract_id,
        al.clock_in,
        al.clock_out,
        al.method,
        al.status,
        al.created_at,
        u.name AS worker_name,
        w.name AS workplace_name
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1
        AND al.status IN ('approved', 'rejected')
        AND al.method = 'manual'
      ORDER BY al.created_at DESC
      LIMIT 10
    `, [business_id]);

    res.json({ 
      success: true, 
      pending: pendingResult.rows,
      done: doneResult.rows
    });
  } catch (err) {
    console.error('승인 목록 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});



module.exports = router;
