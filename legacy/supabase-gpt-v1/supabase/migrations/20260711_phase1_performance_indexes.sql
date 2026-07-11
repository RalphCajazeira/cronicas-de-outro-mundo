create index if not exists rpg_character_content_content_idx
  on public.rpg_character_content(content_id);

create index if not exists rpg_content_catalog_campaign_idx
  on public.rpg_content_catalog(campaign_id)
  where campaign_id is not null;

create index if not exists rpg_actors_world_idx
  on public.rpg_actors(world_id);

create index if not exists rpg_actors_current_location_idx
  on public.rpg_actors(current_location_id)
  where current_location_id is not null;

create index if not exists rpg_actors_companion_of_idx
  on public.rpg_actors(companion_of_actor_id)
  where companion_of_actor_id is not null;

create index if not exists rpg_actor_relationships_campaign_idx
  on public.rpg_actor_relationships(campaign_id);

create index if not exists rpg_actor_relationships_target_idx
  on public.rpg_actor_relationships(target_actor_id);

create index if not exists rpg_actor_memories_campaign_idx
  on public.rpg_actor_memories(campaign_id);

create index if not exists rpg_actor_memories_related_actor_idx
  on public.rpg_actor_memories(related_actor_id)
  where related_actor_id is not null;

create index if not exists rpg_actor_memories_event_idx
  on public.rpg_actor_memories(event_id)
  where event_id is not null;

create index if not exists rpg_actor_memories_location_idx
  on public.rpg_actor_memories(location_id)
  where location_id is not null;

create index if not exists rpg_actor_companion_bonds_campaign_idx
  on public.rpg_actor_companion_bonds(campaign_id);

drop policy if exists rpg_actors_owner_policy on public.rpg_actors;
create policy rpg_actors_owner_policy
on public.rpg_actors
for all
to authenticated
using(owner_id=(select auth.uid()))
with check(owner_id=(select auth.uid()));

drop policy if exists rpg_actor_relationships_owner_policy on public.rpg_actor_relationships;
create policy rpg_actor_relationships_owner_policy
on public.rpg_actor_relationships
for all
to authenticated
using(owner_id=(select auth.uid()))
with check(owner_id=(select auth.uid()));

drop policy if exists rpg_actor_memories_owner_policy on public.rpg_actor_memories;
create policy rpg_actor_memories_owner_policy
on public.rpg_actor_memories
for all
to authenticated
using(owner_id=(select auth.uid()))
with check(owner_id=(select auth.uid()));