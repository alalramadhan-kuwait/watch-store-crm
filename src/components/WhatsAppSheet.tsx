import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, X, Languages } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAppStore } from '../store';
import { getMessageTemplates, getRosterEmployees, getSettings, logWhatsAppHandoff, type MessageTemplate } from '../db';
import { renderTemplate, greetingName, whatsappLink, type TemplateKey, type TemplateLang } from '../shared/messageRules';

export interface WhatsAppTarget {
  customerId: string;
  name: string | null;
  /** E.164, or null when the number on file cannot be messaged. */
  phone: string | null;
}

/**
 * The WhatsApp handoff.
 *
 * Pick a template, pick the language, read the message, change it if you
 * like, and then WhatsApp opens with it typed in. Nothing is sent from here:
 * the salesperson presses Send in WhatsApp, or does not. What is recorded is
 * that the handoff happened — which template, to whom, by whom — and that
 * record never marks a follow-up as contacted. Contacted is a decision the
 * salesperson makes afterwards, on the Follow-ups page, once they know the
 * message went.
 *
 * On the shared shop phone the message is attributed to the salesperson
 * named at the top, and signed with their name. The database refuses a
 * handoff to a customer this login has no relationship with.
 */
export function WhatsAppSheet({ target, caseId, product, defaultTemplate = 'general_followup', onClose, onOpened }: {
  target: WhatsAppTarget;
  caseId?: string | null;
  product?: string | null;
  defaultTemplate?: TemplateKey;
  onClose: () => void;
  onOpened?: () => void;
}) {
  const { role, salesName } = useAuth();
  const { activeOutlet, lastStaff, showToast } = useAppStore();
  const shared = role === 'staff';

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [roster, setRoster] = useState<string[]>([]);
  const [sender, setSender] = useState(shared ? lastStaff : (salesName ?? ''));
  const [key, setKey] = useState<string>(defaultTemplate);
  const [lang, setLang] = useState<TemplateLang>('en');
  const [text, setText] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getMessageTemplates().then(setTemplates).catch(() => setTemplates([]));
    if (shared) void getSettings().then(s => setRoster(s.staffRoster));
  }, [shared]);

  const keys = useMemo(() => Array.from(new Set(templates.map(t => t.key))), [templates]);
  const titleOf = (k: string) => templates.find(t => t.key === k && t.lang === 'en')?.title ?? k;
  const current = templates.find(t => t.key === key && t.lang === lang) ?? null;

  const rendered = useMemo(() => current ? renderTemplate(current.body, {
    first_name: greetingName(target.name),
    salesperson: sender || null,
    store: activeOutlet,
    product: product ?? null,
  }) : '', [current, target.name, sender, activeOutlet, product]);

  /* The text follows the template until the salesperson touches it; after
     that it is theirs, and switching language or template starts again. */
  useEffect(() => { if (!edited) setText(rendered); }, [rendered, edited]);
  function pick(k: string) { setKey(k); setEdited(false); }
  function switchLang(l: TemplateLang) { setLang(l); setEdited(false); }

  const link = whatsappLink(target.phone, text);
  const can = !!link && text.trim().length > 0 && (!shared || !!sender);

  async function open() {
    if (!link) return;
    if (shared && !sender) { showToast('Choose who is sending first.', 'error'); return; }
    setBusy(true);
    try {
      let employeeId: string | null = null;
      if (shared) {
        employeeId = (await getRosterEmployees()).get(sender) ?? null;
        if (!employeeId) throw new Error(`${sender} is not linked to an employee record yet.`);
      }
      await logWhatsAppHandoff(target.customerId, key, lang, employeeId, caseId ?? null);
      /* Opened after the record is written, so "we logged it" and "WhatsApp
         opened" can never disagree. A blocked popup still leaves the link. */
      const w = window.open(link, '_blank', 'noopener');
      if (!w) window.location.href = link;
      onOpened?.();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not open WhatsApp.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={() => !busy && onClose()} />
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-3xl shadow-2xl max-h-[92vh] overflow-y-auto lg:max-w-lg lg:mx-auto lg:bottom-6 lg:rounded-3xl">
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mt-3 mb-1 lg:hidden" />
        <div className="px-5 pt-3 pb-3 border-b border-slate-100 flex items-start gap-3">
          <MessageCircle className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-slate-900">WhatsApp {target.name || 'the customer'}</p>
            <p className="text-xs text-slate-500">{target.phone ?? 'No number that can be messaged'}</p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {shared && (
            <div>
              <label className="label">Sending as</label>
              <select value={sender} onChange={e => { setSender(e.target.value); setEdited(false); }} className="input">
                <option value="">— Select —</option>
                {roster.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="label mb-0">Message</label>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold">
                {(['en', 'ar'] as const).map(l => (
                  <button key={l} type="button" onClick={() => switchLang(l)}
                    className={`px-3 py-1 flex items-center gap-1 ${lang === l ? 'bg-slate-900 text-white' : 'text-slate-600'}`}>
                    {l === 'en' ? <><Languages className="w-3 h-3" /> English</> : 'العربية'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
              {keys.map(k => (
                <button key={k} type="button" onClick={() => pick(k)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${key === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-slate-600 border-slate-200'}`}>
                  {titleOf(k)}
                </button>
              ))}
            </div>
            <textarea value={text} onChange={e => { setText(e.target.value); setEdited(true); }} rows={6}
              dir={lang === 'ar' ? 'rtl' : 'ltr'} className="input resize-none text-sm leading-relaxed" />
            <p className="text-[11px] text-slate-400 mt-1">
              Read it before you send. WhatsApp opens with this typed in; nothing goes until you press Send there.
            </p>
          </div>

          <button type="button" disabled={!can || busy} onClick={() => void open()}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-emerald-600 text-white font-bold disabled:opacity-40">
            <MessageCircle className="w-5 h-5" /> {busy ? 'Opening…' : 'Open WhatsApp'}
          </button>
          {caseId && (
            <p className="text-[11px] text-slate-400 text-center">
              This does not mark the follow-up as contacted. Do that on Follow-ups once you know it went.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
