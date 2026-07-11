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
  select * into v_blueprint
  from public.rpg_content_blueprints
  where content_type=p_content_type and status='active';

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
      if jsonb_typeof(v_mechanics->'effects')<>'array' then
        v_errors:=v_errors||jsonb_build_array('mechanics.effects_must_be_array');
      elsif jsonb_array_length(v_mechanics->'effects')=0 then
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
    select id into v_id
    from public.rpg_characters
    where owner_id=p_owner and lower(name)=lower(trim(p_reference))
    order by created_at desc
    limit 1;
  end if;
  if v_id is null then
    select case when count(*)=1 then (array_agg(id))[1] end
    into v_id
    from public.rpg_characters
    where owner_id=p_owner;
  end if;
  return v_id;
end;
$$;