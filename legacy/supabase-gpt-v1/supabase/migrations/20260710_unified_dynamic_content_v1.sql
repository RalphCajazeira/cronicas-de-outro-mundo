create table if not exists public.rpg_content_catalog (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  world_id uuid not null references public.rpg_worlds(id) on delete cascade,
  campaign_id uuid references public.rpg_campaigns(id) on delete cascade,
  scope text not null default 'world' check (scope in ('world','campaign')),
  content_type text not null,
  code text not null,
  name text not null,
  description text,
  aliases jsonb not null default '[]'::jsonb,
  mechanics jsonb not null default '{}'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  presentation jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope='world' and campaign_id is null) or (scope='campaign' and campaign_id is not null))
);

create unique index if not exists rpg_content_catalog_unique_code
on public.rpg_content_catalog(owner_id,world_id,coalesce(campaign_id,'00000000-0000-0000-0000-000000000000'::uuid),content_type,lower(code));
create index if not exists rpg_content_catalog_search_idx on public.rpg_content_catalog(world_id,content_type,status);
create index if not exists rpg_content_catalog_name_idx on public.rpg_content_catalog(lower(name));

create table if not exists public.rpg_character_content (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  character_id uuid not null references public.rpg_characters(id) on delete cascade,
  content_id uuid not null references public.rpg_content_catalog(id) on delete cascade,
  state text not null default 'known',
  rank integer not null default 1,
  progress integer not null default 0,
  mastery integer not null default 0,
  equipped boolean not null default false,
  quantity integer not null default 1,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  learned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(character_id,content_id)
);

alter table public.rpg_content_catalog enable row level security;
alter table public.rpg_character_content enable row level security;
drop policy if exists rpg_content_catalog_owner_policy on public.rpg_content_catalog;
create policy rpg_content_catalog_owner_policy on public.rpg_content_catalog for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
drop policy if exists rpg_character_content_owner_policy on public.rpg_character_content;
create policy rpg_character_content_owner_policy on public.rpg_character_content for all using(owner_id=auth.uid()) with check(owner_id=auth.uid());
grant select,insert,update,delete on public.rpg_content_catalog to service_role;
grant select,insert,update,delete on public.rpg_character_content to service_role;

create or replace function public.rpg_gateway_search_content(p_api_key text,p_world_id uuid,p_campaign_id uuid,p_content_type text,p_query text,p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path='public' as $$
declare v_owner uuid;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  if not exists(select 1 from public.rpg_worlds where id=p_world_id and owner_id=v_owner) then raise exception 'world_not_found'; end if;
  if p_campaign_id is not null and not exists(select 1 from public.rpg_campaigns where id=p_campaign_id and world_id=p_world_id and owner_id=v_owner) then raise exception 'campaign_not_found'; end if;
  return jsonb_build_object('items',(
    select coalesce(jsonb_agg(to_jsonb(c) order by case when lower(c.name)=lower(coalesce(p_query,'')) then 0 else 1 end,c.name),'[]'::jsonb)
    from (
      select * from public.rpg_content_catalog c
      where c.owner_id=v_owner and c.world_id=p_world_id and c.status='active'
        and (p_content_type is null or c.content_type=p_content_type)
        and (c.scope='world' or c.campaign_id=p_campaign_id)
        and (coalesce(trim(p_query),'')='' or lower(c.name) like '%'||lower(trim(p_query))||'%' or lower(c.code) like '%'||lower(trim(p_query))||'%' or c.aliases::text ilike '%'||trim(p_query)||'%' or c.tags::text ilike '%'||trim(p_query)||'%')
      limit least(greatest(coalesce(p_limit,20),1),50)
    ) c
  ));
end $$;

create or replace function public.rpg_gateway_upsert_content(p_api_key text,p_world_id uuid,p_campaign_id uuid,p_content_type text,p_content jsonb)
returns jsonb language plpgsql security definer set search_path='public' as $$
declare v_owner uuid; v_scope text; v_code text; v_name text; v_row public.rpg_content_catalog;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  if not exists(select 1 from public.rpg_worlds where id=p_world_id and owner_id=v_owner) then raise exception 'world_not_found'; end if;
  if p_campaign_id is not null and not exists(select 1 from public.rpg_campaigns where id=p_campaign_id and world_id=p_world_id and owner_id=v_owner) then raise exception 'campaign_not_found'; end if;
  v_scope:=case when p_campaign_id is null then 'world' else 'campaign' end;
  v_name:=nullif(trim(p_content->>'name'),'');
  v_code:=coalesce(nullif(trim(p_content->>'code'),''),lower(regexp_replace(v_name,'[^a-zA-Z0-9]+','_','g')));
  if v_name is null then raise exception 'content_name_required'; end if;
  if p_content_type is null or trim(p_content_type)='' then raise exception 'content_type_required'; end if;
  insert into public.rpg_content_catalog(owner_id,world_id,campaign_id,scope,content_type,code,name,description,aliases,mechanics,requirements,presentation,tags,metadata,status)
  values(v_owner,p_world_id,p_campaign_id,v_scope,p_content_type,v_code,v_name,nullif(p_content->>'description',''),coalesce(p_content->'aliases','[]'::jsonb),coalesce(p_content->'mechanics','{}'::jsonb),coalesce(p_content->'requirements','{}'::jsonb),coalesce(p_content->'presentation','{}'::jsonb),coalesce(p_content->'tags','[]'::jsonb),coalesce(p_content->'metadata','{}'::jsonb),coalesce(nullif(p_content->>'status',''),'active'))
  on conflict(owner_id,world_id,coalesce(campaign_id,'00000000-0000-0000-0000-000000000000'::uuid),content_type,lower(code)) do update set
    name=excluded.name,
    description=coalesce(excluded.description,public.rpg_content_catalog.description),
    aliases=case when excluded.aliases='[]'::jsonb then public.rpg_content_catalog.aliases else excluded.aliases end,
    mechanics=public.rpg_content_catalog.mechanics||excluded.mechanics,
    requirements=public.rpg_content_catalog.requirements||excluded.requirements,
    presentation=public.rpg_content_catalog.presentation||excluded.presentation,
    tags=case when excluded.tags='[]'::jsonb then public.rpg_content_catalog.tags else excluded.tags end,
    metadata=public.rpg_content_catalog.metadata||excluded.metadata,
    status=excluded.status,
    version=public.rpg_content_catalog.version+1,
    updated_at=now()
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.rpg_gateway_manage_character_content(p_api_key text,p_character_id uuid,p_operation text,p_content_id uuid,p_changes jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='public' as $$
declare v_owner uuid; v_char public.rpg_characters; v_content public.rpg_content_catalog; v_row public.rpg_character_content;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  select * into v_char from public.rpg_characters where id=p_character_id and owner_id=v_owner;
  if v_char.id is null then raise exception 'character_not_found'; end if;
  select c.* into v_content from public.rpg_content_catalog c join public.rpg_campaigns ca on ca.id=v_char.campaign_id where c.id=p_content_id and c.owner_id=v_owner and c.world_id=ca.world_id and (c.scope='world' or c.campaign_id=v_char.campaign_id);
  if v_content.id is null then raise exception 'content_not_found'; end if;
  if p_operation in ('learn','grant','add','equip') then
    insert into public.rpg_character_content(owner_id,character_id,content_id,state,rank,progress,mastery,equipped,quantity,notes,metadata)
    values(v_owner,p_character_id,p_content_id,coalesce(nullif(p_changes->>'state',''),case when p_operation='equip' then 'owned' else 'known' end),coalesce(nullif(p_changes->>'rank','')::int,1),coalesce(nullif(p_changes->>'progress','')::int,0),coalesce(nullif(p_changes->>'mastery','')::int,0),coalesce((p_changes->>'equipped')::boolean,p_operation='equip'),coalesce(nullif(p_changes->>'quantity','')::int,1),nullif(p_changes->>'notes',''),coalesce(p_changes->'metadata','{}'::jsonb))
    on conflict(character_id,content_id) do update set state=coalesce(nullif(p_changes->>'state',''),public.rpg_character_content.state),rank=greatest(1,public.rpg_character_content.rank+coalesce(nullif(p_changes->>'rank_delta','')::int,0)),progress=greatest(0,public.rpg_character_content.progress+coalesce(nullif(p_changes->>'progress_delta','')::int,0)),mastery=greatest(0,public.rpg_character_content.mastery+coalesce(nullif(p_changes->>'mastery_delta','')::int,0)),equipped=coalesce((p_changes->>'equipped')::boolean,p_operation='equip',public.rpg_character_content.equipped),quantity=greatest(0,public.rpg_character_content.quantity+coalesce(nullif(p_changes->>'quantity_delta','')::int,0)),notes=coalesce(nullif(p_changes->>'notes',''),public.rpg_character_content.notes),metadata=public.rpg_character_content.metadata||coalesce(p_changes->'metadata','{}'::jsonb),updated_at=now() returning * into v_row;
  elsif p_operation='update' then
    update public.rpg_character_content set state=coalesce(nullif(p_changes->>'state',''),state),rank=greatest(1,rank+coalesce(nullif(p_changes->>'rank_delta','')::int,0)),progress=greatest(0,progress+coalesce(nullif(p_changes->>'progress_delta','')::int,0)),mastery=greatest(0,mastery+coalesce(nullif(p_changes->>'mastery_delta','')::int,0)),equipped=coalesce((p_changes->>'equipped')::boolean,equipped),quantity=greatest(0,quantity+coalesce(nullif(p_changes->>'quantity_delta','')::int,0)),notes=coalesce(nullif(p_changes->>'notes',''),notes),metadata=metadata||coalesce(p_changes->'metadata','{}'::jsonb),updated_at=now() where character_id=p_character_id and content_id=p_content_id returning * into v_row;
  elsif p_operation in ('remove','forget','unequip') then
    if p_operation='unequip' then update public.rpg_character_content set equipped=false,updated_at=now() where character_id=p_character_id and content_id=p_content_id returning * into v_row;
    else delete from public.rpg_character_content where character_id=p_character_id and content_id=p_content_id returning * into v_row; end if;
  else raise exception 'unsupported_content_operation';
  end if;
  if v_row.id is null and p_operation not in ('remove','forget') then raise exception 'character_content_not_found'; end if;
  return jsonb_build_object('character_content',to_jsonb(v_row),'content',to_jsonb(v_content));
end $$;
