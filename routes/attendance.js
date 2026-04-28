// server/routes/attendance.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendPushToUser } = require('../utils/push');

// =========================================================
// 🆕 [v10] shift_id로 예정 시간 가져오기
// =========================================================
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
      scheduled_in: `${date}T${start_time}+09:00`,
      scheduled_out: `${date}T${end_time}+09:00`,
    };
  } catch (err) {
    console.error('getScheduledTimes error:', err);
    return { scheduled_in: null, scheduled_out: null };
  }
}

// =========================================================
// 🆕 [v10] 자동 판정 규칙으로 billable 시간 계산
// =========================================================
function calculateBillable(actual_in, actual_out, scheduled_in, scheduled_out) {
  const result = {
    billable_in: actual_in,
    billable_out: actual_out,
    is_late: false,
    is_early_leave: false,
    is_overtime: false,
  };

  if (!scheduled_in || !scheduled_out) {
    return result;
  }

  if (actual_in) {
    const actualInTime = new Date(actual_in).getTime();
    const scheduledInTime = new Date(scheduled_in).getTime();
    const diffIn = actualInTime - scheduledInTime;

    if (diffIn <= 0) {
      result.billable_in = scheduled_in;
    } else {
      result.billable_in = actual_in;
      result.is_late = true;
    }
  }

  if (actual_out) {
    const actualOutTime = new Date(actual_out).getTime();
    const scheduledOutTime = new Date(scheduled_out).getTime();
    const diffOut = actualOutTime - scheduledOutTime;

    if (diffOut > 0) {
      result.billable_out = scheduled_out;
      result.is_overtime = true;
    } else if (diffOut < 0) {
      result.billable_out = actual_out;
      result.is_early_leave = true;
    } else {
      result.billable_out = scheduled_out;
    }
  }

  return result;
}

// =========================================================
// 🔔 [v11] attendance_log id로 사업자/알바생 정보 조회 (알림용)
// =========================================================
async function getAttendanceParties(attendance_id) {
  try {
    const result = await db.query(`
      SELECT 
        al.id AS attendance_id,
        al.contract_id,
        worker.id AS worker_id,
        worker.name AS worker_name,
        owner.id AS owner_id,
        w.name AS workplace_name
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN users worker ON sc.user_id = worker.id
      JOIN workplaces w ON sc.workplace_id = w.id
      JOIN businesses b ON w.business_id = b.id
      JOIN users owner ON b.owner_id = owner.id
      WHERE al.id = $1
    `, [attendance_id]);

    return result.rows[0] || null;
  } catch (err) {
    console.error('getAttendanceParties error:', err);
    return null;
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

    const { scheduled_in, scheduled_out } = await getScheduledTimes(contract_id, today);
    const billable = calculateBillable(clockInTime, null, scheduled_in, scheduled_out);

    const result = await db.query(
      `INSERT INTO attendance_logs 
        (contract_id, clock_in, method, status, 
         scheduled_clock_in, scheduled_clock_out,
         billable_clock_in, is_late)
       VALUES ($1, $2, $3, 'approved', $4, $5, $6, $7) 
       RETURNING *`,
      [contract_id, clockInTime, method || 'manual', 
       scheduled_in, scheduled_out, 
       billable.billable_in, billable.is_late]
    );

    const saved = result.rows[0];

    // 🔔 pending 상태로 저장된 경우 사업자에게 출근 승인 요청 알림
    if (saved.status === 'pending') {
      const parties = await getAttendanceParties(saved.id);
      if (parties && parties.owner_id) {
        await sendPushToUser(db, parties.owner_id, {
          title: `🔴 ${parties.worker_name}님 출근 승인 요청`,
          body: `${parties.workplace_name}에서 출근 요청이 왔어요`,
          data: {
            type: 'checkin_request',
            attendance_id: saved.id,
            screen: 'owner/approve',
          },
        });
      }
    }

    res.json({ success: true, ...saved });
  } catch (err) {
    console.error('checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 퇴근 체크
router.put('/checkout/:id', async (req, res) => {
  const { clock_out, clock_out_time, status } = req.body;
  try {
    let clockOutTime;
    if (clock_out_time) {
      const today = new Date().toISOString().substring(0, 10);
      clockOutTime = `${today}T${clock_out_time}:00+09:00`;
    } else {
      clockOutTime = clock_out || new Date().toISOString();
    }

    const logResult = await db.query(
      `SELECT clock_in, scheduled_clock_in, scheduled_clock_out
       FROM attendance_logs WHERE id = $1`,
      [req.params.id]
    );

    if (logResult.rows.length === 0) {
      return res.status(404).json({ error: '출근 기록을 찾을 수 없어요' });
    }

    const log = logResult.rows[0];
    const billable = calculateBillable(
      log.clock_in, clockOutTime,
      log.scheduled_clock_in, log.scheduled_clock_out
    );

    let result;
    if (status) {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_out = $1, billable_clock_in = $2, billable_clock_out = $3, 
             status = $4, is_late = $5, is_early_leave = $6, is_overtime = $7
         WHERE id = $8 RETURNING *`,
        [clockOutTime, billable.billable_in, billable.billable_out, 
         status, billable.is_late, billable.is_early_leave, billable.is_overtime,
         req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE attendance_logs 
         SET clock_out = $1, billable_clock_in = $2, billable_clock_out = $3,
             is_late = $4, is_early_leave = $5, is_overtime = $6
         WHERE id = $7 RETURNING *`,
        [clockOutTime, billable.billable_in, billable.billable_out, 
         billable.is_late, billable.is_early_leave, billable.is_overtime,
         req.params.id]
      );
    }

    const saved = result.rows[0];

    // 🔔 pending 상태로 저장된 경우 사업자에게 퇴근 승인 요청 알림
    if (saved.status === 'pending') {
      const parties = await getAttendanceParties(saved.id);
      if (parties && parties.owner_id) {
        await sendPushToUser(db, parties.owner_id, {
          title: `🔴 ${parties.worker_name}님 퇴근 승인 요청`,
          body: `${parties.workplace_name}에서 퇴근 요청이 왔어요`,
          data: {
            type: 'checkout_request',
            attendance_id: saved.id,
            screen: 'owner/approve',
          },
        });
      }
    }

    res.json({ success: true, ...saved });
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

// ✅ 수동 출퇴근 승인/거절 (v10: 시간 결정 옵션 추가)
router.put('/approve/:id', async (req, res) => {
  const { status, clock_in_decision, clock_out_decision } = req.body;
  try {
    const logResult = await db.query(
      `SELECT clock_in, clock_out, scheduled_clock_in, scheduled_clock_out,
              billable_clock_in, billable_clock_out,
              is_late, is_early_leave, is_overtime
       FROM attendance_logs WHERE id = $1`,
      [req.params.id]
    );

    if (logResult.rows.length === 0) {
      return res.status(404).json({ error: '출근 기록을 찾을 수 없어요' });
    }

    const log = logResult.rows[0];

    let billableIn = log.billable_clock_in;
    let billableOut = log.billable_clock_out;

    if (clock_in_decision === 'scheduled' && log.scheduled_clock_in) {
      billableIn = log.scheduled_clock_in;
    } else if (clock_in_decision === 'actual') {
      billableIn = log.clock_in;
    }

    if (clock_out_decision === 'scheduled' && log.scheduled_clock_out) {
      billableOut = log.scheduled_clock_out;
    } else if (clock_out_decision === 'actual') {
      billableOut = log.clock_out;
    }

    const result = await db.query(
      `UPDATE attendance_logs 
       SET status = $1, 
           billable_clock_in = $2, 
           billable_clock_out = $3 
       WHERE id = $4 
       RETURNING *`,
      [status, billableIn, billableOut, req.params.id]
    );

    const saved = result.rows[0];

    // 🔔 알바생에게 승인 결과 알림
    const parties = await getAttendanceParties(saved.id);
    if (parties && parties.worker_id) {
      const isCheckout = !!saved.clock_out;
      const action = isCheckout ? '퇴근' : '출근';

      if (status === 'approved') {
        await sendPushToUser(db, parties.worker_id, {
          title: `✅ ${action} 승인됐어요`,
          body: `${parties.workplace_name}의 ${action} 요청이 승인됐어요`,
          data: {
            type: 'attendance_approved',
            attendance_id: saved.id,
            contract_id: saved.contract_id,
            screen: 'worker/qr-checkin',
          },
        });
      } else if (status === 'rejected') {
        await sendPushToUser(db, parties.worker_id, {
          title: `❌ ${action} 요청이 거절됐어요`,
          body: `${parties.workplace_name}의 ${action} 요청이 거절됐어요`,
          data: {
            type: 'attendance_rejected',
            attendance_id: saved.id,
            contract_id: saved.contract_id,
            screen: 'worker/qr-checkin',
          },
        });
      }
    }

    res.json({ success: true, ...saved });
  } catch (err) {
    console.error('approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 날짜+시간 지정 출퇴근 저장
router.post('/save-day', async (req, res) => {
  const { contract_id, date, clock_in_time, clock_out_time, status } = req.body;
  try {
    if (!clock_in_time) {
      return res.status(400).json({ error: '출근 시간이 필요합니다' });
    }

    const clockIn = `${date}T${clock_in_time}:00+09:00`;
    const clockOut = clock_out_time ? `${date}T${clock_out_time}:00+09:00` : null;

    const { scheduled_in, scheduled_out } = await getScheduledTimes(contract_id, date);
    const billable = calculateBillable(clockIn, clockOut, scheduled_in, scheduled_out);

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
             billable_clock_in = $6, billable_clock_out = $7,
             is_late = $8, is_early_leave = $9, is_overtime = $10
         WHERE id = $11 RETURNING *`,
        [clockIn, clockOut, status || 'approved',
         scheduled_in, scheduled_out,
         billable.billable_in, billable.billable_out,
         billable.is_late, billable.is_early_leave, billable.is_overtime,
         existing.rows[0].id]
      );
    } else {
      result = await db.query(
        `INSERT INTO attendance_logs 
          (contract_id, clock_in, clock_out, method, status,
           scheduled_clock_in, scheduled_clock_out,
           billable_clock_in, billable_clock_out,
           is_late, is_early_leave, is_overtime)
         VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9, $10, $11) 
         RETURNING *`,
        [contract_id, clockIn, clockOut, status || 'approved',
         scheduled_in, scheduled_out,
         billable.billable_in, billable.billable_out,
         billable.is_late, billable.is_early_leave, billable.is_overtime]
      );
    }
    res.json({ success: true, log: result.rows[0] });
  } catch (err) {
    console.error('save-day error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 승인 대기 + 처리 완료 출퇴근 목록 조회 (사업자용)
router.get('/pending/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    const pendingResult = await db.query(`
      SELECT 
        al.id, al.contract_id, al.clock_in, al.clock_out,
        al.method, al.status, al.created_at,
        al.scheduled_clock_in, al.scheduled_clock_out,
        al.billable_clock_in, al.billable_clock_out,
        al.is_late, al.is_early_leave, al.is_overtime,
        u.name AS worker_name, u.phone AS worker_phone,
        w.name AS workplace_name, sc.hourly_wage,
        CASE 
          WHEN al.billable_clock_out IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (al.billable_clock_out - al.billable_clock_in)) / 3600
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

    const doneResult = await db.query(`
      SELECT 
        al.id, al.contract_id, al.clock_in, al.clock_out,
        al.method, al.status, al.created_at,
        al.scheduled_clock_in, al.scheduled_clock_out,
        al.billable_clock_in, al.billable_clock_out,
        al.is_late, al.is_early_leave, al.is_overtime,
        u.name AS worker_name, w.name AS workplace_name
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