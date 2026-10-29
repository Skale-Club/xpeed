-- Migration: Configure Supabase Auth and update RLS policies
-- Created: 2026-02-09

-- Enable email auth (users can sign up with email/password)
-- This is configured in the Supabase Dashboard > Authentication > Providers

-- Update car_profiles policies to work with authenticated users
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view their own car profiles" ON public.car_profiles;
DROP POLICY IF EXISTS "Users can create their own car profiles" ON public.car_profiles;
DROP POLICY IF EXISTS "Users can update their own car profiles" ON public.car_profiles;
DROP POLICY IF EXISTS "Users can delete their own car profiles" ON public.car_profiles;

-- Drop existing policies for sessions
DROP POLICY IF EXISTS "Users can view their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can create their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can update their own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can delete their own sessions" ON public.sessions;

-- Drop existing policies for other tables
DROP POLICY IF EXISTS "Allow all access to session_rows" ON public.session_rows;
DROP POLICY IF EXISTS "Allow all access to parameter_rules" ON public.parameter_rules;
DROP POLICY IF EXISTS "Allow all access to session_flags" ON public.session_flags;
DROP POLICY IF EXISTS "Allow all access to app_settings" ON public.app_settings;

-- Create new RLS policies for car_profiles
CREATE POLICY "Users can view their own car profiles" 
  ON public.car_profiles FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own car profiles" 
  ON public.car_profiles FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own car profiles" 
  ON public.car_profiles FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own car profiles" 
  ON public.car_profiles FOR DELETE 
  USING (auth.uid() = user_id);

-- Create new RLS policies for sessions
CREATE POLICY "Users can view their own sessions" 
  ON public.sessions FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own sessions" 
  ON public.sessions FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own sessions" 
  ON public.sessions FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own sessions" 
  ON public.sessions FOR DELETE 
  USING (auth.uid() = user_id);

-- Create RLS policies for session_rows (based on session ownership)
CREATE POLICY "Users can view session rows from their sessions" 
  ON public.session_rows FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_rows.session_id 
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create session rows for their sessions" 
  ON public.session_rows FOR INSERT 
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_rows.session_id 
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete session rows from their sessions" 
  ON public.session_rows FOR DELETE 
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_rows.session_id 
      AND s.user_id = auth.uid()
    )
  );

-- Create RLS policies for parameter_rules (based on car profile ownership)
CREATE POLICY "Users can view parameter rules for their cars" 
  ON public.parameter_rules FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM public.car_profiles cp 
      WHERE cp.id = parameter_rules.car_profile_id 
      AND cp.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create parameter rules for their cars" 
  ON public.parameter_rules FOR INSERT 
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.car_profiles cp 
      WHERE cp.id = parameter_rules.car_profile_id 
      AND cp.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update parameter rules for their cars" 
  ON public.parameter_rules FOR UPDATE 
  USING (
    EXISTS (
      SELECT 1 FROM public.car_profiles cp 
      WHERE cp.id = parameter_rules.car_profile_id 
      AND cp.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete parameter rules for their cars" 
  ON public.parameter_rules FOR DELETE 
  USING (
    EXISTS (
      SELECT 1 FROM public.car_profiles cp 
      WHERE cp.id = parameter_rules.car_profile_id 
      AND cp.user_id = auth.uid()
    )
  );

-- Create RLS policies for session_flags (based on session ownership)
CREATE POLICY "Users can view session flags from their sessions" 
  ON public.session_flags FOR SELECT 
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_flags.session_id 
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create session flags for their sessions" 
  ON public.session_flags FOR INSERT 
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_flags.session_id 
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete session flags from their sessions" 
  ON public.session_flags FOR DELETE 
  USING (
    EXISTS (
      SELECT 1 FROM public.sessions s 
      WHERE s.id = session_flags.session_id 
      AND s.user_id = auth.uid()
    )
  );

-- Create RLS policies for app_settings (user-specific settings)
-- Fresh installs need the ownership column before policies can reference it.
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE POLICY "Users can view their own app settings" 
  ON public.app_settings FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own app settings" 
  ON public.app_settings FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own app settings" 
  ON public.app_settings FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own app settings" 
  ON public.app_settings FOR DELETE 
  USING (auth.uid() = user_id);

-- Add user_id to app_settings if not exists
ALTER TABLE public.app_settings 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Create index for app_settings user_id
CREATE INDEX IF NOT EXISTS idx_app_settings_user_id ON public.app_settings(user_id);

-- Update triggers to set user_id automatically
CREATE OR REPLACE FUNCTION public.set_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add trigger for app_settings
DROP TRIGGER IF EXISTS set_app_settings_user_id ON public.app_settings;
CREATE TRIGGER set_app_settings_user_id
  BEFORE INSERT ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

-- Enable RLS on all tables (if not already enabled)
ALTER TABLE public.car_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parameter_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Create a default car profile for new users (optional, can be removed if not desired)
-- This trigger creates a default car profile when a new user signs up
CREATE OR REPLACE FUNCTION public.create_default_car_profile()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.car_profiles (name, notes, user_id)
  VALUES ('My First Car', 'Default vehicle profile', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Uncomment the following line if you want automatic default car creation
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- CREATE TRIGGER on_auth_user_created
--   AFTER INSERT ON auth.users
--   FOR EACH ROW
--   EXECUTE FUNCTION public.create_default_car_profile();
