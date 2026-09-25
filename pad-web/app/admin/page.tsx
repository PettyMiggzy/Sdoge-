import type { Metadata } from 'next';
import { AdminPanel } from '@/components/AdminPanel';

// Not linked from anywhere; only the pad admin wallet can use the switch.
export const metadata: Metadata = { title: 'Pad admin', robots: { index: false, follow: false } };

export default function Admin() {
  return <AdminPanel />;
}
