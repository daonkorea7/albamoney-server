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