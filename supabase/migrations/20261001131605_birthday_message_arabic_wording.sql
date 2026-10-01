-- Arabic birthday message, in the owner's own wording (1 Oct 2026).
-- Was: كل عام وأنت بخير {{first_name}}! 🎂 أطيب التهاني من جميعنا في تايم كيبر {{store}}. نتمنى لك عاماً رائعاً.
update public.message_templates
   set body = $b$كل عام وأنت بخير 🎂

نتمنى لك سنة جميلة مليانة بالصحة والسعادة والنجاح، وعساها سنة خير عليك وتحقق فيها كل اللي تتمناه.

أطيب التهاني من فريق تايم كيبر – {{store}}.$b$,
       updated_at = now()
 where key = 'birthday' and lang = 'ar';
