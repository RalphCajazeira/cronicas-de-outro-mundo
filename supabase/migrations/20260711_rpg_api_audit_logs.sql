create table if not exists public.rpg_api_request_logs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  owner_id uuid,
  route text not null,
  operation_id text not null,
  request_payload jsonb not null default '{}'::jsonb,
  resolved_payload jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  status text not null default 'started' check (status in ('started','success','error')),
  http_status integer,
  error_code text,
  error_message text,
  error_stage text,
  duration_ms integer,
  edge_function text,
  edge_function_version text,
  api_key_present boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.rpg_api_request_log_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.rpg_api_request_logs(request_id) on delete cascade,
  stage text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rpg_api_request_logs_owner_created_idx
  on public.rpg_api_request_logs(owner_id,created_at desc);
create index if not exists rpg_api_request_logs_status_created_idx
  on public.rpg_api_request_logs(status,created_at desc);
create index if not exists rpg_api_request_log_events_request_idx
  on public.rpg_api_request_log_events(request_id,created_at);

alter table public.rpg_api_request_logs enable row level security;
alter table public.rpg_api_request_log_events enable row level security;

drop policy if exists rpg_api_request_logs_owner_read on public.rpg_api_request_logs;
create policy rpg_api_request_logs_owner_read
  on public.rpg_api_request_logs for select
  using(owner_id=auth.uid());

drop policy if exists rpg_api_request_log_events_owner_read on public.rpg_api_request_log_events;
create policy rpg_api_request_log_events_owner_read
  on public.rpg_api_request_log_events for select
  using(exists(
    select 1 from public.rpg_api_request_logs l
    where l.request_id=rpg_api_request_log_events.request_id
      and l.owner_id=auth.uid()
  ));

grant select,insert,update,delete on public.rpg_api_request_logs to service_role;
grant select,insert,update,delete on public.rpg_api_request_log_events to service_role;

create or replace function public.rpg_cleanup_api_audit_logs(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path='public'
as $$
declare v_deleted integer;
begin
  delete from public.rpg_api_request_logs
  where created_at < now() - make_interval(days=>greatest(coalesce(p_days,90),1));
  get diagnostics v_deleted=row_count;
  return v_deleted;
end $$;