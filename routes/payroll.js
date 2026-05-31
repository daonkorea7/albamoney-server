const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendPushToUser } = require('../utils/push');

// =========================================================
// 공통: 한 계약(contract)의 해당 월 인정시간(billable, 없으면 실제) 합계
//  → 급여관리(/api/staff/payroll), 대시보드와 동일한 계산식
// =========================================================
async function getMonthlyHours(contract_id, year, month) {
  const q = await db.query(`
    SELECT COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        COALESCE(al.billable_clock_out, al.clock_out)
        - COALESCE(al.billable_clock_in, al.clock_in)
      )) / 3600
    ), 0) AS hours
    FROM attendance_logs al
    WHERE al.contract_id = $1
      AND al.status = 'approved'
      AND al.clock_out IS NOT NULL
      AND EXTRACT(YEAR FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $2
      AND EXTRACT(MONTH FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $3
  `, [contract_id, year, month]);
  return Math.max(0, parseFloat(q.rows[0].hours) || 0);
}

function calcPay(hours, hourly_wage) {
  const wage = parseInt(hourly_wage, 10) || 0;
  const gross = Math.round(hours * wage);
  const tax = Math.round(gross * 0.033);
  return {
    wage,
    hours: Math.round(hours * 10) / 10,
    total_minutes: Math.round(hours * 60),
    gross,
    tax,
    net: gross - tax,
  };
}

// =========================================================
// (기존) 월별 급여 계산 및 저장 - 레거시
// =========================================================
router.post('/calculate', async (req, res) => {
  const { contract_id, year, month, hourly_wage } = req.body;
  try {
    const logs = await db.query(`
      SELECT clock_in, clock_out FROM attendance_logs
      WHERE contract_id = $1
        AND status = 'approved'
        AND EXTRACT(YEAR FROM clock_in) = $2
        AND EXTRACT(MONTH FROM clock_in) = $3
        AND clock_out IS NOT NULL
    `, [contract_id, year, month]);

    let totalMinutes = 0;
    logs.rows.forEach(log => {
      const diff = new Date(log.clock_out) - new Date(log.clock_in);
      totalMinutes += Math.floor(diff / 60000);
    });

    const grossPay = Math.floor((totalMinutes / 60) * hourly_wage);
    const taxAmount = Math.floor(grossPay * 0.033);
    const netPay = grossPay - taxAmount;

    const result = await db.query(`
      INSERT INTO payroll_summaries (contract_id, year, month, total_minutes, gross_pay, tax_amount, net_pay)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (contract_id, year, month) DO UPDATE
        SET total_minutes=$4, gross_pay=$5, tax_amount=$6, net_pay=$7
      RETURNING *
    `, [contract_id, year, month, totalMinutes, grossPay, taxAmount, netPay]);

    res.json({ success: true, payroll: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// (기존) 급여 조회
router.get('/:contract_id/:year/:month', async (req, res) => {
  const { contract_id, year, month } = req.params;
  try {
    const result = await db.query(
      'SELECT * FROM payroll_summaries WHERE contract_id=$1 AND year=$2 AND month=$3',
      [contract_id, year, month]
    );
    res.json({ success: true, payroll: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 [v15] 사업자 명세서 목록 (발송여부 포함)
//   GET /api/payroll/owner-list/:business_id?year=&month=
//   - 급여관리와 동일 계산(인정시간 × 시급, round)
//   - 각 알바생의 sent_at으로 발송여부 표시
// =========================================================
router.get('/owner-list/:business_id', async (req, res) => {
  try {
    const { business_id } = req.params;
    const y = parseInt(req.query.year, 10) || new Date().getFullYear();
    const m = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    const result = await db.query(`
      SELECT
        sc.id AS contract_id,
        u.name AS worker_name,
        sc.hourly_wage,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (
            COALESCE(al.billable_clock_out, al.clock_out)
            - COALESCE(al.billable_clock_in, al.clock_in)
          )) / 3600
        ), 0) AS hours,
        MAX(ps.sent_at) AS sent_at
      FROM staff_contracts sc
      JOIN workplaces w ON sc.workplace_id = w.id
      JOIN users u ON sc.user_id = u.id
      LEFT JOIN attendance_logs al
        ON al.contract_id = sc.id
        AND al.status = 'approved'
        AND al.clock_out IS NOT NULL
        AND EXTRACT(YEAR FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $2
        AND EXTRACT(MONTH FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $3
      LEFT JOIN payroll_summaries ps
        ON ps.contract_id = sc.id AND ps.year = $2 AND ps.month = $3
      WHERE w.business_id = $1 AND sc.status = 'active'
      GROUP BY sc.id, u.name, sc.hourly_wage
      ORDER BY u.name ASC
    `, [business_id, y, m]);

    let grossSum = 0;
    let taxSum = 0;
    let sentCount = 0;

    const staff = result.rows.map((r) => {
      const hours = Math.max(0, parseFloat(r.hours) || 0);
      const p = calcPay(hours, r.hourly_wage);
      grossSum += p.gross;
      taxSum += p.tax;
      const sent = !!r.sent_at;
      if (sent) sentCount++;
      return {
        contract_id: r.contract_id,
        worker_name: r.worker_name,
        hourly_wage: p.wage,
        hours: p.hours,
        gross: p.gross,
        net: p.net,
        sent,
        sent_at: r.sent_at,
      };
    });

    res.json({
      success: true,
      year: y,
      month: m,
      summary: {
        staff_count: staff.length,
        gross_total: grossSum,
        tax_total: taxSum,
        sent_count: sentCount,
      },
      staff,
    });
  } catch (err) {
    console.error('owner-list error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 [v15] 명세서 발송
//   POST /api/payroll/send  body: { business_id, year, month, contract_ids:[] }
//   - 각 계약 급여 계산(급여관리와 동일) → payroll_summaries 저장 + sent_at = now()
//   - 알바생에게 푸시(best-effort; 실패해도 발송은 성공 처리)
// =========================================================
router.post('/send', async (req, res) => {
  const { business_id, year, month, contract_ids } = req.body;
  if (!Array.isArray(contract_ids) || contract_ids.length === 0) {
    return res.status(400).json({ success: false, error: '발송 대상이 없습니다' });
  }
  try {
    let sent_count = 0;

    for (const cid of contract_ids) {
      // 소유권 확인 + 알바생/사업장 정보
      const info = await db.query(`
        SELECT sc.id, sc.user_id, sc.hourly_wage, w.name AS workplace_name
        FROM staff_contracts sc
        JOIN workplaces w ON sc.workplace_id = w.id
        WHERE sc.id = $1 AND w.business_id = $2
      `, [cid, business_id]);
      if (info.rows.length === 0) continue; // 내 사업장 알바생 아니면 건너뜀

      const { user_id, hourly_wage, workplace_name } = info.rows[0];

      const hours = await getMonthlyHours(cid, year, month);
      const p = calcPay(hours, hourly_wage);

      await db.query(`
        INSERT INTO payroll_summaries
          (contract_id, year, month, total_minutes, gross_pay, tax_amount, net_pay, sent_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT (contract_id, year, month) DO UPDATE
          SET total_minutes = $4, gross_pay = $5, tax_amount = $6, net_pay = $7, sent_at = now()
      `, [cid, year, month, p.total_minutes, p.gross, p.tax, p.net]);

      sent_count++;

      // 푸시 (실패해도 무시)
      try {
        await sendPushToUser(db, user_id, {
          title: `📨 ${month}월 급여명세서가 도착했어요`,
          body: `${workplace_name} · 실수령 ${p.net.toLocaleString('ko-KR')}원`,
          data: {
            type: 'payslip',
            contract_id: cid,
            year,
            month,
            screen: 'worker/payslip',
          },
        });
      } catch (e) {
        console.warn('payslip push 실패:', e.message);
      }
    }

    res.json({ success: true, sent_count });
  } catch (err) {
    console.error('payslip send error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 [v15] 알바생: 받은 명세서 목록
//   GET /api/payroll/worker-list/:user_id
//   - sent_at 있는 것만 (실제 발송된 명세서)
// =========================================================
router.get('/worker-list/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const result = await db.query(`
      SELECT
        ps.contract_id, ps.year, ps.month,
        ps.total_minutes, ps.gross_pay, ps.tax_amount, ps.net_pay, ps.sent_at,
        COALESCE(w.name, sc.workplace_name) AS workplace_name
      FROM payroll_summaries ps
      JOIN staff_contracts sc ON ps.contract_id = sc.id
      LEFT JOIN workplaces w ON sc.workplace_id = w.id
      WHERE sc.user_id = $1 AND ps.sent_at IS NOT NULL
      ORDER BY ps.year DESC, ps.month DESC, ps.sent_at DESC
    `, [user_id]);

    const payslips = result.rows.map((r) => ({
      contract_id: r.contract_id,
      workplace_name: r.workplace_name || '알바처',
      year: r.year,
      month: r.month,
      hours: Math.round((r.total_minutes / 60) * 10) / 10,
      gross: r.gross_pay,
      tax: r.tax_amount,
      net: r.net_pay,
      sent_at: r.sent_at,
    }));

    res.json({ success: true, payslips });
  } catch (err) {
    console.error('worker-list error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================
// 🆕 [v15] 알바생: 명세서 1장 상세 (+ 근무기록)
//   GET /api/payroll/worker-detail/:contract_id/:year/:month
// =========================================================
router.get('/worker-detail/:contract_id/:year/:month', async (req, res) => {
  try {
    const { contract_id, year, month } = req.params;

    const sumQ = await db.query(`
      SELECT
        ps.contract_id, ps.year, ps.month,
        ps.total_minutes, ps.gross_pay, ps.tax_amount, ps.net_pay, ps.sent_at,
        sc.hourly_wage,
        COALESCE(w.name, sc.workplace_name) AS workplace_name
      FROM payroll_summaries ps
      JOIN staff_contracts sc ON ps.contract_id = sc.id
      LEFT JOIN workplaces w ON sc.workplace_id = w.id
      WHERE ps.contract_id = $1 AND ps.year = $2 AND ps.month = $3
    `, [contract_id, year, month]);

    if (sumQ.rows.length === 0) {
      return res.status(404).json({ success: false, error: '명세서를 찾을 수 없습니다' });
    }
    const s = sumQ.rows[0];

    // 근무기록 (인정시간 기준 - 급여와 일치)
    const logsQ = await db.query(`
      SELECT
        al.clock_in,
        al.clock_out,
        al.billable_clock_in,
        al.billable_clock_out,
        EXTRACT(EPOCH FROM (
          COALESCE(al.billable_clock_out, al.clock_out)
          - COALESCE(al.billable_clock_in, al.clock_in)
        )) / 3600 AS hours
      FROM attendance_logs al
      WHERE al.contract_id = $1
        AND al.status = 'approved'
        AND al.clock_out IS NOT NULL
        AND EXTRACT(YEAR FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $2
        AND EXTRACT(MONTH FROM (al.clock_in AT TIME ZONE 'Asia/Seoul')) = $3
      ORDER BY al.clock_in DESC
    `, [contract_id, year, month]);

    const wage = parseInt(s.hourly_wage, 10) || 0;
    const logs = logsQ.rows.map((r) => {
      const hours = Math.max(0, parseFloat(r.hours) || 0);
      return {
        clock_in: r.billable_clock_in || r.clock_in,
        clock_out: r.billable_clock_out || r.clock_out,
        hours: Math.round(hours * 100) / 100,
        pay: Math.round(hours * wage),
      };
    });

    res.json({
      success: true,
      payslip: {
        contract_id: s.contract_id,
        workplace_name: s.workplace_name || '알바처',
        year: s.year,
        month: s.month,
        hourly_wage: wage,
        hours: Math.round((s.total_minutes / 60) * 10) / 10,
        work_days: logs.length,
        gross: s.gross_pay,
        tax: s.tax_amount,
        net: s.net_pay,
        sent_at: s.sent_at,
      },
      logs,
    });
  } catch (err) {
    console.error('worker-detail error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;