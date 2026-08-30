import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { SessionPayload } from '../lib/types';
import { clockSkew } from '../lib/session';

interface AuthState {
  token: string | null;
  /** Expiry as an instant on the *server's* clock, in epoch ms. */
  expiresAt: number | null;
  /** Server clock − browser clock, measured when the session was issued. */
  skewMs: number;
  setSession: (session: SessionPayload) => void;
  logout: () => void;
}

const EMPTY = { token: null, expiresAt: null, skewMs: 0 };

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      ...EMPTY,
      setSession: (session) =>
        set({
          token: session.token,
          expiresAt: Date.parse(session.expiresAt) || null,
          skewMs: clockSkew(session.serverTime),
        }),
      logout: () => set({ ...EMPTY }),
    }),
    {
      name: 'acc-session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        token: state.token,
        expiresAt: state.expiresAt,
        skewMs: state.skewMs,
      }),
    },
  ),
);
