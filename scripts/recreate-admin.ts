import { createClient } from '@supabase/supabase-js';
import { confirmDestructive, exitOnGuardError, guardDestructive } from '../db/guard-destructive.mjs';

// DESTRUCTIVE: deletes the admin auth user (which cascades to that user's rows) and creates it again.
// Legacy (the app signs in with Google now). Guarded by db/guard-destructive.mjs: a production host is
// refused unless --i-know-this-is-production and the host typed; otherwise the target is shown and its
// name must be typed back (or --yes).

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Missing ADMIN_EMAIL or ADMIN_PASSWORD in environment variables');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function recreateAdmin() {
    const action = 'delete the admin auth user and create it again';
    const guard = await guardDestructive({ target: supabaseUrl, action });
    await confirmDestructive({
        target: supabaseUrl,
        action,
        production: guard.production,
        plan: [`auth user ${ADMIN_EMAIL}: deleted if it exists (this also deletes the rows that belong to it), then created again`],
    });
    console.log(`🔍 Looking for user: ${ADMIN_EMAIL}`);

    const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
    
    if (listError) {
        console.error('❌ Error listing users:', listError.message);
        process.exit(1);
    }

    const user = users.find(u => u.email === ADMIN_EMAIL);

    if (user) {
        console.log(`🗑️ Deleting existing user: ${user.id}`);
        const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
        
        if (deleteError) {
            console.error('❌ Error deleting user:', deleteError.message);
            process.exit(1);
        }
        console.log('✅ User deleted.');
    } else {
        console.log('User does not exist, proceeding to create.');
    }

    console.log('🚀 Creating new admin user with email_confirm: true...');

    const { data, error } = await supabase.auth.admin.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: {
            full_name: 'Admin User'
        }
    });

    if (error) {
        console.error('❌ Error creating user:', error.message);
        process.exit(1);
    }

    if (!data.user) {
        console.error('❌ No user returned after creation');
        process.exit(1);
    }

    console.log('✅ User created successfully!');
    console.log('User ID:', data.user.id);
    console.log('Email confirmed:', data.user.email_confirmed_at);

    // Make admin in car_profiles
    console.log('👑 Promoting to admin in database...');
    
    // Check if profile exists
    const { data: existingProfile } = await supabase
        .from('car_profiles')
        .select('*')
        .eq('user_id', data.user.id)
        .single();

    if (existingProfile) {
        console.log('Profile exists, updating...');
        const { error: updateError } = await supabase
            .from('car_profiles')
            .update({ is_admin: true, name: 'Admin Profile' })
            .eq('id', existingProfile.id);
            
        if (updateError) console.error('❌ Error updating profile:', updateError.message);
        else console.log('✅ Admin profile updated.');
    } else {
        console.log('Profile does not exist, creating...');
        const { error: insertError } = await supabase
            .from('car_profiles')
            .insert({
                user_id: data.user.id,
                name: 'Admin Profile',
                notes: 'System Administrator',
                is_admin: true,
            });
            
        if (insertError) console.error('❌ Error creating profile:', insertError.message);
        else console.log('✅ Admin profile created.');
    }
}

recreateAdmin().catch((error) => {
    if (!exitOnGuardError(error)) { console.error(error); process.exitCode = 1; }
});
