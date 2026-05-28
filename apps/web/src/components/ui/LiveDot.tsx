type Variant = 'ok' | 'lime' | 'coral' | 'blue';

type Props = {
  variant?: Variant;
  size?: 'sm' | 'md';
  /** When false the dot is rendered solid without the pulsing halo. */
  animate?: boolean;
  className?: string;
};

const BG: Record<Variant, string> = {
  ok: 'bg-ok',
  lime: 'bg-agent-vivid',
  coral: 'bg-skill-vivid',
  blue: 'bg-conn-vivid',
};

const BLIP: Record<Variant, string> = {
  ok: 'animate-[blip_1.4s_ease-out_infinite]',
  lime: 'animate-[blip-lime_1.5s_ease-out_infinite]',
  coral: 'animate-[blip-coral_1.4s_ease-out_infinite]',
  blue: 'animate-[blip-blue_1.4s_ease-out_infinite]',
};

/**
 * LiveDot — a single coloured circle, optionally with the pulsing-halo
 * animation used to communicate "live / running" state. Foundational atom
 * shared by LiveCard, StatusPill, AgentStatus, etc.
 */
export default function LiveDot({
  variant = 'ok',
  size = 'sm',
  animate = true,
  className = '',
}: Props) {
  const dim = size === 'sm' ? 'h-[7px] w-[7px]' : 'h-2 w-2';
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${dim} ${BG[variant]} ${animate ? BLIP[variant] : ''} ${className}`}
    />
  );
}
