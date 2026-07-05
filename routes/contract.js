// server/routes/contract.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ✅ 알바처 등록 (직접입력 타입)
router.post('/workplace/manual', async (req, res) => {
  const { user_id, workplace_name, hourly_wage, work_days, work_start, work_end } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO staff_contracts
        (user_id, workplace_id, workplace_type, workplace_name, hourly_wage, work_days, work_start, work_end, status)
       VALUES ($1, NULL, 'manual', $2, $3, $4, $5, $6, 'active')
       RETURNING *`,
      [user_id, workplace_name, hourly_wage, JSON.stringify(work_days), work_start, work_end]
    );
    res.json({ success: true, contract: result.rows[0] });
  } catch (err) {
    console.error('manual workplace error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 알바처 등록 (플랫폼 타입)
router.post('/workplace/platform', async (req, res) => {
  const { user_id, workplace_name, platform_type } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO staff_contracts
        (user_id, workplace_id, workplace_type, workplace_name, hourly_wage, work_days, status)
       VALUES ($1, NULL, 'platform', $2, 0, '[]', 'active')
       RETURNING *`,
      [user_id, workplace_name]
    );
    res.json({ success: true, contract: result.rows[0] });
  } catch (err) {
    console.error('platform workplace error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 알바처 목록 조회 (workplaces JOIN으로 attendance_mode 포함)
router.get('/workplace/list/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await db.query(
      `SELECT 
         sc.id,
         sc.id AS contract_id,
         sc.workplace_id,
         sc.workplace_type AS type,
         sc.workplace_name,
         sc.hourly_wage,
         sc.work_days,
         sc.work_start,
         sc.work_end,
         sc.status,
         sc.created_at,
         w.attendance_mode,
         w.qr_code,
         COALESCE(
           (SELECT SUM(pe.amount) 
            FROM platform_earnings pe 
            WHERE pe.contract_id = sc.id
              AND EXTRACT(MONTH FROM pe.earned_date) = EXTRACT(MONTH FROM NOW())
              AND EXTRACT(YEAR FROM pe.earned_date) = EXTRACT(YEAR FROM NOW())
           ), 0
         ) AS this_month_platform,
         COALESCE(
           (SELECT ROUND(SUM(EXTRACT(EPOCH FROM (al.clock_out - al.clock_in))/3600)::numeric, 1)
            FROM attendance_logs al
            WHERE al.contract_id = sc.id
              AND al.status = 'approved'
              AND EXTRACT(MONTH FROM al.clock_in) = EXTRACT(MONTH FROM NOW())
              AND EXTRACT(YEAR FROM al.clock_in) = EXTRACT(YEAR FROM NOW())
           ), 0
         ) AS this_month_hours
       FROM staff_contracts sc
       LEFT JOIN workplaces w ON sc.workplace_id = w.id
       WHERE sc.user_id = $1 AND sc.status = 'active'
       ORDER BY sc.created_at DESC`,
      [user_id]
    );
    res.json({ success: true, workplaces: result.rows });
  } catch (err) {
    console.error('workplace list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 알바처 삭제 (비활성화)
router.delete('/workplace/:contract_id', async (req, res) => {
  const { contract_id } = req.params;
  try {
    await db.query(`UPDATE staff_contracts SET status = 'inactive' WHERE id = $1`, [contract_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 플랫폼 수입 등록 (delivery_count = 건수, 선택 입력 → 없으면 null)
router.post('/earnings', async (req, res) => {
  const { contract_id, earned_date, amount, memo, delivery_count } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO platform_earnings (contract_id, earned_date, amount, memo, delivery_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [contract_id, earned_date, amount, memo || '', delivery_count ?? null]
    );
    res.json({ success: true, earning: result.rows[0] });
  } catch (err) {
    console.error('earnings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 플랫폼 수입 목록 조회 (SELECT * 이므로 delivery_count 자동 포함)
router.get('/earnings/:contract_id', async (req, res) => {
  const { contract_id } = req.params;
  const { year, month } = req.query;
  try {
    let query = `SELECT * FROM platform_earnings WHERE contract_id = $1`;
    const params = [contract_id];
    if (year && month) {
      query += ` AND EXTRACT(YEAR FROM earned_date) = $2 AND EXTRACT(MONTH FROM earned_date) = $3`;
      params.push(year, month);
    }
    query += ` ORDER BY earned_date DESC`;
    const result = await db.query(query, params);
    res.json({ success: true, earnings: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 플랫폼 수입 수정 (금액/건수/메모 — 날짜는 변경 안 함)
router.put('/earnings/:id', async (req, res) => {
  const { id } = req.params;
  const { amount, memo, delivery_count } = req.body;
  try {
    const result = await db.query(
      `UPDATE platform_earnings
       SET amount = $1, memo = $2, delivery_count = $3
       WHERE id = $4 RETURNING *`,
      [amount, memo || '', delivery_count ?? null, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '기록을 찾을 수 없습니다' });
    }
    res.json({ success: true, earning: result.rows[0] });
  } catch (err) {
    console.error('earnings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 플랫폼 수입 삭제 (DB에서 실제 삭제)
router.delete('/earnings/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(`DELETE FROM platform_earnings WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('earnings delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 이번달 수입 합산 API
router.get('/income/monthly/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { year, month } = req.query;

  const y = year || new Date().getFullYear();
  const m = month || (new Date().getMonth() + 1);

  try {
    // 직접입력 알바처 수입
    const manualResult = await db.query(`
      SELECT 
        sc.id as contract_id,
        sc.workplace_name,
        sc.hourly_wage,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600
        ), 0) as total_hours
      FROM staff_contracts sc
      LEFT JOIN attendance_logs al 
        ON al.contract_id = sc.id
        AND EXTRACT(YEAR FROM al.clock_in) = $2
        AND EXTRACT(MONTH FROM al.clock_in) = $3
        AND al.clock_out IS NOT NULL
        AND al.status != 'rejected'
      WHERE sc.user_id = $1
        AND sc.workplace_type = 'manual'
        AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name, sc.hourly_wage
    `, [user_id, y, m]);

    // 플랫폼 알바처 수입 (건수 합계 포함)
    const platformResult = await db.query(`
      SELECT 
        sc.id as contract_id,
        sc.workplace_name,
        COALESCE(SUM(pe.amount), 0) as total_amount,
        COALESCE(SUM(pe.delivery_count), 0) as total_count
      FROM staff_contracts sc
      LEFT JOIN platform_earnings pe
        ON pe.contract_id = sc.id
        AND EXTRACT(YEAR FROM pe.earned_date) = $2
        AND EXTRACT(MONTH FROM pe.earned_date) = $3
      WHERE sc.user_id = $1
        AND sc.workplace_type = 'platform'
        AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name
    `, [user_id, y, m]);

    // QR 알바처 수입
    const qrResult = await db.query(`
      SELECT 
        sc.id as contract_id,
        sc.workplace_name,
        sc.hourly_wage,
        COALESCE(SUM(
          EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600
        ), 0) as total_hours
      FROM staff_contracts sc
      LEFT JOIN attendance_logs al 
        ON al.contract_id = sc.id
        AND EXTRACT(YEAR FROM al.clock_in) = $2
        AND EXTRACT(MONTH FROM al.clock_in) = $3
        AND al.clock_out IS NOT NULL
        AND al.status = 'approved'
      WHERE sc.user_id = $1
        AND sc.workplace_type = 'qr'
        AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name, sc.hourly_wage
    `, [user_id, y, m]);

    // 직접입력 수입 계산
    let manualTotal = 0;
    const manualList = manualResult.rows.map(row => {
      const earned = Math.round(row.hourly_wage * row.total_hours);
      manualTotal += earned;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        hourly_wage: row.hourly_wage,
        total_hours: parseFloat(row.total_hours).toFixed(1),
        earned,
        type: 'manual'
      };
    });

    // 플랫폼 수입 계산 (건수 포함)
    let platformTotal = 0;
    const platformList = platformResult.rows.map(row => {
      const amount = parseInt(row.total_amount);
      platformTotal += amount;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        total_amount: amount,
        total_count: parseInt(row.total_count) || 0,
        type: 'platform'
      };
    });

    // QR 수입 계산
    let qrTotal = 0;
    const qrList = qrResult.rows.map(row => {
      const earned = Math.round(row.hourly_wage * row.total_hours);
      qrTotal += earned;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        hourly_wage: row.hourly_wage,
        total_hours: parseFloat(row.total_hours).toFixed(1),
        earned,
        type: 'qr'
      };
    });

    const grossTotal = manualTotal + platformTotal + qrTotal;
    const taxAmount = Math.round(grossTotal * 0.033);
    const netTotal = grossTotal - taxAmount;

    res.json({
      success: true,
      year: parseInt(y),
      month: parseInt(m),
      manual: manualList,
      platform: platformList,
      qr: qrList,
      summary: {
        gross_total: grossTotal,
        tax_amount: taxAmount,
        net_total: netTotal
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================
// ✅ [v15] 급여내역 상세 API (급여내역 화면 pay.tsx 전용)
// GET /api/contract/income/detail/:user_id?year=&month=
// - 합계/알바처별은 /income/monthly 와 "완전히 동일한 계산식" 사용
//   → home 화면 금액과 100% 일치 (QR=approved, manual=non-rejected, 실제 clock 시간 기준)
// - 추가로 일별 출퇴근 상세(records) 함께 반환 (상세 기록 표시용)
// =========================================================
router.get('/income/detail/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { year, month } = req.query;

  const y = year || new Date().getFullYear();
  const m = month || (new Date().getMonth() + 1);

  try {
    // ---- 알바처별 합계 (monthly 와 동일 로직) ----
    const manualResult = await db.query(`
      SELECT 
        sc.id as contract_id, sc.workplace_name, sc.hourly_wage,
        COALESCE(SUM(EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600), 0) as total_hours
      FROM staff_contracts sc
      LEFT JOIN attendance_logs al 
        ON al.contract_id = sc.id
        AND EXTRACT(YEAR FROM al.clock_in) = $2
        AND EXTRACT(MONTH FROM al.clock_in) = $3
        AND al.clock_out IS NOT NULL
        AND al.status != 'rejected'
      WHERE sc.user_id = $1 AND sc.workplace_type = 'manual' AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name, sc.hourly_wage
    `, [user_id, y, m]);

    const platformResult = await db.query(`
      SELECT 
        sc.id as contract_id, sc.workplace_name,
        COALESCE(SUM(pe.amount), 0) as total_amount,
        COALESCE(SUM(pe.delivery_count), 0) as total_count
      FROM staff_contracts sc
      LEFT JOIN platform_earnings pe
        ON pe.contract_id = sc.id
        AND EXTRACT(YEAR FROM pe.earned_date) = $2
        AND EXTRACT(MONTH FROM pe.earned_date) = $3
      WHERE sc.user_id = $1 AND sc.workplace_type = 'platform' AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name
    `, [user_id, y, m]);

    const qrResult = await db.query(`
      SELECT 
        sc.id as contract_id, sc.workplace_name, sc.hourly_wage,
        COALESCE(SUM(EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600), 0) as total_hours
      FROM staff_contracts sc
      LEFT JOIN attendance_logs al 
        ON al.contract_id = sc.id
        AND EXTRACT(YEAR FROM al.clock_in) = $2
        AND EXTRACT(MONTH FROM al.clock_in) = $3
        AND al.clock_out IS NOT NULL
        AND al.status = 'approved'
      WHERE sc.user_id = $1 AND sc.workplace_type = 'qr' AND sc.status = 'active'
      GROUP BY sc.id, sc.workplace_name, sc.hourly_wage
    `, [user_id, y, m]);

    let manualTotal = 0;
    const manualList = manualResult.rows.map(row => {
      const earned = Math.round(row.hourly_wage * row.total_hours);
      manualTotal += earned;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        hourly_wage: row.hourly_wage,
        total_hours: parseFloat(row.total_hours).toFixed(1),
        earned,
        type: 'manual'
      };
    });

    let platformTotal = 0;
    const platformList = platformResult.rows.map(row => {
      const amount = parseInt(row.total_amount);
      platformTotal += amount;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        total_amount: amount,
        total_count: parseInt(row.total_count) || 0,
        type: 'platform'
      };
    });

    let qrTotal = 0;
    const qrList = qrResult.rows.map(row => {
      const earned = Math.round(row.hourly_wage * row.total_hours);
      qrTotal += earned;
      return {
        contract_id: row.contract_id,
        workplace_name: row.workplace_name,
        hourly_wage: row.hourly_wage,
        total_hours: parseFloat(row.total_hours).toFixed(1),
        earned,
        type: 'qr'
      };
    });

    const grossTotal = manualTotal + platformTotal + qrTotal;
    const taxAmount = Math.round(grossTotal * 0.033);
    const netTotal = grossTotal - taxAmount;

    // ---- 일별 상세 기록 (QR + 직접입력 출퇴근) ----
    //  monthly 합계와 동일한 status/시간 기준 사용
    const recordsResult = await db.query(`
      SELECT
        al.id,
        al.clock_in,
        al.clock_out,
        sc.workplace_name,
        sc.workplace_type AS type,
        sc.hourly_wage,
        EXTRACT(EPOCH FROM (al.clock_out - al.clock_in)) / 3600 AS hours
      FROM attendance_logs al
      JOIN staff_contracts sc ON al.contract_id = sc.id
      WHERE sc.user_id = $1
        AND sc.status = 'active'
        AND sc.workplace_type IN ('qr', 'manual')
        AND al.clock_out IS NOT NULL
        AND EXTRACT(YEAR FROM al.clock_in) = $2
        AND EXTRACT(MONTH FROM al.clock_in) = $3
        AND (
          (sc.workplace_type = 'qr' AND al.status = 'approved')
          OR (sc.workplace_type = 'manual' AND al.status != 'rejected')
        )
      ORDER BY al.clock_in DESC
    `, [user_id, y, m]);

    const records = recordsResult.rows.map(r => {
      const hours = Math.max(0, parseFloat(r.hours) || 0);
      const wage = parseInt(r.hourly_wage, 10) || 0;
      return {
        id: r.id,
        workplace_name: r.workplace_name,
        type: r.type,
        hourly_wage: wage,
        hours: Math.round(hours * 100) / 100,
        pay: Math.round(wage * hours),
        clock_in: r.clock_in,
        clock_out: r.clock_out,
      };
    });

    res.json({
      success: true,
      year: parseInt(y),
      month: parseInt(m),
      manual: manualList,
      platform: platformList,
      qr: qrList,
      records,
      summary: {
        gross_total: grossTotal,
        tax_amount: taxAmount,
        net_total: netTotal
      }
    });
  } catch (err) {
    console.error('income detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 기존 근로계약 API
router.post('/', async (req, res) => {
  const { user_id, workplace_id, hourly_wage, work_days } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO staff_contracts (user_id, workplace_id, hourly_wage, work_days)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user_id, workplace_id, hourly_wage, work_days]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/worker/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sc.*, w.name as workplace_name FROM staff_contracts sc
       LEFT JOIN workplaces w ON sc.workplace_id = w.id
       WHERE sc.user_id = $1`,
      [req.params.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/owner/:workplace_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT sc.*, u.name as worker_name FROM staff_contracts sc
       JOIN users u ON sc.user_id = u.id
       WHERE sc.workplace_id = $1`,
      [req.params.workplace_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ✅ 알바처 수정 (시급 / 이름 — 온 필드만 업데이트)
router.put('/workplace/:contract_id', async (req, res) => {
  const { contract_id } = req.params;
  const { hourly_wage, workplace_name } = req.body;
  try {
    const fields = [];
    const values = [];
    let i = 1;

    if (hourly_wage !== undefined) {
      fields.push(`hourly_wage = $${i++}`);
      values.push(hourly_wage);
    }
    if (workplace_name !== undefined && String(workplace_name).trim() !== '') {
      fields.push(`workplace_name = $${i++}`);
      values.push(String(workplace_name).trim());
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: '수정할 내용이 없습니다' });
    }

    values.push(contract_id);
    await db.query(
      `UPDATE staff_contracts SET ${fields.join(', ')} WHERE id = $${i}`,
      values
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ✅ 항상 맨 마지막에!
module.exports = router;