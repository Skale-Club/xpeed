-- Migration: Add user_id to car_profiles for multi-car support
-- Created: 2026-02-09

-- Add user_id column to car_profiles
ALTER TABLE public.car_profiles ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_car_profiles_user_id ON public.car_profiles(user_id);

-- The backfill below reads sessions.user_id, including on a fresh database.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Update existing car_profiles to set user_id from sessions (if any)
-- This is a best-effort migration, may need manual adjustment
UPDATE public.car_profiles 
SET user_id = (
  SELECT DISTINCT s.user_id 
  FROM public.sessions s 
  WHERE s.car_profile_id = car_profiles.id 
  LIMIT 1
)
WHERE user_id IS NULL;

-- Update RLS policies for car_profiles
DROP POLICY IF EXISTS "Allow all access to car_profiles" ON public.car_profiles;

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

-- Add user_id to sessions table for better filtering
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions(user_id);

-- Update RLS policies for sessions
DROP POLICY IF EXISTS "Allow all access to sessions" ON public.sessions;

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

-- Add function to automatically set user_id on insert
CREATE OR REPLACE FUNCTION public.set_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers to automatically set user_id
DROP TRIGGER IF EXISTS set_car_profiles_user_id ON public.car_profiles;
CREATE TRIGGER set_car_profiles_user_id
  BEFORE INSERT ON public.car_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

DROP TRIGGER IF EXISTS set_sessions_user_id ON public.sessions;
CREATE TRIGGER set_sessions_user_id
  BEFORE INSERT ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();
