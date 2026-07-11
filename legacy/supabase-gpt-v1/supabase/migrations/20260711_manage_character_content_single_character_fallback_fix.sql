do $$
declare
  v_oid oid;
  v_definition text;
  v_old text := 'select case when count(*)=1 then min(id) end into v_character_id';
  v_new text := 'select case when count(*)=1 then (array_agg(id))[1] end into v_character_id';
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

  if position(v_old in v_definition)=0 then
    raise exception 'manage_character_content_fallback_marker_not_found';
  end if;

  v_definition:=replace(v_definition,v_old,v_new);
  execute v_definition;
end $$;