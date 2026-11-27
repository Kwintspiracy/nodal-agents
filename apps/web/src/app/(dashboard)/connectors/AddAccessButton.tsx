import PrimaryButton from '@/components/ui/PrimaryButton.tsx';

interface Props {
  /** The credential's type: the OAuth client, hence the start route's path. */
  credentialType: string;
  /** The connector whose rights are asked for. */
  connector: string;
  /** The credential the rights are added to. */
  credentialId: string;
  /** Where the callback returns (it appends ?credentialId=…). */
  returnTo: string;
  size?: 'sm' | 'md';
}

/**
 * One action to give a connector the rights its credential lacks: a new
 * authorisation, for this connector, on top of what the credential already
 * holds (the start route asks for the union). The person is sent to the
 * provider's consent screen; client id and secret are not asked again, the
 * credential's own are used.
 *
 * A native POST, like the credential wizard: the start route answers with a
 * redirect to the provider.
 */
export default function AddAccessButton({
  credentialType,
  connector,
  credentialId,
  returnTo,
  size = 'sm',
}: Props) {
  return (
    <form
      method="POST"
      action={`/api/oauth/${credentialType}/start`}
      encType="application/x-www-form-urlencoded"
      className="inline"
    >
      {/* eslint-disable-next-line no-restricted-syntax -- native hidden fields
          carried by the browser's own POST redirect into the OAuth flow; not
          visible fields, no design-system counterpart. */}
      <input type="hidden" name="connector" value={connector} />
      {/* eslint-disable-next-line no-restricted-syntax -- see above */}
      <input type="hidden" name="credentialId" value={credentialId} />
      {/* eslint-disable-next-line no-restricted-syntax -- see above */}
      <input type="hidden" name="returnTo" value={returnTo} />
      <PrimaryButton variant="blue" size={size} type="submit">
        Add access
      </PrimaryButton>
    </form>
  );
}
