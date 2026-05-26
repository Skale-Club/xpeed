import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Shield, UserPlus, RefreshCw, MailCheck } from 'lucide-react';

const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || '';
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '';

export default function SetupAdminPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [diagnosticInfo, setDiagnosticInfo] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const runDiagnostics = async () => {
    setDiagnosticLoading(true);
    setDiagnosticInfo(null);
    
    try {
      // Check if user exists in auth
      const { data: { user }, error: getUserError } = await supabase.auth.getUser();
      
      let info = '=== DIAGNOSTIC INFO ===\n\n';
      
      if (user) {
        info += `Current logged in user: ${user.email}\n`;
        info += `User ID: ${user.id}\n\n`;
      } else {
        info += 'No user currently logged in\n\n';
      }

      // Try to sign in as admin to see the error
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      });

      if (signInError) {
        info += `Sign in error: ${signInError.message}\n`;
        info += `Error code: ${signInError.status}\n\n`;
        
        if (signInError.message.includes('Invalid login')) {
          info += 'The user does not exist or password is wrong.\n';
          info += 'Attempting to create user...\n';
        }
      } else {
        info += 'Sign in successful!\n';
      }

      setDiagnosticInfo(info);
    } catch (error) {
      setDiagnosticInfo(`Diagnostic error: ${error}`);
    } finally {
      setDiagnosticLoading(false);
    }
  };

  const createOrResetAdmin = async () => {
    setLoading(true);
    setResult(null);

    try {
      // Step 1: Try to sign up (creates new user)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: ADMIN_EMAIL,
        password: newPassword || ADMIN_PASSWORD,
      });

      if (signUpError) {
        if (signUpError.message.includes('already')) {
          // User exists - let's try to sign in to verify
          setResult({ 
            success: true, 
            message: `User already exists in auth system. The password may be different or email needs confirmation.

NEXT STEPS:
1. Check if email confirmation is disabled in Supabase Dashboard
2. If enabled, check vanildinho@gmail.com inbox for confirmation email
3. Or use "Send Password Reset Email" button to set a new password
4. You can also manually create the user in Supabase Dashboard with "Auto Confirm Email" checked` 
          });
          setShowReset(true);
        } else {
          setResult({ success: false, message: `Sign up error: ${signUpError.message}` });
        }
      } else if (signUpData.user) {
        // Success! Now make them admin
        const { error: profileError } = await supabase.from('car_profiles').upsert({
          user_id: signUpData.user.id,
          name: 'Admin Profile',
          notes: 'System Administrator',
          is_admin: true,
        }, { onConflict: 'user_id' });

        if (profileError) {
          setResult({ success: false, message: `Profile error: ${profileError.message}` });
        } else {
          setResult({ 
            success: true, 
            message: `✅ Admin user created successfully!

IMPORTANT: Check vanildinho@gmail.com inbox for confirmation email and click the link to activate the account.

If you don't receive the email:
1. Check spam folder
2. Go to Supabase Dashboard > Authentication > Settings > Email
3. Disable "Confirm email" toggle for easier testing` 
          });
        }
      }
    } catch (error) {
      setResult({ success: false, message: `Error: ${error}` });
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(ADMIN_EMAIL, {
        redirectTo: `${window.location.origin}/login`,
      });
      
      if (error) {
        setResult({ success: false, message: `Reset error: ${error.message}` });
      } else {
        setResult({ 
          success: true, 
          message: 'Password reset email sent! Check vanildinho@gmail.com inbox.' 
        });
      }
    } catch (error) {
      setResult({ success: false, message: `Error: ${error}` });
    } finally {
      setLoading(false);
    }
  };

  const confirmEmailInstructions = () => {
    setResult({
      success: true,
      message: `📧 EMAIL CONFIRMATION BYPASS

The user vanildinho@gmail.com needs email confirmation.

QUICK FIX - Choose one option:

OPTION 1 (Fastest):
Run this SQL in Supabase Dashboard > SQL Editor:

UPDATE auth.users 
SET email_confirmed_at = NOW()
WHERE email = 'vanildinho@gmail.com';

OPTION 2 (Dashboard):
1. Go to: https://supabase.com/dashboard
2. Authentication > Users
3. Find vanildinho@gmail.com
4. Click "Confirm email" button

OPTION 3 (Disable for all):
1. Supabase Dashboard > Authentication > Settings > Email
2. Toggle OFF: "Enable email confirmations"
3. This prevents the requirement for ALL users`
    });
  };

  const autoConfirmEmail = async () => {
    setLoading(true);
    setResult(null);

    try {
      // Try to sign in first to see if already confirmed
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: ADMIN_EMAIL,
        password: newPassword || ADMIN_PASSWORD,
      });

      if (signInError) {
        if (signInError.message.includes('Email not confirmed')) {
          // User exists but not confirmed
          // We can't directly update auth.users from client
          // Provide SQL to run
          setResult({
            success: false,
            message: `❌ Email not confirmed automatically.

⚠️ SUPABASE SECURITY: Cannot confirm email from browser for security reasons.

✅ YOU MUST RUN THIS SQL MANUALLY:

1. Go to: https://supabase.com/dashboard
2. Open: SQL Editor
3. Run this:

UPDATE auth.users 
SET email_confirmed_at = NOW()
WHERE email = 'vanildinho@gmail.com';

4. Then try logging in again.`
          });
        } else if (signInError.message.includes('Invalid login')) {
          setResult({
            success: false,
            message: `❌ User doesn't exist or password is wrong.

Please create the user first using "Create Admin User" button.`
          });
        } else {
          setResult({
            success: false,
            message: `❌ Error: ${signInError.message}`
          });
        }
      } else if (signInData.user) {
        // Success! Email is confirmed
        setResult({
          success: true,
          message: `✅ SUCCESS! Email is already confirmed!

You can now log in with:
Email: ${ADMIN_EMAIL}
Password: ${newPassword || ADMIN_PASSWORD}

Click "Go to Login" button below.`
        });
        
        // Also make sure they are admin
        const { error: profileError } = await supabase.from('car_profiles').upsert({
          user_id: signInData.user.id,
          name: 'Admin Profile',
          notes: 'System Administrator',
          is_admin: true,
        }, { onConflict: 'user_id' });

        if (profileError) {
          console.error('Profile error:', profileError);
        }
      }
    } catch (error) {
      setResult({
        success: false,
        message: `Error: ${error}`
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center space-y-2">
          <div className="w-16 h-16 flex items-center justify-center bg-primary/10 rounded-full">
            <Shield className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Admin Setup</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create Admin User</CardTitle>
            <CardDescription>
              Email: {ADMIN_EMAIL}<br />
              Default Password: {ADMIN_PASSWORD}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result && (
              <Alert variant={result.success ? "default" : "destructive"}>
                <AlertDescription className="whitespace-pre-wrap">{result.message}</AlertDescription>
              </Alert>
            )}

            {diagnosticInfo && (
              <Alert>
                <AlertDescription className="whitespace-pre-wrap font-mono text-xs">{diagnosticInfo}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Button onClick={runDiagnostics} disabled={diagnosticLoading} variant="outline" className="w-full">
                {diagnosticLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Run Diagnostics
              </Button>

              <Button onClick={createOrResetAdmin} disabled={loading} className="w-full">
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UserPlus className="w-4 h-4 mr-2" />}
                Create Admin User
              </Button>

              <Button onClick={resetPassword} disabled={loading} variant="secondary" className="w-full">
                Send Password Reset Email
              </Button>

              <Button onClick={autoConfirmEmail} disabled={loading} variant="outline" className="w-full text-success">
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MailCheck className="w-4 h-4 mr-2" />}
                🚀 Auto-Confirm Email
              </Button>

              <Button onClick={confirmEmailInstructions} disabled={loading} variant="ghost" className="w-full text-primary">
                📖 View Manual Instructions
              </Button>
            </div>

            {showReset && (
              <div className="space-y-2 pt-4 border-t">
                <label className="text-sm font-medium">New Password (optional)</label>
                <Input 
                  type="password" 
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use default password: {ADMIN_PASSWORD}
                </p>
              </div>
            )}

            <Button variant="ghost" onClick={() => navigate('/login')} className="w-full">
              Go to Login
            </Button>
          </CardContent>
        </Card>

        <div className="text-xs text-muted-foreground space-y-2">
          <p><strong>Troubleshooting:</strong></p>
          <ul className="list-disc list-inside space-y-1">
            <li>Check if email confirmation is required in Supabase Dashboard</li>
            <li>Go to Authentication &gt; Settings &gt; Email</li>
            <li>If "Confirm email" is enabled, check vanildinho@gmail.com inbox</li>
            <li>Or disable "Confirm email" for easier testing</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
