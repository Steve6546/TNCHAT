import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { AuthSession } from '../lib/types';

/**
 * The dashboard session.
 *
 * `token` authorises `/api/*` calls. It has no server-side expiry: a session
 * ends only when the user signs out or this browser tab closes — the store
 * persists to `sessionStorage`, which the browser drops with the tab.
 *
 * `supabaseAccessToken` is kept alongside so the settings page can manage the
 * Supabase account (password change) directly.
 */
interface AuthState {
  token: string | null;
  email: string | null;
  supabaseAccessToken: string | null;
  setSession: (session: AuthSession) => void;
  setSupabaseAccessToken: (accessToken: string) => void;
  logout: () => void;
}

const EMPTY = { token: null, email: null, supabaseAccessToken: null };

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...EMPTY,
      setSession: (session) =>
        set({
          token: session.token,
          email: session.email,
          supabaseAccessToken: session.supabaseAccessToken,
        }),
      setSupabaseAccessToken: (accessToken) => set({ supabaseAccessToken: accessToken }),
      logout: () => set({ ...EMPTY }),
    }),
    {
      name: 'acc-session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        token: state.token,
        email: state.email,
        supabaseAccessToken: state.supabaseAccessToken,
      }),
    },
  ),
);
