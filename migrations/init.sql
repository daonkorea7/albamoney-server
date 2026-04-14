-- 알바머니 DB 테이블 7개 생성

-- 1. users (알바생/사업자 공통 계정)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firebase_uid VARCHAR(128) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(50),
  role VARCHAR(10) CHECK (role IN ('worker', 'owner')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 2. businesses (사업자 정보)
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  biz_number VARCHAR(20),
  hometax_token TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 3. workplaces (사업장 + QR)
CREATE TABLE IF NOT EXISTS workplaces (
  id SERIAL PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id),
  name VARCHAR(100) NOT NULL,
  address TEXT,
  qr_code VARCHAR(200) UNIQUE,
  qr_issued_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 4. staff_contracts (알바생-사업장 근무 계약)
CREATE TABLE IF NOT EXISTS staff_contracts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  workplace_id INTEGER REFERENCES workplaces(id),
  hourly_wage INTEGER NOT NULL,
  work_days VARCHAR(50),
  start_date DATE,
  end_date DATE,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 5. attendance_logs (출퇴근 기록)
CREATE TABLE IF NOT EXISTS attendance_logs (
  id SERIAL PRIMARY KEY,
  contract_id INTEGER REFERENCES staff_contracts(id),
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  method VARCHAR(10) CHECK (method IN ('qr', 'manual')),
  status VARCHAR(10) CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'approved',
  memo TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 6. payroll_summaries (월별 급여 정산)
CREATE TABLE IF NOT EXISTS payroll_summaries (
  id SERIAL PRIMARY KEY,
  contract_id INTEGER REFERENCES staff_contracts(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total_minutes INTEGER DEFAULT 0,
  gross_pay INTEGER DEFAULT 0,
  tax_amount INTEGER DEFAULT 0,
  net_pay INTEGER DEFAULT 0,
  is_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 7. tax_reports (원천징수 신고 이력)
CREATE TABLE IF NOT EXISTS tax_reports (
  id SERIAL PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total_tax INTEGER DEFAULT 0,
  hometax_status VARCHAR(20) DEFAULT 'pending',
  reported_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
