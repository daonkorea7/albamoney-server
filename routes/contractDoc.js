const express = require('express');
const router = express.Router();
const pool = require('../db');

// =========================================================
// 근로계약서 발송·서명 API (employment_contracts 테이블)
//  - staff_contracts(고용관계)와 별개로, 법적 근로계약서 문서를 관리
//  - 작성 시점의 근로조건을 스냅샷으로 저장 (시급 변경돼도 계약서는 불변)
//  - status: 'sent'(발송·서명대기) → 'signed'(서명완료)
// =========================================================

// -----------------------------------------------------
// 1. [사업자] 계약서 작성 + 발송
//    POST /api/contract-doc/send
//    body: {
//      staff_contract_id, business_id, worker_user_id,
//      worker_name, workplace_name, hourly_wage,
//      work_schedule, start_date, end_date, job_description
//    }
//    → 작성과 동시에 'sent' 상태로 발송 (알바생 서명 대기)
// -----------------------------------------------------
router.post('/send', async (req, res) => {
  try {
    const {
      staff_contract_id,
      business_id,
      worker_user_id,
      worker_name,
      workplace_name,
      hourly_wage,
      work_schedule,
      start_date,
      end_date,
      job_description,
    } = req.body;

    if (!staff_contract_id || !business_id || !worker_user_id) {
      return res.status(400).json({
        success: false,
        error: '필수 정보(알바생/사업장)가 누락됐어요',
      });
    }

    const result = await pool.query(`
      INSERT INTO employment_contracts (
        staff_contract_id, business_id, worker_user_id,
        worker_name, workplace_name, hourly_wage,
        work_schedule, start_date, end_date, job_description,
        status, sent_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10,
        'sent', now()
      )
      RETURNING *
    `, [
      staff_contract_id,
      business_id,
      worker_user_id,
      worker_name || null,
      workplace_name || null,
      hourly_wage ? parseInt(hourly_wage, 10) : null,
      work_schedule || null,
      start_date || null,
      end_date || null,
      job_description || null,
    ]);

    res.json({
      success: true,
      contract: result.rows[0],
      message: '근로계약서를 발송했어요',
    });
  } catch (err) {
    console.error('계약서 발송 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------
// 2. [알바생] 서명
//    PUT /api/contract-doc/sign/:contract_id
//    body: { signature_data, signature_type }
//      signature_type: 'draw'(손서명) / 'checkbox'(체크동의)
//    → status 'signed' + signed_at 기록
// -----------------------------------------------------
router.put('/sign/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;
    const { signature_data, signature_type } = req.body;

    if (!signature_data || !signature_type) {
      return res.status(400).json({
        success: false,
        error: '서명 정보가 필요해요',
      });
    }

    const result = await pool.query(`
      UPDATE employment_contracts
      SET status = 'signed',
          signed_at = now(),
          signature_data = $1,
          signature_type = $2
      WHERE id = $3
      RETURNING *
    `, [signature_data, signature_type, contract_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '계약서를 찾을 수 없어요',
      });
    }

    res.json({
      success: true,
      contract: result.rows[0],
      message: '서명이 완료됐어요',
    });
  } catch (err) {
    console.error('계약서 서명 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------
// 3. [알바생] 내가 받은 계약서 목록
//    GET /api/contract-doc/worker/:user_id
//    → 이 알바생에게 발송된 계약서들 (사업장명 포함)
// -----------------------------------------------------
router.get('/worker/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;

    const result = await pool.query(`
      SELECT
        ec.*,
        b.name AS business_name
      FROM employment_contracts ec
      LEFT JOIN businesses b ON ec.business_id = b.id
      WHERE ec.worker_user_id = $1
      ORDER BY ec.created_at DESC
    `, [user_id]);

    res.json({ success: true, contracts: result.rows });
  } catch (err) {
    console.error('알바생 계약서 목록 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------
// 4. [공용] 계약서 상세 조회 (한 건)
//    GET /api/contract-doc/detail/:contract_id
// -----------------------------------------------------
router.get('/detail/:contract_id', async (req, res) => {
  try {
    const { contract_id } = req.params;

    const result = await pool.query(`
      SELECT
        ec.*,
        b.name AS business_name,
        u.name AS worker_real_name,
        u.phone AS worker_phone
      FROM employment_contracts ec
      LEFT JOIN businesses b ON ec.business_id = b.id
      LEFT JOIN users u ON ec.worker_user_id = u.id
      WHERE ec.id = $1
    `, [contract_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '계약서를 찾을 수 없어요',
      });
    }

    res.json({ success: true, contract: result.rows[0] });
  } catch (err) {
    console.error('계약서 상세 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------
// 5. [사업자] 특정 고용관계의 계약서 조회
//    GET /api/contract-doc/by-staff/:staff_contract_id
//    → staff 화면에서 알바생 한 명의 최신 계약서 상태/내용 확인용
// -----------------------------------------------------
router.get('/by-staff/:staff_contract_id', async (req, res) => {
  try {
    const { staff_contract_id } = req.params;

    const result = await pool.query(`
      SELECT ec.*
      FROM employment_contracts ec
      WHERE ec.staff_contract_id = $1
      ORDER BY ec.created_at DESC
      LIMIT 1
    `, [staff_contract_id]);

    res.json({
      success: true,
      contract: result.rows[0] || null,
    });
  } catch (err) {
    console.error('고용관계별 계약서 조회 에러:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;