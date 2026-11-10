-- Thumbs-up on a take: the editor's approval, read back by the prompt writers as examples.
alter table public.learning_events drop constraint if exists learning_events_kind_check;
alter table public.learning_events add constraint learning_events_kind_check
  check (kind in ('reprompt', 'reroll', 'take_delete', 'take_select', 'thumbs_down', 'keeper', 'edit_note', 'thumbs_up'));
