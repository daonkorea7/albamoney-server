// server/migrate.js
const db = require('./db');

async function migrate() {
  try {
    await db.query(`
      ALTER TABLE staff_contracts 
      ADD COLUMN IF NOT EXISTS workplace_type VARCHAR(20) DEFAULT 'qr',
      ADD COLUMN IF NOT EXISTS workplace_name VARCHAR(100),
      ADD COLUMN IF NOT EXISTS work_start VARCHAR(10),
      ADD COLUMN IF NOT EXISTS work_end VARCHAR(10)
    `);
    console.log('✅ 컬럼 추가 완료!');
  } catch (err) {
    console.error('❌ 에러:', err.message);
  } finally {
    process.exit();
  }
}

migrate();