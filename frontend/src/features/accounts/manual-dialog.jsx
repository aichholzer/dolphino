import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Dialog } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { CategorySelect } from '../../components/category-select';
import { TransactionTags } from '../../components/transaction-tags';
import { useCategoryOptions } from '../../hooks/use-category-options.mjs';
import { useDraftGuard } from '../../hooks/use-draft-guard.mjs';
import { api } from '../../lib/api.mjs';
import { decimalToMinor, minorToDecimal, money } from '../../money.mjs';
import { formatStamp } from '../../lib/dates.mjs';

export function ManualDialog({ draft, close, saved, canEditAccount, onDirtyChange, timeZone }) {
  const [values, setValues] = useState({}),
    [accounts, setAccounts] = useState([]),
    [entry, setEntry] = useState(null),
    [audit, setAudit] = useState([]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [dirty, setDirty] = useState(false),
    [voiding, setVoiding] = useState(false);
  const flight = useRef(false),
    request = useRef('');
  const options = useCategoryOptions(draft?.entryId || draft?.account?.id || draft?.type);
  const [tagDraft, setTagDraft] = useState('');
  useDraftGuard(onDirtyChange, 'manual', !!draft && (dirty || busy || !!tagDraft));
  useEffect(() => {
    let current = true;
    setReady(false);
    setError('');
    setDirty(false);
    setVoiding(false);
    setEntry(null);
    setAudit([]);
    request.current = crypto.randomUUID();
    if (!draft) {
      return;
    }

    Promise.all([api('/accounts'), draft.entryId ? api(`/manual/entries/${draft.entryId}`) : null])
      .then(([a, result]) => {
        if (!current) {
          return;
        }

        setAccounts(a.accounts);
        const e = result?.entry,
          row = e?.transactions.find((t) => t.amountMinor.startsWith('-')) || e?.transactions[0];
        setEntry(e);
        setAudit(result?.audit || []);
        const account = a.accounts.find((item) => item.id === (row?.accountId || draft.account?.id));
        const other = e?.transactions.find((t) => t.accountId !== row.accountId);
        setValues({
          type: e?.type || draft.type,
          accountId: account?.id || '',
          name: '',
          description: row?.description || '',
          currency: account?.currency || 'AUD',
          date:
            row?.date ||
            new Intl.DateTimeFormat('en-CA', {
              timeZone: timeZone || 'Etc/UTC',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit'
            }).format(new Date()),
          amount: minorToDecimal(
            row?.amountMinor || (draft.type === 'adjustment' ? account?.balanceMinor : '0'),
            account?.currency
          ),
          kind: row?.kind || 'expense',
          category: row?.category || 'Uncategorized',
          tags: row?.tags || [],
          note: row?.note || '',
          reason: '',
          toAccountId: other?.accountId || '',
          received: other ? minorToDecimal(other.amountMinor, other.currency) : '',
          splits: (row?.splits || []).map((s) => ({
            category: s.category,
            amount: minorToDecimal(s.amountMinor, row.currency)
          }))
        });
        if (e?.type === 'transfer') {
          setValues((v) => ({ ...v, amount: minorToDecimal((-BigInt(row.amountMinor)).toString(), row.currency) }));
        }

        setReady(true);
      })
      .catch((e) => {
        if (current) {
          setError(e.message);
        }
      });
    return () => {
      current = false;
    };
  }, [draft, timeZone]);
  if (!draft) {
    return null;
  }

  const account = accounts.find((a) => a.id === values.accountId),
    other = accounts.find((a) => a.id === values.toAccountId);
  const editable = (a) => a.sourceType === 'manual' && !a.frozen && (a.canEdit || canEditAccount(a.id));
  const readOnly =
    !!entry &&
    (entry.voided || entry.transactions.some((t) => !accounts.some((a) => a.id === t.accountId && editable(a))));
  const change = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty(true);
  };

  const safeClose = () => {
    if (!busy && ((!dirty && !tagDraft) || window.confirm('Discard unsaved changes?'))) {
      close();
    }
  };

  const title =
    draft.type === 'lifecycle'
      ? `${draft.action[0].toUpperCase() + draft.action.slice(1)} account`
      : values.type === 'account'
        ? 'Add manual account'
        : entry
          ? 'Manual entry history'
          : values.type === 'adjustment'
            ? 'Adjust book balance'
            : values.type === 'transfer'
              ? 'Record a transfer'
              : 'Add manual entry';
  async function submit(event) {
    event.preventDefault();
    if (flight.current) {
      return;
    }

    flight.current = true;
    setBusy(true);
    setError('');
    try {
      let path,
        method = 'POST',
        body = { requestId: request.current };
      if (draft.type === 'lifecycle') {
        path = `/accounts/${draft.account.id}/lifecycle`;
        body = { ...body, revision: draft.account.revision, action: draft.action, reason: values.reason };
      } else if (values.type === 'account') {
        path = '/manual/accounts';
        body = {
          ...body,
          name: values.name,
          description: values.description,
          currency: values.currency,
          openingDate: values.date,
          openingBalanceMinor: decimalToMinor(values.amount, values.currency)
        };
      } else if (voiding) {
        path = `/manual/entries/${entry.id}/void`;
        body = { ...body, revision: entry.revision, reason: values.reason };
      } else {
        path = entry ? `/manual/entries/${entry.id}` : '/manual/entries';
        method = entry ? 'PATCH' : 'POST';
        body = {
          ...body,
          accountId: values.accountId,
          type: values.type,
          date: values.date,
          ...(entry ? { revision: entry.revision } : {})
        };
        if (values.type === 'activity') {
          body = {
            ...body,
            kind: values.kind,
            amountMinor: decimalToMinor(values.amount, values.currency),
            description: values.description,
            category: values.category,
            tags: values.tags,
            note: values.note,
            splits: values.splits.map((s) => ({
              category: s.category,
              amountMinor: decimalToMinor(s.amount, values.currency)
            }))
          };
        } else if (values.type === 'transfer') {
          body = {
            ...body,
            toAccountId: values.toAccountId,
            amountMinor: decimalToMinor(values.amount, values.currency),
            receivedMinor: decimalToMinor(
              other?.currency === values.currency ? values.amount : values.received,
              other?.currency
            )
          };
        } else {
          body = {
            ...body,
            reason: values.reason,
            ...(!entry && values.type === 'adjustment'
              ? {
                  targetBalanceMinor: decimalToMinor(values.amount, values.currency),
                  accountRevision: account.revision
                }
              : { amountMinor: decimalToMinor(values.amount, values.currency) })
          };
        }
      }

      await api(path, { method, body: JSON.stringify(body) });
      setDirty(false);
      close();
      await saved();
    } catch (e) {
      setError(e.message);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && safeClose()}
      title={title}
      description={draft.account?.name || 'Amounts remain exact; corrections are recorded in history.'}
    >
      {error && (
        <p role="alert" className="negative">
          {error}
        </p>
      )}
      {!ready ? (
        <p>Loading account details…</p>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy || readOnly} className="manual-fields">
            {draft.type === 'lifecycle' ? (
              <>
                <p>
                  {draft.action === 'delete'
                    ? 'This hides the account and all its history from transactions, exports, the assistant, reports and budget spending. Restore it under Settings > Data. Linked transfers remain transfers in other accounts. Feed imports continue into hidden history.'
                    : draft.action === 'freeze'
                      ? 'The account stays visible, its balance is excluded from totals, and manual financial changes are blocked. Past income and spending remain in reports. Feed imports continue.'
                      : draft.action === 'restore'
                        ? 'Restore the account and its historical report and budget totals, including feed updates received while hidden. Its previous frozen state is retained.'
                        : 'Include this account in balance totals and allow permitted manual entries again.'}
                </p>
              </>
            ) : (
              <>
                {values.type === 'account' && (
                  <>
                    <label>
                      Account name
                      <input
                        required
                        maxLength={100}
                        value={values.name}
                        onChange={(e) => change('name', e.target.value)}
                      />
                    </label>
                    <label>
                      Currency
                      <input
                        required
                        pattern="[A-Z]{3}"
                        value={values.currency}
                        onChange={(e) => change('currency', e.target.value.toUpperCase())}
                      />
                    </label>
                    <p className="footnote">
                      Manual and feed accounts stay separate. Both active balances count. No money is moved by recording
                      an entry.
                    </p>
                  </>
                )}
                <label>
                  {values.type === 'account' || values.type === 'opening' ? 'Opening date' : 'Date'}
                  <input type="date" required value={values.date} onChange={(e) => change('date', e.target.value)} />
                </label>
                {values.type === 'activity' && (
                  <label>
                    Entry type
                    <select value={values.kind} onChange={(e) => change('kind', e.target.value)}>
                      {['expense', 'income', 'refund'].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  {values.type === 'account' || values.type === 'opening'
                    ? 'Opening balance'
                    : values.type === 'adjustment' && !entry
                      ? 'Target balance at this date'
                      : values.type === 'adjustment'
                        ? 'Adjustment amount (signed)'
                        : values.type === 'transfer'
                          ? 'Amount sent'
                          : 'Amount (negative for expenses)'}
                  <input
                    required
                    inputMode="decimal"
                    value={values.amount}
                    onChange={(e) => change('amount', e.target.value)}
                  />
                </label>
                {values.type === 'transfer' && (
                  <>
                    <label>
                      To manual account
                      <select
                        required
                        disabled={!!entry}
                        value={values.toAccountId}
                        onChange={(e) => change('toAccountId', e.target.value)}
                      >
                        <option value="">Choose account</option>
                        {accounts
                          .filter((a) => editable(a) && a.id !== values.accountId)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} · {a.currency}
                            </option>
                          ))}
                      </select>
                    </label>
                    {other && other.currency !== values.currency && (
                      <label>
                        Amount received ({other.currency})
                        <input
                          required
                          inputMode="decimal"
                          value={values.received}
                          onChange={(e) => change('received', e.target.value)}
                        />
                      </label>
                    )}
                    <p className="footnote">
                      Both sides are saved, edited or voided together. Transfers do not count as income or spending.
                    </p>
                  </>
                )}
                {['account', 'activity'].includes(values.type) && (
                  <label>
                    Description
                    <input
                      required={values.type === 'activity'}
                      maxLength={500}
                      value={values.description}
                      onChange={(e) => change('description', e.target.value)}
                    />
                  </label>
                )}
                {values.type === 'activity' && (
                  <>
                    <label>
                      Category
                      <CategorySelect
                        catalog={options.catalog}
                        value={values.category}
                        required
                        onChange={(e) => change('category', e.target.value)}
                      />
                    </label>
                    <TransactionTags
                      tags={values.tags}
                      suggestions={options.tags}
                      onChange={(v) => change('tags', v)}
                      onDraftChange={setTagDraft}
                    />
                    <label>
                      Note
                      <input maxLength={1000} value={values.note} onChange={(e) => change('note', e.target.value)} />
                    </label>
                    {values.splits.map((s, i) => (
                      <div className="split-row" key={i}>
                        <CategorySelect
                          aria-label={`Split ${i + 1} category`}
                          catalog={options.catalog}
                          value={s.category}
                          onChange={(e) =>
                            change(
                              'splits',
                              values.splits.map((x, j) => (j === i ? { ...x, category: e.target.value } : x))
                            )
                          }
                        />
                        <input
                          aria-label={`Split ${i + 1} amount`}
                          value={s.amount}
                          onChange={(e) =>
                            change(
                              'splits',
                              values.splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x))
                            )
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove split ${i + 1}`}
                          onClick={() =>
                            change(
                              'splits',
                              values.splits.filter((_, j) => j !== i)
                            )
                          }
                        >
                          <X size={16} />
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        change('splits', [
                          ...values.splits,
                          { category: values.category, amount: values.splits.length ? '0' : values.amount }
                        ])
                      }
                    >
                      <Plus size={16} />
                      Add split
                    </Button>
                  </>
                )}
                {['opening', 'adjustment'].includes(values.type) && (
                  <p className="footnote">
                    This changes book balance only. It is excluded from income, spending and budgets.
                  </p>
                )}
              </>
            )}
            {(draft.type === 'lifecycle' || ['opening', 'adjustment'].includes(values.type) || voiding) && (
              <label>
                Reason
                <input
                  required
                  maxLength={500}
                  value={values.reason}
                  onChange={(e) => change('reason', e.target.value)}
                />
              </label>
            )}
            {voiding && (
              <p role="status">
                Void this entry{entry?.type === 'transfer' ? ' and both transfer sides' : ''}? Its effect on balance and
                reports is removed, and its history is retained.
              </p>
            )}
          </fieldset>
          {readOnly && (
            <p>
              This entry is read-only: it is voided, an account is frozen, or both edit permissions are not available.
            </p>
          )}
          {audit.length > 0 && (
            <details>
              <summary>Audit history ({audit.length})</summary>
              {audit.map((a, i) => (
                <div key={i} className="manual-audit">
                  <strong>
                    {a.action.replaceAll('-', ' ')} · {a.actor_name}
                  </strong>
                  <small>{formatStamp(a.created_at)}</small>
                  {a.before_value?.transactions?.map((t) => (
                    <p key={t.id}>
                      Before: {t.date} · {money(t.amountMinor, t.currency)} · {t.description} · {t.category}{' '}
                      {t.tags?.join(', ')} {t.note}
                    </p>
                  ))}
                  {a.after_value?.transactions?.map((t) => (
                    <p key={t.id}>
                      After: {t.date} · {money(t.amountMinor, t.currency)} · {t.description} · {t.category}{' '}
                      {t.tags?.join(', ')} {t.note}
                    </p>
                  ))}
                  <p>{a.after_value?.reason}</p>
                </div>
              ))}
            </details>
          )}
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={safeClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {entry && !readOnly && entry.type !== 'opening' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setVoiding(!voiding);
                  setDirty(true);
                  request.current = crypto.randomUUID();
                }}
              >
                {voiding ? 'Cancel void' : 'Void entry'}
              </Button>
            )}
            {!readOnly && (
              <Button disabled={busy || !!tagDraft}>
                {voiding ? 'Confirm void' : draft.type === 'lifecycle' ? 'Confirm' : 'Save'}
              </Button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
