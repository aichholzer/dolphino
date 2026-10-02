import { useEffect, useState } from 'react';
import { api } from '../../lib/api.mjs';
import { Button } from '../../components/ui/button';
import { useSettingsDirty } from './settings-dirty';

export function CategoriesSettings() {
  const [catalog, setCatalog] = useState([]);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useSettingsDirty(busy || !!name || !!editing);
  useEffect(() => {
    let current = true;
    api('/settings/categories')
      .then((data) => {
        if (current) {
          setCatalog(data.catalog);
        }
      })
      .catch((error) => {
        if (current) {
          setError(error.message);
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, []);
  async function save(method, value) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/settings/categories', { method, body: JSON.stringify(value) });
      const data = await api('/settings/categories');
      setCatalog(data.catalog);
      setName('');
      setEditing(null);
      setNotice(method === 'DELETE' ? 'Category archived. History and budgets are preserved.' : 'Category saved.');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card settings-card">
      <h2>Your categories</h2>
      <p className="muted">
        Choose existing categories when reviewing transactions or making budgets. Renaming updates their display name
        everywhere. Deleting archives a category: past transactions, budgets and totals stay intact.
      </p>
      {error && (
        <p role="alert" className="negative">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        className="category-create"
        onSubmit={(event) => {
          event.preventDefault();
          save('POST', { name });
        }}
      >
        <label>
          New category
          <input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <Button disabled={busy || loading || !name.trim()}>Create category</Button>
      </form>
      {loading ? (
        <p role="status">Loading categories…</p>
      ) : (
        <ul className="category-settings-list">
          {catalog.map((entry) => (
            <li key={entry.category}>
              {editing?.category === entry.category ? (
                <form
                  className="category-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save('PATCH', editing);
                  }}
                >
                  <label>
                    Category name
                    <input
                      autoFocus
                      required
                      maxLength={100}
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                    />
                  </label>
                  <Button disabled={busy || !editing.name.trim()}>Save name</Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span>
                    {entry.name}
                    {entry.archived && <small> · Archived</small>}
                  </span>
                  {entry.category !== 'Uncategorized' && (
                    <div className="category-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Rename ${entry.name}`}
                        onClick={() => setEditing({ category: entry.category, name: entry.name })}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`${entry.archived ? 'Restore' : 'Delete'} ${entry.name}`}
                        onClick={() =>
                          save(entry.archived ? 'PATCH' : 'DELETE', {
                            category: entry.category,
                            ...(entry.archived ? { archived: false } : {})
                          })
                        }
                      >
                        {entry.archived ? 'Restore' : 'Delete (archive)'}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
