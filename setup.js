require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sql = fs.readFileSync('./migrations/init.sql', 'utf8');

pool.query(sql)
  .then(() => {
    console.log('✅ 테이블 7개 생성 완료!');
    process.exit();
  })
  .catch(e => {
    console.error('❌ 에러:', e.message);
    process.exit();
  });