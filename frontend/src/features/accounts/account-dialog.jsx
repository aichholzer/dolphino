import { useDraftGuard } from '../../hooks/use-draft-guard.mjs';
import { useState, useEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

export function AccountDialog({ account, close, busy, error, save, onDirtyChange }) {
  const [label, setLabel] = useState(''),
    [description, setDescription] = useState('');
  useEffect(() => {
    setLabel(account?.label || account?.name || '');
    setDescription(account?.description || '');
  }, [account]);
  useDraftGuard(
    onDirtyChange,
    'account',
    !!account &&
      (busy || label !== (account.label || account.name || '') || description !== (account.description || ''))
  );
  return (
    <Dialog
      open={!!account}
      onOpenChange={(v) => !v && close()}
      title="Edit account"
      description={
        account?.sourceType === 'manual'
          ? 'Edit this manual account’s label and description.'
          : 'Local details remain unchanged when your bank updates.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ label, description });
        }}
      >
        <label>
          Account label
          <input maxLength={120} required value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Description
          <input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Save account</Button>
        </div>
      </form>
    </Dialog>
  );
}
