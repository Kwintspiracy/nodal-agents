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
  /**
   * What the person is doing: adding the rights a connector lacks, or
   * authorising again a grant the provider ended. The same gesture either way.
   */
  label: 'Add access' | 'Reconnect';
  size?: 'sm' | 'md';
}

/**
 * Authorise a credential again, IN PLACE: a new authorisation for this
 * connector on top of what the credential already holds (the start route asks
 * for the union), whose answer the OAuth return writes over the same
 * credential row. Every connector bound to it, and every agent holding one of
 * them, works again; nothing is created. Used both to add rights a connector
 * lacks and to reconnect a grant the provider ended. Client id and secret are
 * not asked again, the credential's own are used.
 *
 * A native POST, like the credential wizard: the start route answers with a
 * redirect to the provider.
 */
export default function ReauthoriseButton({
  credentialType,
  connector,
  credentialId,
  returnTo,
  label,
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
        {label}
      </PrimaryButton>
    </form>
  );
}
