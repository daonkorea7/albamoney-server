// server/routes/qr.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// ============================================
// 🔧 사업자등록번호 유틸
// ============================================

// 숫자만 추출 (하이픈 등 제거)
function normalizeBizNumber(raw) {
  return (raw || '').replace(/[^0-9]/g, '');
}

// 사업자등록번호 10자리 + 체크섬 검증 (국세청 공식 알고리즘)
// 가중치 [1,3,7,1,3,7,1,3,5] + 9번째 자리×5의 10의 몫 보정
function isValidBizNumber(raw) {
  const d = normalizeBizNumber(raw);
  if (d.length !== 10) return false;
  const key = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * key[i];
  sum += Math.floor((parseInt(d[8], 10) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(d[9], 10);
}

// ============================================
// 🔧 사업장(workplace) 생성 헬퍼 (본점/지점 공용)
// ============================================
async function createWorkplace({
  business_id,
  name,
  attendance_mode = 'qr',
  grace_enabled = false,
  grace_minutes = 0,
  is_main = false,
}) {
  const qrCode = crypto.randomBytes(16).toString('hex');
  const result = await db.query(
    `INSERT INTO workplaces
      (business_id, name, qr_code, qr_issued_at, attendance_mode, grace_enabled, grace_minutes, is_main)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7) RETURNING *`,
    [business_id, name, qrCode, attendance_mode, grace_enabled, grace_minutes, is_main]
  );
  return result.rows[0];
}

// ✅ 사업자 등록 또는 조회 (+ 본점 자동 생성)
router.post('/business/register', async (req, res) => {
  const { user_id, business_name, business_number } = req.body;
  try {
    if (!user_id) {
      return res.status(400).json({ error: '사용자 정보가 없습니다' });
    }
    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: '상호명을 입력해주세요' });
    }

    // 🔧 사업자번호 필수 + 형식/체크섬 검증
    const bizNum = normalizeBizNumber(business_number);
    if (!bizNum) {
      return res.status(400).json({ error: '사업자등록번호를 입력해주세요' });
    }
    if (!isValidBizNumber(bizNum)) {
      return res.status(400).json({ error: '올바른 사업자등록번호가 아닙니다 (10자리 확인)' });
    }

    // 이미 이 사장님의 사업자가 있으면 → (본점 없으면 만들어주고) 반환
    const existing = await db.query(
      `SELECT * FROM businesses WHERE owner_id = $1`,
      [user_id]
    );
    if (existing.rows.length > 0) {
      const biz = existing.rows[0];
      const mainCheck = await db.query(
        `SELECT id FROM workplaces WHERE business_id = $1 AND is_main = true`,
        [biz.id]
      );
      if (mainCheck.rows.length === 0) {
        // 🔧 기존 사업자인데 본점이 없으면 자동 생성 (이름 = 상호명)
        await createWorkplace({ business_id: biz.id, name: biz.name, is_main: true });
      }
      return res.json({ success: true, business: biz });
    }

    // 🔧 사업자번호 중복 방지 (다른 사장님이 이미 쓰는 번호인지)
    const dup = await db.query(
      `SELECT id FROM businesses WHERE biz_number = $1`,
      [bizNum]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: '이미 등록된 사업자등록번호입니다' });
    }

    // 사업자 생성
    const result = await db.query(
      `INSERT INTO businesses (owner_id, name, biz_number)
       VALUES ($1, $2, $3) RETURNING *`,
      [user_id, business_name.trim(), bizNum]
    );
    const business = result.rows[0];

    // 🔧 본점 자동 생성 (이름 = 상호명, is_main = true, QR 발급)
    const mainWp = await createWorkplace({
      business_id: business.id,
      name: business.name,
      is_main: true,
    });

    res.json({ success: true, business, main_workplace: mainWp });
  } catch (err) {
    console.error('business register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업자 정보 조회
router.get('/business/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT b.*, 
        (SELECT COUNT(*) FROM workplaces w WHERE w.business_id = b.id) as workplace_count
       FROM businesses b
       WHERE b.owner_id = $1`,
      [req.params.user_id]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, message: '사업자 정보 없음' });
    }
    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장(지점) + QR 코드 발급 (Grace Period 포함)
//    🔧 여기서 만드는 건 전부 지점 → is_main = false
router.post('/workplace/create', async (req, res) => {
  const { 
    user_id, 
    workplace_name, 
    attendance_mode,
    grace_enabled,
    grace_minutes 
  } = req.body;
  try {
    if (!workplace_name || !workplace_name.trim()) {
      return res.status(400).json({ error: '사업장 이름을 입력해주세요' });
    }

    const bizResult = await db.query(
      `SELECT * FROM businesses WHERE owner_id = $1`,
      [user_id]
    );
    if (bizResult.rows.length === 0) {
      return res.status(400).json({ error: '사업자 등록이 필요합니다' });
    }
    const business = bizResult.rows[0];

    const validModes = ['qr', 'manual', 'both'];
    const mode = validModes.includes(attendance_mode) ? attendance_mode : 'qr';

    const graceEnabled = grace_enabled === true;
    const graceMinutes = graceEnabled ? (parseInt(grace_minutes) || 10) : 0;

    // 🔧 지점 생성 (is_main = false)
    const workplace = await createWorkplace({
      business_id: business.id,
      name: workplace_name.trim(),
      attendance_mode: mode,
      grace_enabled: graceEnabled,
      grace_minutes: graceMinutes,
      is_main: false,
    });

    res.json({
      success: true,
      workplace,
      qr_data: JSON.stringify({
        workplace_id: workplace.id,
        workplace_name: workplace.name,
        qr_code: workplace.qr_code,
      })
    });
  } catch (err) {
    console.error('workplace create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 목록 조회 (Grace Period 자동 포함)
//    🔧 본점이 항상 맨 위로 오도록 정렬 (is_main DESC → 생성순)
router.get('/workplace/list/:user_id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT w.*,
        (SELECT COUNT(*) FROM staff_contracts sc WHERE sc.workplace_id = w.id AND sc.status = 'active') as staff_count,
        (SELECT COUNT(*) FROM workplace_shifts ws WHERE ws.workplace_id = w.id) as shift_count
       FROM workplaces w
       JOIN businesses b ON w.business_id = b.id
       WHERE b.owner_id = $1
       ORDER BY w.is_main DESC, w.created_at ASC`,
      [req.params.user_id]
    );
    res.json({ success: true, workplaces: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 출퇴근 방식 변경
router.put('/workplace/:workplace_id/mode', async (req, res) => {
  try {
    const { workplace_id } = req.params;
    const { attendance_mode } = req.body;

    const validModes = ['qr', 'manual', 'both'];
    if (!validModes.includes(attendance_mode)) {
      return res.status(400).json({ 
        error: 'attendance_mode는 qr, manual, both 중 하나여야 합니다' 
      });
    }

    const result = await db.query(
      `UPDATE workplaces 
       SET attendance_mode = $1 
       WHERE id = $2 
       RETURNING *`,
      [attendance_mode, workplace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '사업장을 찾을 수 없습니다' });
    }

    res.json({ 
      success: true, 
      workplace: result.rows[0],
      message: '출퇴근 방식이 변경되었습니다'
    });
  } catch (err) {
    console.error('attendance mode update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 Grace Period 변경
// PUT /api/qr/workplace/:workplace_id/grace
// Body: { grace_enabled: boolean, grace_minutes: number }
router.put('/workplace/:workplace_id/grace', async (req, res) => {
  try {
    const { workplace_id } = req.params;
    const { grace_enabled, grace_minutes } = req.body;

    const enabled = grace_enabled === true;
    const minutes = enabled ? (parseInt(grace_minutes) || 10) : 0;

    const result = await db.query(
      `UPDATE workplaces 
       SET grace_enabled = $1, grace_minutes = $2
       WHERE id = $3 
       RETURNING *`,
      [enabled, minutes, workplace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '사업장을 찾을 수 없습니다' });
    }

    res.json({ 
      success: true, 
      workplace: result.rows[0],
      message: '여유시간 설정이 변경되었습니다'
    });
  } catch (err) {
    console.error('grace update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ 사업장 이름 변경
// PUT /api/qr/workplace/:workplace_id/name
// Body: { name: string, user_id: number }
// 🔧 본점도 따로 이름 변경 가능 (정책 B안). 단, 상호명 수정 시엔 본점이 자동 동기화됨(3단계).
router.put('/workplace/:workplace_id/name', async (req, res) => {
  try {
    const { workplace_id } = req.params;
    const { name, user_id } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: '사업장 이름을 입력해주세요' });
    }
    if (name.trim().length > 50) {
      return res.status(400).json({ error: '사업장 이름은 50자 이내로 입력해주세요' });
    }

    // 소유권 확인 (본인 사업장만 수정 가능)
    if (user_id) {
      const check = await db.query(
        `SELECT w.id FROM workplaces w
         JOIN businesses b ON w.business_id = b.id
         WHERE w.id = $1 AND b.owner_id = $2`,
        [workplace_id, user_id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '해당 사업장을 수정할 권한이 없습니다' });
      }
    }

    const result = await db.query(
      `UPDATE workplaces 
       SET name = $1 
       WHERE id = $2 
       RETURNING *`,
      [name.trim(), workplace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '사업장을 찾을 수 없습니다' });
    }

    res.json({ 
      success: true, 
      workplace: result.rows[0],
      message: '사업장 이름이 변경되었습니다'
    });
  } catch (err) {
    console.error('workplace name update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ QR 스캔으로 알바처 연결 (알바생용)
router.post('/workplace/connect', async (req, res) => {
  const { user_id, workplace_id, qr_code, shift_id } = req.body;
  try {
    const wpResult = await db.query(
      `SELECT * FROM workplaces WHERE id = $1 AND qr_code = $2`,
      [workplace_id, qr_code]
    );
    if (wpResult.rows.length === 0) {
      return res.status(400).json({ error: '유효하지 않은 QR 코드입니다' });
    }
    const workplace = wpResult.rows[0];

    const existing = await db.query(
      `SELECT * FROM staff_contracts 
       WHERE user_id = $1 AND workplace_id = $2 AND status = 'active'`,
      [user_id, workplace_id]
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, message: '이미 연결된 알바처입니다', contract: existing.rows[0] });
    }

    const result = await db.query(
      `INSERT INTO staff_contracts 
        (user_id, workplace_id, workplace_type, workplace_name, hourly_wage, work_days, status, shift_id)
       VALUES ($1, $2, 'qr', $3, 0, '[]', 'active', $4)
       RETURNING *`,
      [user_id, workplace_id, workplace.name, shift_id || null]
    );

    res.json({ 
      success: true, 
      contract: result.rows[0], 
      workplace_name: workplace.name,
      attendance_mode: workplace.attendance_mode || 'qr'
    });
  } catch (err) {
    console.error('workplace connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;