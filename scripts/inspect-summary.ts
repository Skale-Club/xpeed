
import { createClient } from '@supabase/supabase-js';

// Load environment variables manually if not using dotenv
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!process.env.VITE_SUPABASE_URL) {
    console.log("WARN: Env vars not loaded directly. Attempting to read .env file...");
    // Minimal .env parser for Bun if needed, but Bun usually loads .env automatically
    // if the file is named .env in the root.
}

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSessionSummary() {
  // Get the latest session
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, summary, source_filename, created_at')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Error fetching session:', error);
    return;
  }

  if (sessions.length > 0) {
    const session = sessions[0];
    console.log('Session ID:', session.id);
    console.log('Filename:', session.source_filename);
    console.log('Summary Structure:', JSON.stringify(session.summary, null, 2));
    
    // Check specific fields we look for in DashboardCharts
    // We expect summary to have 'stats' or similar
  } else {
    console.log('No sessions found.');
  }
}

checkSessionSummary();
