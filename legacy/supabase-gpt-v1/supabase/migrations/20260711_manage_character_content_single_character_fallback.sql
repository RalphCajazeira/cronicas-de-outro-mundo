do $$
declare
  v_oid oid;
  v_definition text;
  v_marker text := '  select * into v_char from public.rpg_characters where id=v_character_id and owner_id=v_owner;';
  v_replacement text := '  if v_character_id is null then
    select case when count(*)=1 then min(id) end into v_character_id
    from public.rpg_characters
    where owner_id=v_owner;
  end if;
  select * into v_char from public.rpg_characters where id=v_character_id and owner_id=v_owner;';
begin
  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='rpg_gateway_manage_character_content'
    and pg_get_function_identity_arguments(p.oid)='p_api_key text, p_character_id text, p_operation text, p_content_id text, p_changes jsonb';

  if v_oid is null then
    raise exception 'manage_character_content_function_not_found';
  end if;

  select pg_get_functiondef(v_oid) into v_definition;

  if position(v_marker in v_definition)=0 then
    raise exception 'manage_character_content_patch_marker_not_found';
  end if;

  v_definition:=replace(v_definition,v_marker,v_replacement);
  execute v_definition;
end $$;