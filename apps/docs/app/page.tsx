import type { Metadata } from 'next';
import Home from './home';
import './home.css';

export const metadata: Metadata = {
  title: 'Nodal-Agents · your AI agents, your data, your machine',
  description:
    'A self-hosted platform that runs a team of AI agents on your own hardware. Any model, your own keys, an embedded database, and a dashboard. Open source, pre-1.0.',
};

export default function HomePage() {
  return <Home />;
}
