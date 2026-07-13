'use client';

/**
 * TimezoneForm — the workspace timezone. Authoritative for "what time is it"
 * reasoning and cron scheduling: agents read the current local time from it and
 * schedule automations in it. Captured from the browser at onboarding; editable
 * here. A "Detect from this browser" button re-captures the current device zone.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setWorkspaceTimezoneAction } from '@/lib/actions.ts';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import TextInput from '@/components/ui/TextInput';

interface Props {
  initial: string;
  isExplicit: boolean;
}

// A short, common subset; the field also accepts any IANA name the user types
// or the browser detects.
const COMMON_ZONES = [
  'Europe/Paris',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'UTC',
];

export default function TimezoneForm({ initial, isExplicit }: Props) {
  const [tz, setTz] = useState(initial);
  const [isPending, startTransition] = useTransition();

  const options = Array.from(new Set([initial, ...COMMON_ZONES]));

  function detectFromBrowser() {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected) setTz(detected);
    } catch {
      toast.error('Could not detect the browser timezone.');
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const r = await setWorkspaceTimezoneAction({ timezone: tz });
      if (!r.ok) toast.error(r.message);
      else toast.success(`Timezone set to ${tz} — agents schedule and read time in this zone.`);
    });
  }

  const nowLabel = (() => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date());
    } catch {
      return '';
    }
  })();

  return (
    <form onSubmit={handleSubmit}>
      <SetForm>
        <div className="space-y-2">
          <p className="text-[13px] leading-[1.5] text-ink-3">
            The timezone your agents use to tell the time and schedule automations. Detected from
            your browser at setup
            {isExplicit ? '' : ' (currently the server default — set it to be sure)'}.
            {nowLabel ? ` It is currently ${nowLabel} there.` : ''}
          </p>
          <div className="flex items-center gap-2">
            <TextInput
              list="tz-options"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              placeholder="e.g. Europe/Paris"
            />
            <datalist id="tz-options">
              {options.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <RowActionButton onClick={detectFromBrowser} className="shrink-0">
              Detect
            </RowActionButton>
          </div>
        </div>
        <SetCtaRow onCancel={() => setTz(initial)} pending={isPending} />
      </SetForm>
    </form>
  );
}
