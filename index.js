const express = require('express');
const cors = require('cors');

require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin 초기화 (서버 시작 시 1회)
const { initFirebaseAdmin } = require('./utils/firebaseAdmin');
try {
  initFirebaseAdmin();
} catch (err) {
  console.error('🔥 Firebase Admin 초기화 실패. 서버는 시작되지만 인증 API가 작동하지 않을 수 있습니다.');
  console.error(err);
}

// 라우터 연결
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/contract', require('./routes/contract'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/shift', require('./routes/shift'));

// 서버 상태 확인
app.get('/', (req, res) => {
  res.json({ message: '알바머니 서버 정상 작동 중 🟢' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});