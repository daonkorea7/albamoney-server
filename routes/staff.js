const express = require('express');
const router = express.Router();
const pool = require('../db');

// 1. 내 사업장에 등록된 알바생 목록 조회
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
        sc.created_at,
        u.name AS worker_name,
        u.phone AS worker_phone,
        w.name AS workplace_name,
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
      WHERE w.business_id = $1
      ORDER BY sc.created_at DESC
    `, [business_id]);

    res.json({ success: true, staff: result.rows });
  } catch (err) {
    console.error('알바생 목록 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. 알바생 상세 정보 조회 (이번달 출퇴근 기록 포함)
router.get('/detail/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;

    const contractResult = await pool.query(`
      SELECT 
        sc.*,
        u.name AS worker_name,
        u.phone AS worker_phone,
        w.name AS workplace_name
      FROM staff_contracts sc
      JOIN users u ON sc.user_id = u.id
      JOIN workplaces w ON sc.workplace_id = w.id
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

    res.json({ success: true, contract: result.rows[0] });
  } catch (err) {
    console.error('알바생 상태 변경 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 알바생 해고 (계약 삭제)
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

module.exports = router;