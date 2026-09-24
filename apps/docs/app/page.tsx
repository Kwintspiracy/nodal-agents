import type { Metadata } from 'next';
import Home from './home';
import './home.css';

export const metadata: Metadata = {
  title: 'Nodal-Agents · an ongoing exploration of agent orchestration',
  description:
    'A personal project to understand how agent harnesses work by building one: delegation, autonomy, and following what agents do. Runs on your machine, pre-1.0, used by one person so far.',
};

export default function HomePage() {
  return <Home />;
}
