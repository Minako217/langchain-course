-- Enable extension for UUID generation
create extension if not exists "pgcrypto";

-- Users profile table (long-term memory)
create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  external_user_id text not null unique,
  school_name text,
  city text,
  ward text,
  arrival_date date,
  stage text check (stage in ('pre_arrival', 'airport', 'week1', 'long_term')),
  urgent_issue text,
  japanese_level text,
  profile_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Conversation table
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  title text,
  memory_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Messages table (short-term memory)
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_user_profile_id
  on public.conversations(user_profile_id);

create index if not exists idx_messages_conversation_created_at
  on public.messages(conversation_id, created_at desc);

-- updated_at helper trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_updated_at();

drop trigger if exists trg_conversations_updated_at on public.conversations;
create trigger trg_conversations_updated_at
before update on public.conversations
for each row
execute function public.set_updated_at();
