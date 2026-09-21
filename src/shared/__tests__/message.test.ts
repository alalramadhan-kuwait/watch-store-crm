import assert from 'node:assert/strict';
import { renderTemplate, greetingName, whatsappLink } from '../messageRules';

let n = 0; const t = (_: string, f: () => void) => { f(); n++; };

/* The English and Arabic 'interested_followup' bodies exactly as seeded in
   message_templates; the expected outputs are what public.render_template()
   returned for the same inputs on 2026-09-21. */
const EN = 'Hello {{first_name}}, this is {{salesperson}} from Time Keeper {{store}}. Thank you for visiting us. I wanted to follow up about the {{product}} you were interested in — I\'m happy to answer any questions or check availability for you.';
const AR = 'مرحباً {{first_name}}، معك {{salesperson}} من تايم كيبر {{store}}. شكراً لزيارتك لنا. أحببت أن أتابع معك بخصوص {{product}} الذي أعجبك — يسعدني الإجابة عن أي استفسار أو التأكد من توفره لك.';

t('every placeholder filled', () => {
  assert.equal(
    renderTemplate(EN, { first_name: 'Mohammed', salesperson: 'Ahmed', store: 'Avenues', product: 'Cartier Santos' }),
    'Hello Mohammed, this is Ahmed from Time Keeper Avenues. Thank you for visiting us. I wanted to follow up about the Cartier Santos you were interested in — I\'m happy to answer any questions or check availability for you.');
});
t('a missing name leaves no gap before the comma', () => {
  assert.equal(
    renderTemplate(EN, { first_name: null, salesperson: 'Ahmed', store: 'Avenues', product: 'Cartier Santos' }).slice(0, 25),
    'Hello, this is Ahmed from');
});
t('a placeholder never mentioned disappears', () => {
  assert.equal(renderTemplate('Hi {{first_name}} {{nickname}}!', { first_name: 'Sara' }), 'Hi Sara!');
});
t('arabic renders with its own punctuation tidied', () => {
  assert.equal(
    renderTemplate(AR, { first_name: 'محمد', salesperson: 'أحمد', store: 'الأفنيوز', product: 'كارتييه سانتوس' }),
    'مرحباً محمد، معك أحمد من تايم كيبر الأفنيوز. شكراً لزيارتك لنا. أحببت أن أتابع معك بخصوص كارتييه سانتوس الذي أعجبك — يسعدني الإجابة عن أي استفسار أو التأكد من توفره لك.');
  assert.equal(renderTemplate('مرحباً {{first_name}}، معك', {}), 'مرحباً، معك');
});
t('greeting name drops titles and shouting', () => {
  assert.equal(greetingName('MR MOHAMMED AL AJEEL'), 'Mohammed');
  assert.equal(greetingName('Dr. Sara Al-Sabah'), 'Sara');
  assert.equal(greetingName('Kareem Taher'), 'Kareem');
  assert.equal(greetingName(null), '');
});
t('whatsapp link needs a number it can open', () => {
  assert.equal(whatsappLink('+96597202422', 'Hello Sara'), 'https://wa.me/96597202422?text=Hello%20Sara');
  assert.equal(whatsappLink('97202422', 'x'), null);
  assert.equal(whatsappLink(null, 'x'), null);
});

console.log(`${n} message checks passed`);
