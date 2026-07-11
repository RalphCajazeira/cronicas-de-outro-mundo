alter table public.rpg_actors enable row level security;
alter table public.rpg_actor_relationships enable row level security;
alter table public.rpg_actor_memories enable row level security;

drop policy if exists rpg_actors_owner_policy on public.rpg_actors;
create policy rpg_actors_owner_policy
on public.rpg_actors
for all
to authenticated
using(owner_id=auth.uid())
with check(owner_id=auth.uid());

drop policy if exists rpg_actor_relationships_owner_policy on public.rpg_actor_relationships;
create policy rpg_actor_relationships_owner_policy
on public.rpg_actor_relationships
for all
to authenticated
using(owner_id=auth.uid())
with check(owner_id=auth.uid());

drop policy if exists rpg_actor_memories_owner_policy on public.rpg_actor_memories;
create policy rpg_actor_memories_owner_policy
on public.rpg_actor_memories
for all
to authenticated
using(owner_id=auth.uid())
with check(owner_id=auth.uid());

drop policy if exists rpg_content_blueprints_deny_direct on public.rpg_content_blueprints;
create policy rpg_content_blueprints_deny_direct
on public.rpg_content_blueprints
for all
to anon,authenticated
using(false)
with check(false);

revoke execute on function public.rpg_validate_content_payload(text,jsonb) from anon,authenticated;
revoke execute on function public.rpg_resolve_character_reference(uuid,text) from anon,authenticated;
revoke execute on function public.rpg_resolve_content_reference(uuid,uuid,text) from anon,authenticated;
revoke execute on function public.rpg_compute_character_derived_stats(uuid,uuid) from anon,authenticated;
revoke execute on function public.rpg_gateway_search_content(text,uuid,uuid,text,text,integer) from anon,authenticated;
revoke execute on function public.rpg_gateway_upsert_content(text,uuid,uuid,text,jsonb) from anon,authenticated;
revoke execute on function public.rpg_gateway_manage_character_content(text,text,text,text,jsonb) from anon,authenticated;

grant execute on function public.rpg_validate_content_payload(text,jsonb) to service_role;
grant execute on function public.rpg_resolve_character_reference(uuid,text) to service_role;
grant execute on function public.rpg_resolve_content_reference(uuid,uuid,text) to service_role;
grant execute on function public.rpg_compute_character_derived_stats(uuid,uuid) to service_role;
grant execute on function public.rpg_gateway_search_content(text,uuid,uuid,text,text,integer) to service_role;
grant execute on function public.rpg_gateway_upsert_content(text,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.rpg_gateway_manage_character_content(text,text,text,text,jsonb) to service_role;

create or replace function public.rpg_default_actor_attributes(p_actor_type text)
returns jsonb
language sql
immutable
set search_path='public'
as $$
 select case coalesce(p_actor_type,'npc')
  when 'spirit' then '{"strength":6,"agility":14,"vitality":10,"intelligence":14,"charisma":13}'::jsonb
  when 'creature' then '{"strength":10,"agility":10,"vitality":10,"intelligence":6,"charisma":5}'::jsonb
  when 'animal' then '{"strength":8,"agility":12,"vitality":9,"intelligence":3,"charisma":4}'::jsonb
  when 'boss' then '{"strength":16,"agility":12,"vitality":16,"intelligence":10,"charisma":10}'::jsonb
  when 'deity' then '{"strength":18,"agility":18,"vitality":18,"intelligence":20,"charisma":20}'::jsonb
  else '{"strength":8,"agility":8,"vitality":8,"intelligence":8,"charisma":8}'::jsonb
 end
$$;