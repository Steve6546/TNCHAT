import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app';
import { ToastProvider } from './components/ui/toast';
import './index.css';

// Supabase confirmation and recovery emails land on the site root with the
// token in the URL fragment. Rewrite to the callback path *before* the router
// mounts — once BrowserRouter owns history, a raw replaceState fights the
// router and drops the render.
if (window.location.hash.includes('access_token=')) {
  window.history.replaceState(null, '', `/auth/callback${window.location.hash}`);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
