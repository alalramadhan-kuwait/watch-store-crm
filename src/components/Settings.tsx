import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2, LogOut, KeyRound } from 'lucide-react';
import { getSettings, saveSettings } from '../db';
import { useAppStore } from '../store';
import { ConfirmModal } from './shared/Modal';

export function Settings() {
  const { showToast, setManagerAuthed } = useAppStore();
  const settings = useLiveQuery(() => getSettings());

  const [newStaff, setNewStaff] = useState('');
  const [newLostReason, setNewLostReason] = useState('');
  const [newAction, setNewAction] = useState('');
  const [newChannel, setNewChannel] = useState('');

  const [pinCurrent, setPinCurrent] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [showDeleteStaff, setShowDeleteStaff] = useState<string | null>(null);

  if (!settings) return null;

  async function addItem(
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels',
    value: string,
    setter: (v: string) => void
  ) {
    if (!value.trim() || !settings) return;
    const current = settings[field] as string[];
    if (current.includes(value.trim())) { showToast('Already exists.', 'info'); return; }
    await saveSettings({ [field]: [...current, value.trim()] });
    setter('');
    showToast('Added.', 'success');
  }

  async function removeItem(
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels',
    value: string
  ) {
    if (!settings) return;
    const current = settings[field] as string[];
    await saveSettings({ [field]: current.filter(v => v !== value) });
    showToast('Removed.', 'info');
  }

  async function handleChangePin() {
    setPinError('');
    if (!settings) return;
    if (pinCurrent !== settings.managerPin) { setPinError('Current PIN is incorrect.'); return; }
    if (pinNew.length < 4) { setPinError('New PIN must be at least 4 digits.'); return; }
    if (pinNew !== pinConfirm) { setPinError('PINs don\'t match.'); return; }
    await saveSettings({ managerPin: pinNew });
    setPinCurrent(''); setPinNew(''); setPinConfirm('');
    showToast('PIN updated.', 'success');
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <button
          onClick={() => setManagerAuthed(false)}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 py-2 px-3 rounded-xl hover:bg-slate-100"
        >
          <LogOut className="w-4 h-4" /> Lock
        </button>
      </div>

      {/* Staff Roster */}
      <ListEditor
        title="Staff Roster"
        items={settings.staffRoster}
        newValue={newStaff}
        onNewValueChange={setNewStaff}
        onAdd={() => addItem('staffRoster', newStaff, setNewStaff)}
        onRemove={v => setShowDeleteStaff(v)}
        placeholder="Staff name"
      />

      {/* Lost Reasons */}
      <ListEditor
        title="Lost Sale Reasons"
        items={settings.lostReasons}
        newValue={newLostReason}
        onNewValueChange={setNewLostReason}
        onAdd={() => addItem('lostReasons', newLostReason, setNewLostReason)}
        onRemove={v => removeItem('lostReasons', v)}
        placeholder="New reason"
      />

      {/* Follow-up Actions */}
      <ListEditor
        title="Follow-up Actions"
        items={settings.followUpActions}
        newValue={newAction}
        onNewValueChange={setNewAction}
        onAdd={() => addItem('followUpActions', newAction, setNewAction)}
        onRemove={v => removeItem('followUpActions', v)}
        placeholder="New action"
      />

      {/* Channels */}
      <ListEditor
        title="Contact Channels"
        items={settings.channels}
        newValue={newChannel}
        onNewValueChange={setNewChannel}
        onAdd={() => addItem('channels', newChannel, setNewChannel)}
        onRemove={v => removeItem('channels', v)}
        placeholder="New channel"
      />

      {/* Change PIN */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="w-5 h-5 text-brand-700" />
          <h2 className="font-bold text-slate-900">Change Manager PIN</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Current PIN</label>
            <input
              type="password"
              value={pinCurrent}
              onChange={e => setPinCurrent(e.target.value)}
              placeholder="••••"
              className="input"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="label">New PIN (min 4 digits)</label>
            <input
              type="password"
              value={pinNew}
              onChange={e => setPinNew(e.target.value)}
              placeholder="••••"
              className="input"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="label">Confirm New PIN</label>
            <input
              type="password"
              value={pinConfirm}
              onChange={e => setPinConfirm(e.target.value)}
              placeholder="••••"
              className="input"
              inputMode="numeric"
            />
          </div>
          {pinError && <p className="text-rose-500 text-sm">{pinError}</p>}
          <button onClick={handleChangePin} className="btn-primary w-full">Update PIN</button>
        </div>
      </div>

      {/* App info */}
      <div className="text-center text-xs text-slate-400 pb-4">
        <p>Watch Store Daily Log · v1.0</p>
        <p className="mt-1">Default manager PIN: <span className="font-mono">1234</span></p>
      </div>

      <ConfirmModal
        open={!!showDeleteStaff}
        onClose={() => setShowDeleteStaff(null)}
        onConfirm={() => { removeItem('staffRoster', showDeleteStaff!); setShowDeleteStaff(null); }}
        title="Remove Staff Member"
        message={`Remove ${showDeleteStaff} from the roster? Existing entries won't be affected.`}
        confirmLabel="Remove"
        danger
      />
    </div>
  );
}

function ListEditor({
  title, items, newValue, onNewValueChange, onAdd, onRemove, placeholder,
}: {
  title: string;
  items: string[];
  newValue: string;
  onNewValueChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="card p-5">
      <h2 className="font-bold text-slate-900 mb-4">{title}</h2>
      <div className="space-y-2 mb-4">
        {items.map(item => (
          <div key={item} className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-xl">
            <span className="text-sm font-medium text-slate-700">{item}</span>
            <button
              onClick={() => onRemove(item)}
              className="p-1.5 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={newValue}
          onChange={e => onNewValueChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm py-2.5 flex-1"
          onKeyDown={e => e.key === 'Enter' && onAdd()}
        />
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 btn-primary py-2.5 px-4 text-sm"
        >
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>
    </div>
  );
}
