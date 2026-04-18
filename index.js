const express = require('express');
const cors = require('cors');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 라우터 연결
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/contract', require('./routes/contract'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/staff', require('./routes/staff'));  // ✅ 통일

// 서버 상태 확인
app.get('/', (req, res) => {
  res.json({ message: '알바머니 서버 정상 작동 중 🟢' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});