const express = require('express');
const router = express.Router();
const db = require('../db');

// 월별 급여 계산 및 저장
router.post('/calculate', async (req, res) => {
  const { contract_id, year, month, hourly_wage } = req.body;
  try {
    // 해당 월 승인된 출퇴근 기록 가져오기
    const logs = await db.query(`
      SELECT clock_in, clock_out FROM attendance_logs
      WHERE contract_id = $1
        AND status = 'approved'
        AND EXTRACT(YEAR FROM clock_in) = $2
        AND EXTRACT(MONTH FROM clock_in) = $3
        AND clock_out IS NOT NULL
    `, [contract_id, year, month]);

    // 총 근무 분 계산
    let totalMinutes = 0;
    logs.rows.forEach(log => {
      const diff = new Date(log.clock_out) - new Date(log.clock_in);
      totalMinutes += Math.floor(diff / 60000);
    });

    // 급여 계산
    const grossPay = Math.floor((totalMinutes / 60) * hourly_wage);
    const taxAmount = Math.floor(grossPay * 0.033); // 3.3%
    const netPay = grossPay - taxAmount;

    // 저장 (이미 있으면 업데이트)
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

// 급여 조회
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

module.exports = router;
