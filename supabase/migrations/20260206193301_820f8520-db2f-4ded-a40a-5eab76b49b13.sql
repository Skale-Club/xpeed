
-- Car profiles
CREATE TABLE public.car_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '2010 Prius',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.car_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to car_profiles" ON public.car_profiles FOR ALL USING (true) WITH CHECK (true);

-- Sessions
CREATE TABLE public.sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  car_profile_id UUID REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  uploaded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  source_filename TEXT NOT NULL,
  session_start TIMESTAMP WITH TIME ZONE,
  session_end TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0,
  columns JSONB,
  summary JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to sessions" ON public.sessions FOR ALL USING (true) WITH CHECK (true);

-- Session rows (sparse timeseries)
CREATE TABLE public.session_rows (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  t_seconds DOUBLE PRECISION,
  t_timestamp TIMESTAMP WITH TIME ZONE,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.session_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to session_rows" ON public.session_rows FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_session_rows_session_id ON public.session_rows(session_id);

-- Parameter rules
CREATE TABLE public.parameter_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  car_profile_id UUID REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  parameter_key TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT,
  canonical_key TEXT NOT NULL,
  normal_min DOUBLE PRECISION,
  normal_max DOUBLE PRECISION,
  warn_min DOUBLE PRECISION,
  warn_max DOUBLE PRECISION,
  critical_min DOUBLE PRECISION,
  critical_max DOUBLE PRECISION,
  min_duration_seconds INTEGER NOT NULL DEFAULT 10,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.parameter_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to parameter_rules" ON public.parameter_rules FOR ALL USING (true) WITH CHECK (true);

-- Session flags
CREATE TABLE public.session_flags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('normal', 'attention', 'critical')),
  canonical_key TEXT NOT NULL,
  parameter_key TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.session_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all access to session_flags" ON public.session_flags FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX idx_session_flags_session_id ON public.session_flags(session_id);

-- Cars are created for an authenticated owner after signup. An ownerless demo
-- seed here prevents the later user_id NOT NULL migration on a fresh database.
