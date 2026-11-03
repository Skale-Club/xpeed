/** App identity is independent of the login provider's subject/UID. */
export interface AppUser {
  id: string;
  email?: string;
  phone?: string;
  user_metadata: { full_name?: string; avatar_url?: string };
}

let currentUser: AppUser | null = null;
export function setCurrentUser(user: AppUser | null) { currentUser = user; }
export async function getCurrentUser() { return { data: { user: currentUser }, error: null }; }
