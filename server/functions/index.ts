// Every edge function, in the order their modules are evaluated: begin/<name> says which function
// is loading, then the function's own source (unchanged) calls serve().
import './begin/ai-health';
import '../../supabase/functions/ai-health/index.ts';
import './begin/analyze-session';
import '../../supabase/functions/analyze-session/index.ts';
import './begin/car-insights-mcp';
import '../../supabase/functions/car-insights-mcp/index.ts';
import './begin/chat';
import '../../supabase/functions/chat/index.ts';
import './begin/manage-mcp-tokens';
import '../../supabase/functions/manage-mcp-tokens/index.ts';
import './begin/mcp-server';
import '../../supabase/functions/mcp-server/index.ts';
import './begin/read-fuel-receipt';
import '../../supabase/functions/read-fuel-receipt/index.ts';
import './begin/xpeed-mcp';
import '../../supabase/functions/xpeed-mcp/index.ts';
import './begin/xpeed-oauth';
import '../../supabase/functions/xpeed-oauth/index.ts';
export { functionNames, hasFunction, invokeFunction } from './registry';
