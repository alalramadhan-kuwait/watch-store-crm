import { useState, useEffect } from 'react';
import { Plus, Trash2, KeyRound, ShieldCheck, Download } from 'lucide-react';
import { getSettings, saveSettings } from '../db';
import { exportLocalData } from '../db/local-export';
import { useAppStore } from '../store';
import { ConfirmModal } from './shared/Modal';
import type { AppSettings } from '../types';

export function Settings() {
  const { showToast } = useAppStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [newStaff, setNewStaff] = useState('');
  const [newLostReason, setNewLostReason] = useState('');
  const [newAction, setNewAction] = useState('');
  const [newChannel, setNewChannel] = useState('');

  const [staffCodeNew, setStaffCodeNew] = useState('');
  const [staffCodeConfirm, setStaffCodeConfirm] = useState('');
  const [staffCodeError, setStaffCodeError] = useState('');

  const [pinCurrent, setPinCurrent] = useState('');
  const [pinNew, setPinNew] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [showDeleteStaff, setShowDeleteStaff] = useState<string | null>(null);

  useEffect(() => { getSettings().then(setSettings); }, []);

  if (!settings) return null;

  async function addItem(
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels',
    value: string,
    setter: (v: string) => void
  ) {
    if (!value.trim() || !settings) return;
    const current = settings[field] as string[];
    if (current.includes(value.trim())) { showToast('Already exists.', 'info'); return; }
    const updated = [...current, value.trim()];
    await saveSettings({ [field]: updated });
    setSettings(s => s ? { ...s, [field]: updated } : s);
    setter('');
    showToast('Added.', 'success');
  }

  async function removeItem(
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels',
    value: string
  ) {
    if (!settings) return;
    const updated = (settings[field] as string[]).filter(v => v !== value);
    await saveSettings({ [field]: updated });
    setSettings(s => s ? { ...s, [field]: updated } : s);
    showToast('Removed.', 'info');
  }

  async function handleChangeStaffCode() {
    setStaffCodeError('');
    if (!settings) return;
    if (staffCodeNew.length < 4) { setStaffCodeError('Code must be at least 4 characters.'); return; }
    if (staffCodeNew !== staffCodeConfirm) { setStaffCodeError("Codes don't match."); return; }
    await saveSettings({ staffPin: staffCodeNew });
    setStaffCodeNew(''); setStaffCodeConfirm('');
    showToast('Staff code updated.', 'success');
  }

  async function handleChangePin() {
    setPinError('');
    if (!settings) return;
    if (pinCurrent !== settings.managerPin) { setPinError('Current PIN is incorrect.'); return; }
    if (pinNew.length < 4) { setPinError('New PIN must be at least 4 digits.'); return; }
    if (pinNew !== pinConfirm) { setPinError("PINs don't match."); return; }
    await saveSettings({ managerPin: pinNew });
    setPinCurrent(''); setPinNew(''); setPinConfirm('');
    showToast('PIN updated.', 'success');
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-5xl lg:px-8">
      <h1 className="text-2xl font-bold text-slate-900 mb-6 lg:mb-8">Settings</h1>

      {/* Two-column grid on desktop */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0">
        <ListEditor title="Staff Roster" items={settings.staffRoster} newValue={newStaff}
          onNewValueChange={setNewStaff} onAdd={() => addItem('staffRoster', newStaff, setNewStaff)}
          onRemove={v => setShowDeleteStaff(v)} placeholder="Staff name" />

        <ListEditor title="Lost Sale Reasons" items={settings.lostReasons} newValue={newLostReason}
          onNewValueChange={setNewLostReason} onAdd={() => addItem('lostReasons', newLostReason, setNewLostReason)}
          onRemove={v => removeItem('lostReasons', v)} placeholder="New reason" />

        <ListEditor title="Follow-up Actions" items={settings.followUpActions} newValue={newAction}
          onNewValueChange={setNewAction} onAdd={() => addItem('followUpActions', newAction, setNewAction)}
          onRemove={v => removeItem('followUpActions', v)} placeholder="New action" />

        <ListEditor title="Contact Channels" items={settings.channels} newValue={newChannel}
          onNewValueChange={setNewChannel} onAdd={() => addItem('channels', newChannel, setNewChannel)}
          onRemove={v => removeItem('channels', v)} placeholder="New channel" />
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:gap-6 space-y-6 lg:space-y-0 mt-6">

      {/* Change Staff Access Code */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-5 h-5 text-brand-700" />
          <h2 className="font-bold text-slate-900">Change Staff Access Code</h2>
        </div>
        <p className="text-xs text-slate-500 mb-3">Used at the login screen for staff.</p>
        <div className="space-y-3">
          <div>
            <label className="label">New Code (min 4 characters)</label>
            <input type="password" value={staffCodeNew} onChange={e => setStaffCodeNew(e.target.value)}
              placeholder="New access code" className="input" autoComplete="off" />
          </div>
          <div>
            <label className="label">Confirm New Code</label>
            <input type="password" value={staffCodeConfirm} onChange={e => setStaffCodeConfirm(e.target.value)}
              placeholder="Repeat code" className="input" autoComplete="off" />
          </div>
          {staffCodeError && <p className="text-rose-500 text-sm">{staffCodeError}</p>}
          <button onClick={handleChangeStaffCode} className="btn-primary w-full">Update Staff Code</button>
        </div>
      </div>

      {/* Change Manager PIN */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="w-5 h-5 text-brand-700" />
          <h2 className="font-bold text-slate-900">Change Manager PIN</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Current PIN</label>
            <input type="password" value={pinCurrent} onChange={e => setPinCurrent(e.target.value)}
              placeholder="••••" className="input" inputMode="numeric" />
          </div>
          <div>
            <label className="label">New PIN (min 4 digits)</label>
            <input type="password" value={pinNew} onChange={e => setPinNew(e.target.value)}
              placeholder="••••" className="input" inputMode="numeric" />
          </div>
          <div>
            <label className="label">Confirm New PIN</label>
            <input type="password" value={pinConfirm} onChange={e => setPinConfirm(e.target.value)}
              placeholder="••••" className="input" inputMode="numeric" />
          </div>
          {pinError && <p className="text-rose-500 text-sm">{pinError}</p>}
          <button onClick={handleChangePin} className="btn-primary w-full">Update PIN</button>
        </div>
      </div>

      </div>

      {/* Local data export */}
      <div className="card p-5 mt-6">
        <div className="flex items-center gap-2 mb-2">
          <Download className="w-5 h-5 text-slate-500" />
          <h2 className="font-bold text-slate-900">Export Local Data</h2>
        </div>
        <p className="text-xs text-slate-500 mb-3">Download any data still stored locally in this browser before it is cleared.</p>
        <button onClick={exportLocalData} className="btn-secondary w-full">Download Local Backup (JSON)</button>
      </div>

      {/* Brand footer */}
      <div className="flex flex-col items-center pb-4 gap-1 mt-6">
        <img src={`${import.meta.env.BASE_URL}tk-logo-text.png`} alt="TIME KEEPER" className="w-36 object-contain opacity-60" />
        <p className="text-xs text-slate-400">Default manager PIN: <span className="font-mono font-medium">1234</span></p>
      </div>

      <ConfirmModal open={!!showDeleteStaff} onClose={() => setShowDeleteStaff(null)}
        onConfirm={() => { removeItem('staffRoster', showDeleteStaff!); setShowDeleteStaff(null); }}
        title="Remove Staff Member"
        message={`Remove ${showDeleteStaff} from the roster? Existing entries won't be affected.`}
        confirmLabel="Remove" danger />
    </div>
  );
}

function ListEditor({ title, items, newValue, onNewValueChange, onAdd, onRemove, placeholder }: {
  title: string; items: string[]; newValue: string;
  onNewValueChange: (v: string) => void; onAdd: () => void; onRemove: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="card p-5">
      <h2 className="font-bold text-slate-900 mb-4">{title}</h2>
      <div className="space-y-2 mb-4">
        {items.map(item => (
          <div key={item} className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-xl">
            <span className="text-sm font-medium text-slate-700">{item}</span>
            <button onClick={() => onRemove(item)} className="p-1.5 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 transition-colors">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={newValue} onChange={e => onNewValueChange(e.target.value)} placeholder={placeholder}
          className="input text-sm py-2.5 flex-1" onKeyDown={e => e.key === 'Enter' && onAdd()} />
        <button onClick={onAdd} className="flex items-center gap-1.5 btn-primary py-2.5 px-4 text-sm">
          <Plus className="w-4 h-4" /> Add
        </button>
      </div>
    </div>
  );
}
