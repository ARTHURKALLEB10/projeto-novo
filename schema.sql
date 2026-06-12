-- ═══════════════════════════════════════════
--  Clínica ABA — Schema Supabase (Fase 1)
-- ═══════════════════════════════════════════

-- Habilitar extensão UUID
create extension if not exists "uuid-ossp";

-- ─── PERFIS DE USUÁRIO ───────────────────────────────────────
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  nome        text not null,
  role        text not null check (role in ('admin','terapeuta','recepcao')),
  ativo       boolean default true,
  created_at  timestamptz default now()
);

-- ─── HISTÓRICO DE LOGINS (painel do admin master) ────────────
create table login_history (
  id          bigserial primary key,
  user_id     uuid references profiles(id),
  email       text,
  nome        text,
  role        text,
  ip          text,
  user_agent  text,
  created_at  timestamptz default now()
);

-- ─── PACIENTES ───────────────────────────────────────────────
create table pacientes (
  id              uuid primary key default uuid_generate_v4(),
  nome            text not null,
  data_nascimento date,
  responsavel     text,
  telefone        text,
  email           text,
  diagnostico     text,
  observacoes     text,
  ativo           boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── TERAPEUTAS (ligado ao profile) ──────────────────────────
create table terapeutas (
  id          uuid primary key references profiles(id) on delete cascade,
  especialidade text,
  cref        text
);

-- ─── TURMAS ──────────────────────────────────────────────────
create table turmas (
  id          uuid primary key default uuid_generate_v4(),
  nome        text not null,
  descricao   text,
  terapeuta_id uuid references terapeutas(id),
  ativa       boolean default true,
  created_at  timestamptz default now()
);

-- ─── MATRICULAS (paciente ↔ turma) ───────────────────────────
create table matriculas (
  id          bigserial primary key,
  paciente_id uuid references pacientes(id) on delete cascade,
  turma_id    uuid references turmas(id) on delete cascade,
  data_inicio date default current_date,
  ativa       boolean default true,
  unique (paciente_id, turma_id)
);

-- ─── AGENDA / SESSÕES ─────────────────────────────────────────
create table sessoes (
  id              uuid primary key default uuid_generate_v4(),
  paciente_id     uuid references pacientes(id),
  turma_id        uuid references turmas(id),
  terapeuta_id    uuid references terapeutas(id),
  titulo          text,
  inicio          timestamptz not null,
  fim             timestamptz not null,
  status          text default 'agendada' check (status in ('agendada','realizada','falta','cancelada')),
  observacoes     text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── EVOLUÇÕES ───────────────────────────────────────────────
create table evolucoes (
  id          uuid primary key default uuid_generate_v4(),
  sessao_id   uuid references sessoes(id) on delete cascade,
  paciente_id uuid references pacientes(id),
  terapeuta_id uuid references terapeutas(id),
  texto       text not null,
  created_at  timestamptz default now()
);

-- ─── FINANCEIRO — LANÇAMENTOS ────────────────────────────────
create table lancamentos (
  id          uuid primary key default uuid_generate_v4(),
  paciente_id uuid references pacientes(id),
  tipo        text not null check (tipo in ('receita','despesa')),
  categoria   text,
  descricao   text not null,
  valor       numeric(10,2) not null,
  vencimento  date,
  pago        boolean default false,
  pago_em     date,
  created_at  timestamptz default now()
);

-- ─── CHAT INTERNO — MENSAGENS ────────────────────────────────
create table chat_messages (
  id          bigserial primary key,
  from_id     uuid references profiles(id),
  to_id       uuid references profiles(id),   -- null = broadcast/geral
  texto       text not null,
  lida        boolean default false,
  created_at  timestamptz default now()
);

-- ═══════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ═══════════════════════════════════════════

alter table profiles       enable row level security;
alter table login_history  enable row level security;
alter table pacientes      enable row level security;
alter table terapeutas     enable row level security;
alter table turmas         enable row level security;
alter table matriculas     enable row level security;
alter table sessoes        enable row level security;
alter table evolucoes      enable row level security;
alter table lancamentos    enable row level security;
alter table chat_messages  enable row level security;

-- Usuários autenticados leem seus próprios dados
create policy "profiles: self" on profiles for select using (auth.uid() = id);
create policy "profiles: admin all" on profiles for all using (
  exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
);

-- Login history — apenas admin visualiza
create policy "login_history: admin only" on login_history for select using (
  exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
);
create policy "login_history: insert all" on login_history for insert with check (true);

-- Pacientes, turmas, sessões — qualquer usuário autenticado acessa
create policy "pacientes: auth read" on pacientes for select using (auth.uid() is not null);
create policy "pacientes: auth write" on pacientes for all using (auth.uid() is not null);

create policy "terapeutas: auth read" on terapeutas for select using (auth.uid() is not null);
create policy "terapeutas: auth write" on terapeutas for all using (auth.uid() is not null);

create policy "turmas: auth" on turmas for all using (auth.uid() is not null);
create policy "matriculas: auth" on matriculas for all using (auth.uid() is not null);
create policy "sessoes: auth" on sessoes for all using (auth.uid() is not null);
create policy "evolucoes: auth" on evolucoes for all using (auth.uid() is not null);
create policy "lancamentos: auth" on lancamentos for all using (auth.uid() is not null);
create policy "chat_messages: auth" on chat_messages for all using (auth.uid() is not null);

-- ═══════════════════════════════════════════
--  FUNÇÕES E TRIGGERS
-- ═══════════════════════════════════════════

-- Atualiza updated_at automaticamente
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger trg_pacientes_updated before update on pacientes
  for each row execute procedure set_updated_at();
create trigger trg_sessoes_updated before update on sessoes
  for each row execute procedure set_updated_at();

-- Cria profile automaticamente quando usuário se registra
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, nome, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'role', 'recepcao')
  );
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();
