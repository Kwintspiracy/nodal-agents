import { redirect } from 'next/navigation';

// In local-trust mode (default), land directly on the dashboard.
// In auth modes, the proxy handles redirecting unauthenticated users.
export default function HomePage() {
  redirect('/stats');
}
