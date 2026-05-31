const express = require('express');
const router = express.Router();
const pool = require('../db');

// 1. 내 사업장에 등록된 알바생 목록 조회 (시간대 정보 포함)
router.get('/list/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    const result = await pool.query(`
      SELECT 
        sc.id AS contract_id,
        sc.user_id,
        sc.workplace_id,
        sc.hourly_wage,
        sc.work_days,
        sc.status,
        sc.shift_id,
        sc.created_at,
        u.name AS worker_name,
        u.phone AS worker_phone,
        w.name AS workplace_name,
        ws.name AS shift_name,
        ws.start_time AS shift_start_time,
        ws.end_time AS shift_end_time,
        (
          SELECT COALESCE(SUM(
            EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600
          ), 0)
          FROM attendance_logs al
          WHERE al.contract_id = sc.id
            AND al.clock_out IS NOT NULL
            AND al.status = 'approved'
            AND EXTRACT(MONTH FROM al.clock_in) = EXTRACT(MONTH FROM CURRENT_DATE)
            AND EXTRACT(YEAR FROM al.clock_in) = EXTRACT(YEAR FROM CURRENT_DATE)
        ) AS month_hours,
        (
          SELECT COUNT(*)
          FROM attendance_logs al
          WHERE al.contract_id = sc.id
            AND al.clock_out IS NULL
        ) AS working_now
      FROM staff_contracts sc
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
      LEFT JOIN workplace_shifts ws ON sc.shift_id = ws.id
      WHERE w.business_id = $1
      ORDER BY sc.created_at DESC
    `, [business_id]);

    res.json({ success: true, staff: result.rows });
  } catch (err) {
    console.error('알바생 목록 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 알바생 상세 정보 조회 (이번달 출퇴근 기록 + 시간대 포함)
router.get('/detail/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;

    const contractResult = await pool.query(`
      SELECT 
        sc.*,
        u.name AS worker_name,
        u.phone AS worker_phone,
        w.name AS workplace_name,
        ws.name AS shift_name,
        ws.start_time AS shift_start_time,
        ws.end_time AS shift_end_time
      FROM staff_contracts sc
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
      LEFT JOIN workplace_shifts ws ON sc.shift_id = ws.id
      WHERE sc.id = $1
    `, [contract_id]);

    if (contractResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: '알바생 정보를 찾을 수 없습니다' });
    }

    const logsResult = await pool.query(`
      SELECT *
      FROM attendance_logs
      WHERE contract_id = $1
        AND EXTRACT(MONTH FROM clock_in) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM clock_in) = EXTRACT(YEAR FROM CURRENT_DATE)
      ORDER BY clock_in DESC
    `, [contract_id]);

    res.json({ 
      success: true, 
      contract: contractResult.rows[0],
      logs: logsResult.rows
    });
  } catch (err) {
    console.error('알바생 상세 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 알바생 상태 변경 (active / inactive)
router.put('/status/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;
    const { status } = req.body;

    const result = await pool.query(`
      UPDATE staff_contracts
      SET status = $1
      WHERE id = $2
      RETURNING *
    `, [status, contract_id]);

    res.json({ 
      success: true, 
      contract: result.rows[0],
      message: status === 'active' ? '활성화되었습니다' : '비활성화되었습니다'
    });
  } catch (err) {
    console.error('알바생 상태 변경 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 알바생 시간대 배정/변경/해제 (신규 v9)
router.put('/shift/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;
    const { shift_id } = req.body;  // null이면 자유 근무로 해제

    // shift_id가 있으면 해당 시간대가 이 알바의 사업장 소속인지 검증
    if (shift_id !== null && shift_id !== undefined) {
      const checkResult = await pool.query(`
        SELECT ws.id
        FROM workplace_shifts ws
        JOIN staff_contracts sc ON ws.workplace_id = sc.workplace_id
        WHERE ws.id = $1 AND sc.id = $2
      `, [shift_id, contract_id]);

      if (checkResult.rows.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: '이 알바생의 사업장에 존재하지 않는 시간대입니다' 
        });
      }
    }

    const result = await pool.query(`
      UPDATE staff_contracts
      SET shift_id = $1
      WHERE id = $2
      RETURNING *
    `, [shift_id || null, contract_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '알바생을 찾을 수 없습니다' 
      });
    }

    res.json({ 
      success: true, 
      contract: result.rows[0],
      message: shift_id ? '시간대가 배정됐어요' : '자유 근무로 변경됐어요'
    });
  } catch (err) {
    console.error('알바생 시간대 변경 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 시급 설정/변경 (사람별)
//    PUT /api/staff/wage/:contract_id   body: { hourly_wage }
//    QR로 연결된 알바생은 시급이 0으로 시작하므로 사업자가 여기서 설정
// =========================================================
router.put('/wage/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;
    const { hourly_wage } = req.body;

    const wage = parseInt(hourly_wage, 10);
    if (isNaN(wage) || wage <= 0) {
      return res.status(400).json({
        success: false,
        error: '시급을 올바르게 입력해주세요',
      });
    }

    const result = await pool.query(`
      UPDATE staff_contracts
      SET hourly_wage = $1
      WHERE id = $2
      RETURNING *
    `, [wage, contract_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '알바생을 찾을 수 없습니다',
      });
    }

    res.json({
      success: true,
      contract: result.rows[0],
      message: '시급이 설정됐어요',
    });
  } catch (err) {
    console.error('알바생 시급 변경 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 알바생 해고 (계약 삭제)
router.delete('/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;

    await pool.query(`
      DELETE FROM staff_contracts WHERE id = $1
    `, [contract_id]);

    res.json({ success: true, message: '알바생 계약이 종료되었습니다' });
  } catch (err) {
    console.error('알바생 해고 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 6. 사업자 홈 대시보드 요약 (실제 DB 연동)
//    GET /api/staff/dashboard/:business_id
//    반환: 등록 알바생 수 / 오늘 출근 / 오늘 총 근무시간 /
//          이번달 급여·원천징수 / 승인 대기 / 오늘 출퇴근 현황 목록
//    ※ '오늘' / '이번달'은 한국시간(Asia/Seoul) 기준
// =========================================================
router.get('/dashboard/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;

    // (1) 등록 알바생 수 (active)
    const staffCountQ = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM staff_contracts sc
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1 AND sc.status = 'active'
    `, [business_id]);
    const staff_count = staffCountQ.rows[0].cnt;

    // (2) 오늘 출퇴근 현황 (한국시간 기준 오늘 clock_in 기록)
    const todayQ = await pool.query(`
      SELECT 
        al.id, al.clock_in, al.clock_out, al.status,
        u.name AS worker_name, w.name AS workplace_name
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1
        AND (al.clock_in AT TIME ZONE 'Asia/Seoul')::date
            = (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY al.clock_in ASC
    `, [business_id]);
    const today_attendance = todayQ.rows;

    // 오늘 출근 인원 (거절 제외)
    const today_present = today_attendance.filter(a => a.status !== 'rejected').length;

    // (3) 오늘 총 근무시간 (approved, 진행중이면 현재까지)
    const hoursQ = await pool.query(`
      SELECT COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(al.clock_out, now()) - al.clock_in)) / 3600
      ), 0) AS hours
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1
        AND al.status = 'approved'
        AND (al.clock_in AT TIME ZONE 'Asia/Seoul')::date
            = (now() AT TIME ZONE 'Asia/Seoul')::date
    `, [business_id]);
    const today_hours = Math.round(Number(hoursQ.rows[0].hours) * 10) / 10;

    // (4) 이번달 급여 지급 예정 + 원천징수 (approved & 퇴근완료, billable 우선)
    const payQ = await pool.query(`
      SELECT COALESCE(SUM(
        (EXTRACT(EPOCH FROM (
          COALESCE(al.billable_clock_out, al.clock_out)
          - COALESCE(al.billable_clock_in, al.clock_in)
        )) / 3600) * sc.hourly_wage
      ), 0) AS gross
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1
        AND al.status = 'approved'
        AND al.clock_out IS NOT NULL
        AND EXTRACT(MONTH FROM (al.clock_in AT TIME ZONE 'Asia/Seoul'))
            = EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Seoul'))
        AND EXTRACT(YEAR FROM (al.clock_in AT TIME ZONE 'Asia/Seoul'))
            = EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Seoul'))
    `, [business_id]);
    const month_gross = Math.round(Number(payQ.rows[0].gross));
    const month_tax = Math.round(month_gross * 0.033);

    // (5) 승인 대기 건수
    const pendingQ = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      JOIN workplaces w ON sc.workplace_id = w.id
      WHERE w.business_id = $1 AND al.status = 'pending'
    `, [business_id]);
    const pending_count = pendingQ.rows[0].cnt;

    res.json({
      success: true,
      dashboard: {
        staff_count,
        today_present,
        today_hours,
        month_gross,
        month_tax,
        pending_count,
        today_attendance,
      },
    });
  } catch (err) {
    console.error('대시보드 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;