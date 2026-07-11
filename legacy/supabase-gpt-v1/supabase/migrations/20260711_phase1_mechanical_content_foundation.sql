create table if not exists public.rpg_content_blueprints (
  id uuid primary key default gen_random_uuid(),
  content_type text not null unique,
  title text not null,
  description text not null,
  schema_version integer not null default 1,
  required_mechanics jsonb not null default '[]'::jsonb,
  recommended_mechanics jsonb not null default '[]'::jsonb,
  default_mechanics jsonb not null default '{}'::jsonb,
  default_requirements jsonb not null default '{}'::jsonb,
  example_content jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rpg_content_blueprints enable row level security;
revoke all on public.rpg_content_blueprints from anon, authenticated;
grant select on public.rpg_content_blueprints to service_role;

alter table public.rpg_content_catalog
  add column if not exists schema_version integer not null default 1,
  add column if not exists validation_status text not null default 'unvalidated',
  add column if not exists validation_errors jsonb not null default '[]'::jsonb,
  add column if not exists validated_at timestamptz;

insert into public.rpg_content_blueprints(
  content_type,title,description,schema_version,required_mechanics,recommended_mechanics,
  default_mechanics,default_requirements,example_content,status
) values
(
  'skill','Habilidade','Técnica física, espiritual ou elemental usada ativa, passiva ou reativamente.',1,
  '["activation","category","effects"]'::jsonb,
  '["resource_cost","cooldown_turns","duration_turns","scaling"]'::jsonb,
  '{"activation":"active","category":"utility","resource_cost":{"resource":"mana","amount":0},"cooldown_turns":0,"duration_turns":0,"effects":[],"scaling":[]}'::jsonb,
  '{"minimum_level":1,"usable_while_learning":false}'::jsonb,
  '{"code":"wind_breeze_step","name":"Passo da Brisa","description":"Técnica elemental de Ar que melhora deslocamento e esquiva.","mechanics":{"activation":"active","category":"mobility","element":"air","resource_cost":{"resource":"mana","amount":3},"cooldown_turns":1,"duration_turns":1,"effects":[{"type":"movement_multiplier","value":1.25,"target":"self"},{"type":"evasion_bonus","value":10,"target":"self"}],"scaling":[{"source":"agility","ratio":0.4}]},"requirements":{"minimum_level":1,"usable_while_learning":true},"tags":["air","mobility","beginner"]}'::jsonb,
  'active'
),
(
  'spell','Magia','Manifestação mágica que consome recurso e produz dano, cura, controle ou utilidade.',1,
  '["activation","element","resource_cost","effects"]'::jsonb,
  '["base_power","damage_type","cast_time_seconds","range_m","area_radius_m","cooldown_turns","scaling"]'::jsonb,
  '{"activation":"active","resource_cost":{"resource":"mana","amount":1},"cast_time_seconds":1,"range_m":10,"area_radius_m":0,"cooldown_turns":0,"effects":[],"scaling":[]}'::jsonb,
  '{"minimum_level":1}'::jsonb,
  '{"code":"fireball","name":"Bola de Fogo","description":"Projétil de fogo que explode ao atingir o alvo.","mechanics":{"activation":"active","element":"fire","base_power":15,"damage_type":"magic_fire","resource_cost":{"resource":"mana","amount":8},"cast_time_seconds":2,"range_m":20,"area_radius_m":2,"cooldown_turns":2,"effects":[{"type":"damage","value":15,"damage_type":"magic_fire"},{"type":"burn","chance":0.25,"value":3,"duration_turns":2}],"scaling":[{"source":"intelligence","ratio":0.7},{"source":"fire_affinity","ratio":0.4}]},"requirements":{"minimum_level":1},"tags":["fire","damage","area"]}'::jsonb,
  'active'
),
(
  'weapon','Arma','Equipamento ofensivo com dano base, tipo de dano, alcance, durabilidade e escalonamento.',1,
  '["weapon_type","base_damage","damage_type","durability_max","scaling"]'::jsonb,
  '["accuracy_bonus","attack_speed","range_m","hands","critical_bonus"]'::jsonb,
  '{"accuracy_bonus":0,"attack_speed":1,"range_m":1.5,"hands":1,"critical_bonus":0,"scaling":[]}'::jsonb,
  '{}'::jsonb,
  '{"code":"iron_dagger","name":"Adaga de Ferro","description":"Adaga simples, leve e adequada para ataques rápidos.","mechanics":{"weapon_type":"dagger","base_damage":7,"damage_type":"piercing","accuracy_bonus":4,"attack_speed":1.2,"range_m":1.2,"hands":1,"durability_max":100,"critical_bonus":2,"scaling":[{"source":"agility","ratio":0.6},{"source":"strength","ratio":0.2}]},"requirements":{"minimum_strength":4},"tags":["weapon","dagger","common"]}'::jsonb,
  'active'
),
(
  'armor','Armadura','Equipamento defensivo vestido em um slot corporal.',1,
  '["armor_type","slot","base_defense","durability_max"]'::jsonb,
  '["resistances","movement_penalty","weight"]'::jsonb,
  '{"base_defense":0,"resistances":{},"movement_penalty":0,"weight":0}'::jsonb,
  '{}'::jsonb,
  '{"code":"leather_vest","name":"Colete de Couro","description":"Proteção leve de couro endurecido.","mechanics":{"armor_type":"light","slot":"torso","base_defense":5,"resistances":{"slashing":2,"piercing":1},"movement_penalty":0,"durability_max":120,"weight":4},"requirements":{"minimum_strength":5},"tags":["armor","light","common"]}'::jsonb,
  'active'
),
(
  'shield','Escudo','Equipamento defensivo empunhado para defesa e bloqueio.',1,
  '["shield_type","slot","base_defense","block_chance","durability_max"]'::jsonb,
  '["resistances","movement_penalty","weight"]'::jsonb,
  '{"slot":"off_hand","base_defense":0,"block_chance":0,"resistances":{},"movement_penalty":0,"weight":0}'::jsonb,
  '{}'::jsonb,
  '{"code":"wooden_round_shield","name":"Escudo Redondo de Madeira","description":"Escudo simples reforçado com aro de ferro.","mechanics":{"shield_type":"round","slot":"off_hand","base_defense":5,"block_chance":12,"resistances":{"physical":3},"movement_penalty":2,"durability_max":120,"weight":5},"requirements":{"minimum_strength":6},"tags":["shield","defense","common"]}'::jsonb,
  'active'
),
(
  'item','Item','Objeto geral, consumível, munição, ferramenta, chave, tesouro ou componente.',1,
  '["item_type","stackable","base_value"]'::jsonb,
  '["weight","max_stack","effects","charges"]'::jsonb,
  '{"stackable":false,"base_value":0,"weight":0,"max_stack":1,"effects":[]}'::jsonb,
  '{}'::jsonb,
  '{"code":"minor_healing_potion","name":"Poção de Cura Menor","description":"Poção simples que recupera parte da vida.","mechanics":{"item_type":"consumable","stackable":true,"max_stack":10,"base_value":20,"weight":0.2,"effects":[{"type":"heal","value":20}]},"requirements":{},"tags":["consumable","healing","common"]}'::jsonb,
  'active'
)
on conflict(content_type) do update set
  title=excluded.title,
  description=excluded.description,
  schema_version=excluded.schema_version,
  required_mechanics=excluded.required_mechanics,
  recommended_mechanics=excluded.recommended_mechanics,
  default_mechanics=excluded.default_mechanics,
  default_requirements=excluded.default_requirements,
  example_content=excluded.example_content,
  status=excluded.status,
  updated_at=now();

create or replace function public.rpg_validate_content_payload(p_content_type text,p_content jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path='public'
as $$
declare
  v_blueprint public.rpg_content_blueprints;
  v_errors jsonb:='[]'::jsonb;
  v_warnings jsonb:='[]'::jsonb;
  v_key text;
  v_mechanics jsonb:=coalesce(p_content->'mechanics','{}'::jsonb);
  v_status text:=coalesce(nullif(p_content->>'status',''),'active');
begin
  select * into v_blueprint from public.rpg_content_blueprints where content_type=p_content_type and status='active';

  if jsonb_typeof(coalesce(p_content,'{}'::jsonb))<>'object' then
    v_errors:=v_errors||jsonb_build_array('content_must_be_object');
  end if;
  if nullif(trim(p_content->>'name'),'') is null then
    v_errors:=v_errors||jsonb_build_array('name_required');
  end if;
  if v_status='active' and nullif(trim(p_content->>'description'),'') is null then
    v_errors:=v_errors||jsonb_build_array('description_required_for_active_content');
  end if;
  if jsonb_typeof(v_mechanics)<>'object' then
    v_errors:=v_errors||jsonb_build_array('mechanics_must_be_object');
    v_mechanics:='{}'::jsonb;
  end if;

  if v_blueprint.id is null then
    v_warnings:=v_warnings||jsonb_build_array('blueprint_not_found_for_content_type');
  else
    for v_key in select jsonb_array_elements_text(v_blueprint.required_mechanics)
    loop
      if not (v_mechanics ? v_key) then
        v_errors:=v_errors||jsonb_build_array('mechanics.'||v_key||'_required');
      end if;
    end loop;

    if p_content_type in ('skill','spell') then
      if jsonb_typeof(v_mechanics->'effects')<>'array' or jsonb_array_length(coalesce(v_mechanics->'effects','[]'::jsonb))=0 then
        v_errors:=v_errors||jsonb_build_array('mechanics.effects_must_have_at_least_one_effect');
      end if;
      if coalesce(v_mechanics->>'activation','') not in ('active','passive','reaction','toggle') then
        v_errors:=v_errors||jsonb_build_array('mechanics.activation_invalid');
      end if;
    end if;

    if p_content_type='weapon' and coalesce((v_mechanics->>'base_damage')::numeric,0)<=0 then
      v_errors:=v_errors||jsonb_build_array('mechanics.base_damage_must_be_positive');
    end if;
    if p_content_type in ('armor','shield') and coalesce((v_mechanics->>'base_defense')::numeric,0)<0 then
      v_errors:=v_errors||jsonb_build_array('mechanics.base_defense_cannot_be_negative');
    end if;
  end if;

  return jsonb_build_object(
    'valid',jsonb_array_length(v_errors)=0,
    'errors',v_errors,
    'warnings',v_warnings,
    'schema_version',coalesce(v_blueprint.schema_version,1),
    'content_type',p_content_type
  );
end;
$$;

revoke all on function public.rpg_validate_content_payload(text,jsonb) from public;
grant execute on function public.rpg_validate_content_payload(text,jsonb) to service_role;

create or replace function public.rpg_resolve_character_reference(p_owner uuid,p_reference text)
returns uuid
language plpgsql
stable
security definer
set search_path='public'
as $$
declare v_id uuid; v_ref uuid;
begin
  if p_reference is null or trim(p_reference)='' then return null; end if;
  if p_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_ref:=p_reference::uuid;
    select id into v_id from public.rpg_characters where id=v_ref and owner_id=p_owner;
    if v_id is null then
      select source_id into v_id from public.rpg_actors where id=v_ref and owner_id=p_owner and source_kind='character' limit 1;
    end if;
  else
    select id into v_id from public.rpg_characters where owner_id=p_owner and lower(name)=lower(trim(p_reference)) order by created_at desc limit 1;
  end if;
  if v_id is null then
    select case when count(*)=1 then min(id) end into v_id from public.rpg_characters where owner_id=p_owner;
  end if;
  return v_id;
end;
$$;

create or replace function public.rpg_resolve_content_reference(p_owner uuid,p_character_id uuid,p_reference text)
returns uuid
language plpgsql
stable
security definer
set search_path='public'
as $$
declare v_id uuid; v_char public.rpg_characters; v_ref uuid;
begin
  if p_reference is null or trim(p_reference)='' then return null; end if;
  select * into v_char from public.rpg_characters where id=p_character_id and owner_id=p_owner;
  if v_char.id is null then return null; end if;
  if p_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_ref:=p_reference::uuid;
    select c.id into v_id from public.rpg_content_catalog c join public.rpg_campaigns ca on ca.id=v_char.campaign_id
    where c.id=v_ref and c.owner_id=p_owner and c.world_id=ca.world_id and (c.scope='world' or c.campaign_id=v_char.campaign_id);
  else
    select c.id into v_id from public.rpg_content_catalog c join public.rpg_campaigns ca on ca.id=v_char.campaign_id
    where c.owner_id=p_owner and c.world_id=ca.world_id and c.status='active' and (c.scope='world' or c.campaign_id=v_char.campaign_id)
      and (lower(c.code)=lower(trim(p_reference)) or lower(c.name)=lower(trim(p_reference)))
    order by case when lower(c.code)=lower(trim(p_reference)) then 0 else 1 end,c.updated_at desc limit 1;
  end if;
  return v_id;
end;
$$;

revoke all on function public.rpg_resolve_character_reference(uuid,text) from public;
revoke all on function public.rpg_resolve_content_reference(uuid,uuid,text) from public;
grant execute on function public.rpg_resolve_character_reference(uuid,text) to service_role;
grant execute on function public.rpg_resolve_content_reference(uuid,uuid,text) to service_role;

create or replace function public.rpg_compute_character_derived_stats(p_owner uuid,p_character_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path='public'
as $$
declare
  v_char public.rpg_characters;
  v_entry record;
  v_effect jsonb;
  v_res record;
  v_strength numeric;
  v_agility numeric;
  v_vitality numeric;
  v_intelligence numeric;
  v_charisma numeric;
  v_attack integer;
  v_magic integer;
  v_defense integer;
  v_accuracy integer;
  v_evasion integer;
  v_movement numeric;
  v_resistances jsonb:='{}'::jsonb;
begin
  select * into v_char from public.rpg_characters where id=p_character_id and owner_id=p_owner;
  if v_char.id is null then raise exception 'character_not_found'; end if;

  v_strength:=coalesce((v_char.attributes->>'strength')::numeric,10);
  v_agility:=coalesce((v_char.attributes->>'agility')::numeric,10);
  v_vitality:=coalesce((v_char.attributes->>'vitality')::numeric,10);
  v_intelligence:=coalesce((v_char.attributes->>'intelligence')::numeric,10);
  v_charisma:=coalesce((v_char.attributes->>'charisma')::numeric,10);
  v_attack:=floor(v_strength)::integer;
  v_magic:=floor(v_intelligence)::integer;
  v_defense:=floor(v_vitality/3)::integer;
  v_accuracy:=50+floor(v_agility*1.5)::integer;
  v_evasion:=5+floor(v_agility)::integer;
  v_movement:=10+round(v_agility/2,2);

  for v_entry in
    select c.content_type,c.mechanics,cc.state,cc.equipped
    from public.rpg_character_content cc
    join public.rpg_content_catalog c on c.id=cc.content_id
    where cc.character_id=p_character_id and c.status='active'
      and (cc.equipped or (c.mechanics->>'activation'='passive' and cc.state in ('known','mastered')))
  loop
    if v_entry.equipped then
      v_attack:=v_attack+coalesce((v_entry.mechanics->>'base_damage')::integer,0)+coalesce((v_entry.mechanics->>'attack_bonus')::integer,0);
      v_defense:=v_defense+coalesce((v_entry.mechanics->>'base_defense')::integer,0)+coalesce((v_entry.mechanics->>'defense_bonus')::integer,0);
      v_accuracy:=v_accuracy+coalesce((v_entry.mechanics->>'accuracy_bonus')::integer,0);
      v_evasion:=v_evasion+coalesce((v_entry.mechanics->>'evasion_bonus')::integer,0);
      v_movement:=v_movement-coalesce((v_entry.mechanics->>'movement_penalty')::numeric,0)+coalesce((v_entry.mechanics->>'movement_bonus')::numeric,0);
      for v_res in select key,value from jsonb_each_text(coalesce(v_entry.mechanics->'resistances','{}'::jsonb))
      loop
        v_resistances:=jsonb_set(v_resistances,array[v_res.key],to_jsonb(coalesce((v_resistances->>v_res.key)::numeric,0)+(v_res.value)::numeric),true);
      end loop;
    end if;
    if v_entry.mechanics->>'activation'='passive' then
      for v_effect in select value from jsonb_array_elements(coalesce(v_entry.mechanics->'effects','[]'::jsonb))
      loop
        if v_effect->>'type'='attack_bonus' then v_attack:=v_attack+coalesce((v_effect->>'value')::integer,0); end if;
        if v_effect->>'type'='defense_bonus' then v_defense:=v_defense+coalesce((v_effect->>'value')::integer,0); end if;
        if v_effect->>'type'='accuracy_bonus' then v_accuracy:=v_accuracy+coalesce((v_effect->>'value')::integer,0); end if;
        if v_effect->>'type'='evasion_bonus' then v_evasion:=v_evasion+coalesce((v_effect->>'value')::integer,0); end if;
        if v_effect->>'type'='movement_bonus' then v_movement:=v_movement+coalesce((v_effect->>'value')::numeric,0); end if;
      end loop;
    end if;
  end loop;

  return jsonb_build_object(
    'base_attributes',v_char.attributes,
    'attack_power',greatest(0,v_attack),
    'magic_power',greatest(0,v_magic),
    'defense',greatest(0,v_defense),
    'accuracy',greatest(0,v_accuracy),
    'evasion',greatest(0,v_evasion),
    'movement',greatest(0,v_movement),
    'resistances',v_resistances,
    'health',v_char.health,
    'max_health',v_char.max_health,
    'mana',v_char.mana,
    'max_mana',v_char.max_mana
  );
end;
$$;

revoke all on function public.rpg_compute_character_derived_stats(uuid,uuid) from public;
grant execute on function public.rpg_compute_character_derived_stats(uuid,uuid) to service_role;

create or replace function public.rpg_gateway_search_content(p_api_key text,p_world_id uuid,p_campaign_id uuid,p_content_type text,p_query text,p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $$
declare v_owner uuid;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  if not exists(select 1 from public.rpg_worlds where id=p_world_id and owner_id=v_owner) then raise exception 'world_not_found'; end if;
  if p_campaign_id is not null and not exists(select 1 from public.rpg_campaigns where id=p_campaign_id and world_id=p_world_id and owner_id=v_owner) then raise exception 'campaign_not_found'; end if;
  return jsonb_build_object(
    'blueprint',(select to_jsonb(b) from public.rpg_content_blueprints b where b.content_type=p_content_type and b.status='active'),
    'items',(
      select coalesce(jsonb_agg(to_jsonb(c) order by case when lower(c.name)=lower(coalesce(p_query,'')) then 0 else 1 end,c.name),'[]'::jsonb)
      from (
        select * from public.rpg_content_catalog c
        where c.owner_id=v_owner and c.world_id=p_world_id and c.status='active'
          and (p_content_type is null or c.content_type=p_content_type)
          and (c.scope='world' or c.campaign_id=p_campaign_id)
          and (coalesce(trim(p_query),'')='' or lower(c.name) like '%'||lower(trim(p_query))||'%' or lower(c.code) like '%'||lower(trim(p_query))||'%' or c.aliases::text ilike '%'||trim(p_query)||'%' or c.tags::text ilike '%'||trim(p_query)||'%')
        limit least(greatest(coalesce(p_limit,20),1),50)
      ) c
    )
  );
end;
$$;

create or replace function public.rpg_gateway_upsert_content(p_api_key text,p_world_id uuid,p_campaign_id uuid,p_content_type text,p_content jsonb)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_owner uuid;
  v_scope text;
  v_code text;
  v_name text;
  v_status text;
  v_row public.rpg_content_catalog;
  v_blueprint public.rpg_content_blueprints;
  v_normalized jsonb;
  v_validation jsonb;
  v_mechanics jsonb;
  v_requirements jsonb;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  if not exists(select 1 from public.rpg_worlds where id=p_world_id and owner_id=v_owner) then raise exception 'world_not_found'; end if;
  if p_campaign_id is not null and not exists(select 1 from public.rpg_campaigns where id=p_campaign_id and world_id=p_world_id and owner_id=v_owner) then raise exception 'campaign_not_found'; end if;

  v_scope:=case when p_campaign_id is null then 'world' else 'campaign' end;
  v_name:=nullif(trim(p_content->>'name'),'');
  v_code:=coalesce(nullif(trim(p_content->>'code'),''),lower(regexp_replace(v_name,'[^a-zA-Z0-9]+','_','g')));
  v_status:=coalesce(nullif(p_content->>'status',''),'active');
  if v_name is null then raise exception 'content_name_required'; end if;
  if p_content_type is null or trim(p_content_type)='' then raise exception 'content_type_required'; end if;

  select * into v_blueprint from public.rpg_content_blueprints where content_type=p_content_type and status='active';
  v_mechanics:=coalesce(v_blueprint.default_mechanics,'{}'::jsonb)||coalesce(p_content->'mechanics','{}'::jsonb);
  v_requirements:=coalesce(v_blueprint.default_requirements,'{}'::jsonb)||coalesce(p_content->'requirements','{}'::jsonb);
  v_normalized:=p_content||jsonb_build_object('name',v_name,'code',v_code,'status',v_status,'mechanics',v_mechanics,'requirements',v_requirements);
  v_validation:=public.rpg_validate_content_payload(p_content_type,v_normalized);

  if v_status='active' and not coalesce((v_validation->>'valid')::boolean,false) then
    raise exception 'content_validation_failed:%',v_validation->'errors';
  end if;

  insert into public.rpg_content_catalog(
    owner_id,world_id,campaign_id,scope,content_type,code,name,description,aliases,mechanics,requirements,presentation,tags,metadata,status,
    schema_version,validation_status,validation_errors,validated_at
  ) values(
    v_owner,p_world_id,p_campaign_id,v_scope,p_content_type,v_code,v_name,nullif(v_normalized->>'description',''),
    coalesce(v_normalized->'aliases','[]'::jsonb),v_mechanics,v_requirements,coalesce(v_normalized->'presentation','{}'::jsonb),
    coalesce(v_normalized->'tags','[]'::jsonb),coalesce(v_normalized->'metadata','{}'::jsonb),v_status,
    coalesce((v_validation->>'schema_version')::integer,1),case when (v_validation->>'valid')::boolean then 'valid' else 'invalid' end,
    coalesce(v_validation->'errors','[]'::jsonb),now()
  )
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
    schema_version=excluded.schema_version,
    validation_status=excluded.validation_status,
    validation_errors=excluded.validation_errors,
    validated_at=excluded.validated_at,
    version=public.rpg_content_catalog.version+1,
    updated_at=now()
  returning * into v_row;

  return to_jsonb(v_row)||jsonb_build_object('_validation',v_validation,'_blueprint',to_jsonb(v_blueprint));
end;
$$;

create or replace function public.rpg_gateway_manage_character_content(p_api_key text,p_character_id text,p_operation text,p_content_id text,p_changes jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_owner uuid;
  v_character_id uuid;
  v_content_id uuid;
  v_char public.rpg_characters;
  v_content public.rpg_content_catalog;
  v_row public.rpg_character_content;
  v_default_state text;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);
  v_character_id:=public.rpg_resolve_character_reference(v_owner,p_character_id);
  select * into v_char from public.rpg_characters where id=v_character_id and owner_id=v_owner;
  if v_char.id is null then raise exception 'character_not_found'; end if;

  if p_operation='list' then
    return jsonb_build_object(
      'items',(
        select coalesce(jsonb_agg(jsonb_build_object('character_content',to_jsonb(cc),'content',to_jsonb(c)) order by c.content_type,c.name),'[]'::jsonb)
        from public.rpg_character_content cc join public.rpg_content_catalog c on c.id=cc.content_id
        where cc.character_id=v_character_id
      ),
      'derived_stats',public.rpg_compute_character_derived_stats(v_owner,v_character_id)
    );
  end if;

  v_content_id:=public.rpg_resolve_content_reference(v_owner,v_character_id,p_content_id);
  select c.* into v_content from public.rpg_content_catalog c join public.rpg_campaigns ca on ca.id=v_char.campaign_id
  where c.id=v_content_id and c.owner_id=v_owner and c.world_id=ca.world_id and (c.scope='world' or c.campaign_id=v_char.campaign_id);
  if v_content.id is null then raise exception 'content_not_found'; end if;

  if p_operation='get' then
    select * into v_row from public.rpg_character_content where character_id=v_character_id and content_id=v_content_id;
    if v_row.id is null then raise exception 'character_content_not_found'; end if;
    return jsonb_build_object('character_content',to_jsonb(v_row),'content',to_jsonb(v_content),'derived_stats',public.rpg_compute_character_derived_stats(v_owner,v_character_id));
  end if;

  v_default_state:=case when p_operation='learn' then 'learning' when p_operation='equip' then 'owned' when p_operation in ('grant','add') then 'known' else null end;
  if p_operation in ('learn','grant','add','equip') then
    insert into public.rpg_character_content(owner_id,character_id,content_id,state,rank,progress,mastery,equipped,quantity,notes,metadata)
    values(v_owner,v_character_id,v_content_id,coalesce(nullif(p_changes->>'state',''),v_default_state),coalesce(nullif(p_changes->>'rank','')::int,1),coalesce(nullif(p_changes->>'progress','')::int,0),coalesce(nullif(p_changes->>'mastery','')::int,0),coalesce((p_changes->>'equipped')::boolean,p_operation='equip'),coalesce(nullif(p_changes->>'quantity','')::int,1),nullif(p_changes->>'notes',''),coalesce(p_changes->'metadata','{}'::jsonb))
    on conflict(character_id,content_id) do update set
      state=coalesce(nullif(p_changes->>'state',''),case when p_operation='learn' then 'learning' else public.rpg_character_content.state end),
      rank=greatest(1,public.rpg_character_content.rank+coalesce(nullif(p_changes->>'rank_delta','')::int,0)),
      progress=greatest(0,public.rpg_character_content.progress+coalesce(nullif(p_changes->>'progress_delta','')::int,0)),
      mastery=greatest(0,public.rpg_character_content.mastery+coalesce(nullif(p_changes->>'mastery_delta','')::int,0)),
      equipped=coalesce((p_changes->>'equipped')::boolean,p_operation='equip',public.rpg_character_content.equipped),
      quantity=greatest(0,public.rpg_character_content.quantity+coalesce(nullif(p_changes->>'quantity_delta','')::int,0)),
      notes=coalesce(nullif(p_changes->>'notes',''),public.rpg_character_content.notes),
      metadata=public.rpg_character_content.metadata||coalesce(p_changes->'metadata','{}'::jsonb),updated_at=now()
    returning * into v_row;
  elsif p_operation='update' then
    update public.rpg_character_content set
      state=coalesce(nullif(p_changes->>'state',''),state),
      rank=greatest(1,rank+coalesce(nullif(p_changes->>'rank_delta','')::int,0)),
      progress=greatest(0,progress+coalesce(nullif(p_changes->>'progress_delta','')::int,0)),
      mastery=greatest(0,mastery+coalesce(nullif(p_changes->>'mastery_delta','')::int,0)),
      equipped=coalesce((p_changes->>'equipped')::boolean,equipped),
      quantity=greatest(0,quantity+coalesce(nullif(p_changes->>'quantity_delta','')::int,0)),
      notes=coalesce(nullif(p_changes->>'notes',''),notes),
      metadata=metadata||coalesce(p_changes->'metadata','{}'::jsonb),updated_at=now()
    where character_id=v_character_id and content_id=v_content_id returning * into v_row;
  elsif p_operation in ('remove','forget','unequip') then
    if p_operation='unequip' then
      update public.rpg_character_content set equipped=false,updated_at=now() where character_id=v_character_id and content_id=v_content_id returning * into v_row;
    else
      delete from public.rpg_character_content where character_id=v_character_id and content_id=v_content_id returning * into v_row;
    end if;
  else
    raise exception 'unsupported_content_operation';
  end if;

  if v_row.id is null and p_operation not in ('remove','forget') then raise exception 'character_content_not_found'; end if;
  return jsonb_build_object('character_content',to_jsonb(v_row),'content',to_jsonb(v_content),'derived_stats',public.rpg_compute_character_derived_stats(v_owner,v_character_id));
end;
$$;

update public.rpg_content_catalog
set
  description='Técnica elemental de Ar que reduz momentaneamente o peso aparente do usuário e aproveita correntes de vento para melhorar deslocamentos, equilíbrio e esquivas.',
  mechanics='{"activation":"active","category":"mobility","element":"air","resource_cost":{"resource":"mana","amount":3},"cooldown_turns":1,"duration_turns":1,"effects":[{"type":"movement_multiplier","value":1.25,"target":"self"},{"type":"evasion_bonus","value":10,"target":"self"},{"type":"balance_bonus","value":15,"target":"self"}],"scaling":[{"source":"agility","ratio":0.4},{"source":"intelligence","ratio":0.15},{"source":"air_affinity","ratio":0.25}],"learning_risk":{"extra_mana_cost":2,"stumble_chance":0.15}}'::jsonb,
  requirements='{"minimum_level":1,"minimum_mana":3,"usable_while_learning":true,"training":["mana_perception","guided_mobility_practice"]}'::jsonb,
  presentation='{"visual":"Correntes de ar envolvem os tornozelos e aliviam cada passada.","sound":"Um breve assobio de vento acompanha a aceleração.","motion":"O usuário inclina o corpo e acompanha a direção da corrente de ar."}'::jsonb,
  tags='["air","mobility","evasion","balance","beginner"]'::jsonb,
  metadata=metadata||'{"balance_tier":"beginner","created_from_narrative_training":true}'::jsonb,
  schema_version=1,
  validation_status='valid',
  validation_errors='[]'::jsonb,
  validated_at=now(),
  version=version+1,
  updated_at=now()
where code='wind_breeze_step' and content_type='skill';