// server/routes/attendance.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// =========================================================
// 🆕 [v10 헬퍼] shift_id로 예정 시간 가져오기
// =========================================================
// staff_contracts.shift_id → workplace_shifts 에서 start_time/end_time 조회
// 시간대가 없거나 자유근무면 null 반환
async function getScheduledTimes(contract_id, date) {
  try {
    const result = await db.query(`
      SELECT ws.start_time, ws.end_time
      FROM staff_contracts sc
      LEFT JOIN workplace_shifts ws ON sc.shift_id = ws.id
      WHERE sc.id = $1
    `, [contract_id]);

    if (result.rows.length === 0 || !result.rows[0].start_time) {
      return { scheduled_in: null, scheduled_out: null };
    }

    const { start_time, end_time } = result.rows[0];
    return {
      scheduled_in: `${date}T${start_time}`,    // "2026-04-19T09:00:00"
      scheduled_out: `${date}T${end_time}`,
    };
  } catch (err) {
    console.error('getScheduledTimes error:', err);
    return { scheduled_in: null, scheduled_out: null };
  }
}

// ✅ 출근 체크
router.post('/checkin', async (req, res) => {
  const { contract_id, method, clock_in } = req.body;
  try {
    const clockInTime = clock_in || new Date().toISOString();

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

    // 🆕 v10: 예정 시간 가져오기 (shift 기반)
    const { scheduled_in, scheduled_out } = await getScheduledTimes(contract_id, today);

    // 🆕 v10: billable = actual (일단 실제와 동일, Grace 로직은 다음 단계)
    const result = await db.query(
      `INSERT INTO attendance_logs 
        (contract_id, clock_in, method, status, 
         scheduled_clock_in, scheduled_clock_out,
         billable_clock_in)
       VALUES ($1, $2, $3, 'approved', $4, $5, $6) 
       RETURNING *`,
      [contract_id, clockInTime, method || 'manual', 
       scheduled_in, scheduled_out, clockInTime]
    );
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 퇴근 체크 (수동 시간 + status 받기 가능)
router.put('/checkout/:id', async (req, res) => {
  const { clock_out, clock_out_time, status } = req.body;
  try {
    let clockOutTime;

    // 수동 입력인 경우: 오늘 날짜 + 입력 시간
    if (clock_out_time) {
      const today = new Date().toISOString().substring(0, 10);
      clockOutTime = `${today}T${clock_out_time}:00`;
    } else {
      clockOutTime = clock_out || new Date().toISOString();
    }

    // 🆕 v10: billable_clock_out도 함께 업데이트 (일단 actual과 동일)
    let result;
    if (status) {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_out = $1, billable_clock_out = $1, status = $2 
         WHERE id = $3 RETURNING *`,
        [clockOutTime, status, req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_out = $1, billable_clock_out = $1 
         WHERE id = $2 RETURNING *`,
        [clockOutTime, req.params.id]
      );
    }
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
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 날짜+시간 지정 출퇴근 저장 (null 처리 개선)
router.post('/save-day', async (req, res) => {
  const { contract_id, date, clock_in_time, clock_out_time, status } = req.body;
  try {
    // clock_in_time이 없으면 에러
    if (!clock_in_time) {
      return res.status(400).json({ error: '출근 시간이 필요합니다' });
    }

    const clockIn = `${date}T${clock_in_time}:00`;
    // clock_out_time이 null이면 clockOut도 null로
    const clockOut = clock_out_time ? `${date}T${clock_out_time}:00` : null;

    // 🆕 v10: 예정 시간 가져오기 (shift 기반)
    const { scheduled_in, scheduled_out } = await getScheduledTimes(contract_id, date);

    // 🆕 v10: billable = actual (일단 실제와 동일, Grace 로직은 다음 단계)
    const billableIn = clockIn;
    const billableOut = clockOut;

    // 같은 날 기록이 있으면 업데이트, 없으면 삽입
    const existing = await db.query(
      `SELECT id FROM attendance_logs WHERE contract_id = $1 AND DATE(clock_in) = $2`,
      [contract_id, date]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_in = $1, clock_out = $2, status = $3,
             scheduled_clock_in = $4, scheduled_clock_out = $5,
             billable_clock_in = $6, billable_clock_out = $7
         WHERE id = $8 RETURNING *`,
        [clockIn, clockOut, status || 'approved',
         scheduled_in, scheduled_out,
         billableIn, billableOut,
         existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO attendance_logs 
          (contract_id, clock_in, clock_out, method, status,
           scheduled_clock_in, scheduled_clock_out,
           billable_clock_in, billable_clock_out)
         VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8) 
         RETURNING *`,
        [contract_id, clockIn, clockOut, status || 'approved',
         scheduled_in, scheduled_out,
         billableIn, billableOut]
      );
    }
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error('save-day error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 승인 대기 + 처리 완료 출퇴근 목록 조회 (사업자용)
// GET /api/attendance/pending/:business_id
router.get('/pending/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    // 승인 대기 목록 (status = 'pending')
    const pendingResult = await db.query(`
      SELECT 
        al.id,
        al.contract_id,
        al.clock_in,
        al.clock_out,
        al.method,
        al.status,
        al.created_at,
        al.scheduled_clock_in,
        al.scheduled_clock_out,
        al.billable_clock_in,
        al.billable_clock_out,
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
    const doneResult = await db.query(`
      SELECT 
        al.id,
        al.contract_id,
        al.clock_in,
        al.clock_out,
        al.method,
        al.status,
        al.created_at,
        al.scheduled_clock_in,
        al.scheduled_clock_out,
        al.billable_clock_in,
        al.billable_clock_out,
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