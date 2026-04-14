ALTER TABLE staff_contracts 
ADD COLUMN IF NOT EXISTS workplace_type VARCHAR(10) DEFAULT 'qr' 
CHECK (workplace_type IN ('qr', 'manual', 'platform'));

ALTER TABLE staff_contracts
ADD COLUMN IF NOT EXISTS workplace_name VARCHAR(100);

ALTER TABLE staff_contracts
ALTER COLUMN workplace_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS platform_earnings (
  id SERIAL PRIMARY KEY,
  contract_id INTEGER REFERENCES staff_contracts(id),
  earned_date DATE NOT NULL,
  amount INTEGER NOT NULL,
  memo TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);