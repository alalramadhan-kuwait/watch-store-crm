import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Tag, Eye, EyeOff, Edit2, Store } from 'lucide-react';
import { getSettings, saveSettings, getBrands, addBrand, toggleBrand, renameBrand, deleteBrand } from '../db';
import { useAppStore } from '../store';
import { ConfirmModal } from './shared/Modal';
import type { AppSettings, Brand } from '../types';

export function Settings() {
  const { showToast } = useAppStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [newBrandName, setNewBrandName] = useState('');
  const [editingBrand, setEditingBrand] = useState<{ id: string; name: string } | null>(null);
  const [deletingBrand, setDeletingBrand] = useState<Brand | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [newStaff, setNewStaff] = useState('');
  const [newLostReason, setNewLostReason] = useState('');
  const [newAction, setNewAction] = useState('');
  const [newChannel, setNewChannel] = useState('');
  const [newOutlet, setNewOutlet] = useState('');

  const [showDeleteStaff, setShowDeleteStaff] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
    getBrands().then(setBrands);
  }, []);

  async function handleAddBrand() {
    const name = newBrandName.trim();
    if (!name) return;
    if (brands.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      showToast('Brand already exists.', 'info'); return;
    }
    await addBrand(name);
    const updated = await getBrands();
    setBrands(updated);
    setNewBrandName('');
    showToast('Brand added.', 'success');
  }

  async function handleToggleBrand(brand: Brand) {
    await toggleBrand(brand.id, !brand.is_active);
    setBrands(prev => prev.map(b => b.id === brand.id ? { ...b, is_active: !b.is_active } : b));
    showToast(brand.is_active ? 'Brand hidden.' : 'Brand shown.', 'info');
  }

  function startRenameBrand(brand: Brand) {
    setEditingBrand({ id: brand.id, name: brand.name });
    setTimeout(() => renameInputRef.current?.select(), 30);
  }

  async function handleSaveRename() {
    if (!editingBrand) return;
    const name = editingBrand.name.trim();
    const original = brands.find(b => b.id === editingBrand.id)?.name;
    if (!name || name === original) { setEditingBrand(null); return; }
    if (brands.some(b => b.name.toLowerCase() === name.toLowerCase() && b.id !== editingBrand.id)) {
      showToast('Brand name already exists.', 'error'); return;
    }
    await renameBrand(editingBrand.id, name);
    setBrands(prev => prev.map(b => b.id === editingBrand.id ? { ...b, name } : b));
    setEditingBrand(null);
    showToast('Brand renamed.', 'success');
  }

  async function handleDeleteBrand() {
    if (!deletingBrand) return;
    await deleteBrand(deletingBrand.id);
    setBrands(prev => prev.filter(b => b.id !== deletingBrand.id));
    setDeletingBrand(null);
    showToast('Brand deleted.', 'success');
  }

  if (!settings) return null;

  async function addItem(
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels' | 'outlets',
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
    field: 'staffRoster' | 'lostReasons' | 'followUpActions' | 'channels' | 'outlets',
    value: string
  ) {
    if (!settings) return;
    const updated = (settings[field] as string[]).filter(v => v !== value);
    await saveSettings({ [field]: updated });
    setSettings(s => s ? { ...s, [field]: updated } : s);
    showToast('Removed.', 'info');
  }

  return (
    <div className="px-4 pt-6 pb-32 max-w-lg mx-auto lg:max-w-none lg:px-8">
      <h1 className="text-2xl font-bold text-slate-900 mb-6 lg:mb-8">Settings</h1>

      {/* Brand Catalog */}
      <div className="card p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Tag className="w-5 h-5 text-brand-700" />
          <h2 className="font-bold text-slate-900">Brand Catalog</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-4 sm:grid-cols-3 lg:grid-cols-4">
          {brands.map(brand => (
            <div key={brand.id}
              className={`flex items-center justify-between px-3 py-2.5 rounded-xl border-2 transition-all ${
                brand.is_active ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-50'}`}>
              <div className="min-w-0 flex-1">
                {editingBrand?.id === brand.id ? (
                  <input
                    ref={renameInputRef}
                    value={editingBrand.name}
                    onChange={e => setEditingBrand(prev => prev ? { ...prev, name: e.target.value } : prev)}
                    onBlur={handleSaveRename}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setEditingBrand(null); }}
                    className="w-full text-sm font-medium border border-brand-300 rounded-lg px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-brand-200"
                    autoComplete="off"
                  />
                ) : (
                  <span className={`text-sm font-medium truncate block ${brand.is_active ? 'text-slate-800' : 'text-slate-400'}`}>{brand.name}</span>
                )}
                {(brand.usageCount ?? 0) > 0 && (
                  <span className="text-xs text-slate-400">{brand.usageCount} uses</span>
                )}
              </div>
              <div className="flex items-center gap-0.5 ml-1.5 shrink-0">
                <button onClick={() => startRenameBrand(brand)}
                  className="p-1 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50 transition-colors"
                  title="Rename brand">
                  <Edit2 className="w-3 h-3" />
                </button>
                <button onClick={() => handleToggleBrand(brand)}
                  className="p-1 rounded-lg text-slate-400 hover:text-brand-700 hover:bg-brand-50 transition-colors"
                  title={brand.is_active ? 'Hide brand' : 'Show brand'}>
                  {brand.is_active ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                </button>
                {(brand.usageCount ?? 0) === 0 && (
                  <button onClick={() => setDeletingBrand(brand)}
                    className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                    title="Delete brand">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newBrandName} onChange={e => setNewBrandName(e.target.value)}
            placeholder="New brand name" className="input text-sm py-2.5 flex-1"
            onKeyDown={e => e.key === 'Enter' && handleAddBrand()} />
          <button onClick={handleAddBrand} className="flex items-center gap-1.5 btn-primary py-2.5 px-4 text-sm">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2">Brands with existing entries can be hidden but not deleted. Click the pencil to rename.</p>
      </div>

      {/* Outlets */}
      <div className="card p-5 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Store className="w-5 h-5 text-brand-700" />
          <h2 className="font-bold text-slate-900">Outlets</h2>
        </div>
        <div className="space-y-2 mb-4">
          {settings.outlets.map(outlet => (
            <div key={outlet} className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-xl">
              <span className="text-sm font-medium text-slate-700">{outlet}</span>
              <button onClick={() => removeItem('outlets', outlet)} className="p-1.5 text-slate-400 hover:text-rose-500 rounded-lg hover:bg-rose-50 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={newOutlet} onChange={e => setNewOutlet(e.target.value)} placeholder="New outlet name"
            className="input text-sm py-2.5 flex-1" onKeyDown={e => e.key === 'Enter' && addItem('outlets', newOutlet, setNewOutlet)} />
          <button onClick={() => addItem('outlets', newOutlet, setNewOutlet)} className="flex items-center gap-1.5 btn-primary py-2.5 px-4 text-sm">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2">Staff choose their outlet at login each session.</p>
      </div>

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

      {/* Brand footer */}
      <div className="flex flex-col items-center pb-4 gap-1 mt-6">
        <img src={`${import.meta.env.BASE_URL}tk-logo-text.png`} alt="TIME KEEPER" className="w-36 object-contain opacity-60" />
      </div>

      <ConfirmModal open={!!showDeleteStaff} onClose={() => setShowDeleteStaff(null)}
        onConfirm={() => { removeItem('staffRoster', showDeleteStaff!); setShowDeleteStaff(null); }}
        title="Remove Staff Member"
        message={`Remove ${showDeleteStaff} from the roster? Existing entries won't be affected.`}
        confirmLabel="Remove" danger />

      <ConfirmModal open={!!deletingBrand} onClose={() => setDeletingBrand(null)}
        onConfirm={handleDeleteBrand}
        title="Delete Brand"
        message={`Permanently delete "${deletingBrand?.name}"? This cannot be undone.`}
        confirmLabel="Delete" danger />
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
