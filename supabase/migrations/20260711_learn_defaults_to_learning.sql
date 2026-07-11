create or replace function public.rpg_gateway_manage_character_content(
  p_api_key text,
  p_character_id text,
  p_operation text,
  p_content_id text,
  p_changes jsonb default '{}'::jsonb
)
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
  v_ref_uuid uuid;
  v_default_state text;
begin
  v_owner:=public.rpg_validate_api_key(p_api_key);

  if p_character_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_ref_uuid:=p_character_id::uuid;
    select id into v_character_id from public.rpg_characters where id=v_ref_uuid and owner_id=v_owner;
    if v_character_id is null then
      select source_id into v_character_id from public.rpg_actors where id=v_ref_uuid and owner_id=v_owner and source_kind='character' limit 1;
    end if;
  else
    select id into v_character_id from public.rpg_characters where owner_id=v_owner and lower(name)=lower(trim(p_character_id)) order by created_at desc limit 1;
  end if;

  if v_character_id is null then
    select case when count(*)=1 then (array_agg(id))[1] end into v_character_id
    from public.rpg_characters where owner_id=v_owner;
  end if;

  select * into v_char from public.rpg_characters where id=v_character_id and owner_id=v_owner;
  if v_char.id is null then raise exception 'character_not_found'; end if;

  if p_content_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_content_id:=p_content_id::uuid;
  else
    select c.id into v_content_id
    from public.rpg_content_catalog c
    join public.rpg_campaigns ca on ca.id=v_char.campaign_id
    where c.owner_id=v_owner
      and c.world_id=ca.world_id
      and c.status='active'
      and (c.scope='world' or c.campaign_id=v_char.campaign_id)
      and (lower(c.code)=lower(trim(p_content_id)) or lower(c.name)=lower(trim(p_content_id)))
    order by case when lower(c.code)=lower(trim(p_content_id)) then 0 else 1 end,c.updated_at desc
    limit 1;
  end if;

  select c.* into v_content
  from public.rpg_content_catalog c
  join public.rpg_campaigns ca on ca.id=v_char.campaign_id
  where c.id=v_content_id and c.owner_id=v_owner and c.world_id=ca.world_id
    and (c.scope='world' or c.campaign_id=v_char.campaign_id);
  if v_content.id is null then raise exception 'content_not_found'; end if;

  v_default_state:=case
    when p_operation='learn' then 'learning'
    when p_operation='equip' then 'owned'
    when p_operation in ('grant','add') then 'known'
    else null
  end;

  if p_operation in ('learn','grant','add','equip') then
    insert into public.rpg_character_content(
      owner_id,character_id,content_id,state,rank,progress,mastery,equipped,quantity,notes,metadata
    ) values(
      v_owner,
      v_character_id,
      v_content_id,
      coalesce(nullif(p_changes->>'state',''),v_default_state),
      coalesce(nullif(p_changes->>'rank','')::int,1),
      coalesce(nullif(p_changes->>'progress','')::int,0),
      coalesce(nullif(p_changes->>'mastery','')::int,0),
      coalesce((p_changes->>'equipped')::boolean,p_operation='equip'),
      coalesce(nullif(p_changes->>'quantity','')::int,1),
      nullif(p_changes->>'notes',''),
      coalesce(p_changes->'metadata','{}'::jsonb)
    )
    on conflict(character_id,content_id) do update set
      state=coalesce(nullif(p_changes->>'state',''),case when p_operation='learn' then 'learning' else public.rpg_character_content.state end),
      rank=greatest(1,public.rpg_character_content.rank+coalesce(nullif(p_changes->>'rank_delta','')::int,0)),
      progress=greatest(0,public.rpg_character_content.progress+coalesce(nullif(p_changes->>'progress_delta','')::int,0)),
      mastery=greatest(0,public.rpg_character_content.mastery+coalesce(nullif(p_changes->>'mastery_delta','')::int,0)),
      equipped=coalesce((p_changes->>'equipped')::boolean,p_operation='equip',public.rpg_character_content.equipped),
      quantity=greatest(0,public.rpg_character_content.quantity+coalesce(nullif(p_changes->>'quantity_delta','')::int,0)),
      notes=coalesce(nullif(p_changes->>'notes',''),public.rpg_character_content.notes),
      metadata=public.rpg_character_content.metadata||coalesce(p_changes->'metadata','{}'::jsonb),
      updated_at=now()
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
      metadata=metadata||coalesce(p_changes->'metadata','{}'::jsonb),
      updated_at=now()
    where character_id=v_character_id and content_id=v_content_id
    returning * into v_row;
  elsif p_operation in ('remove','forget','unequip') then
    if p_operation='unequip' then
      update public.rpg_character_content set equipped=false,updated_at=now()
      where character_id=v_character_id and content_id=v_content_id returning * into v_row;
    else
      delete from public.rpg_character_content
      where character_id=v_character_id and content_id=v_content_id returning * into v_row;
    end if;
  else
    raise exception 'unsupported_content_operation';
  end if;

  if v_row.id is null and p_operation not in ('remove','forget') then
    raise exception 'character_content_not_found';
  end if;

  return jsonb_build_object('character_content',to_jsonb(v_row),'content',to_jsonb(v_content));
end;
$$;
