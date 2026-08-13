CREATE TABLE scale_inquiries (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  company_name TEXT NOT NULL,
  email TEXT NOT NULL,
  company_size TEXT NOT NULL,
  monthly_usage TEXT NOT NULL,
  use_case TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);

CREATE INDEX scale_inquiries_ip_created_idx
ON scale_inquiries(ip_hash, created_at DESC);

CREATE INDEX scale_inquiries_status_created_idx
ON scale_inquiries(status, created_at DESC);
