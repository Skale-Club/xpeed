# Banco de dados próprio e sincronização do desenvolvimento

Atualizado em 03/11/2026. Fase 1 da saída do Supabase: a base existe e está testada, mas o app ainda lê e grava no Supabase. As fases seguintes movem o acesso aos dados para o servidor.

## Como fica

| Ambiente | Banco | Quem aplica o esquema |
|---|---|---|
| Produção | PostgreSQL no Coolify (mesmo servidor do app) | O próprio servidor, ao iniciar (`RUN_MIGRATIONS=false` desliga) |
| Desenvolvimento | Projeto Supabase `drqmrddxlrlbqnydumjm` | `npm run dev` (script `predev`) |

As 58 migrações de `supabase/migrations` valem para os dois. Em um Postgres comum o migrador instala antes [db/compat.sql](../../db/compat.sql) (papéis `anon`, `authenticated`, `service_role` e os esquemas `auth` e `storage` mínimos). Em um projeto Supabase já migrado pelo CLI ele **adota** esse histórico e não roda nada duas vezes.

A regra de acesso (RLS) continua no banco. O servidor se comporta como o PostgREST: valida o token Google, abre uma transação como `authenticated` e entrega as claims ao banco (`server/db.ts`, `asIdentity`). Assim `current_app_user_id()` e todas as políticas funcionam sem mudança.

## O que `npm run dev` faz agora

1. Aplica as migrações pendentes em `DATABASE_URL` (o Supabase de desenvolvimento).
2. Se `PROD_DATABASE_URL` existir, **substitui** os dados do desenvolvimento por uma cópia anonimizada da produção. A produção só é lida (transação `READ ONLY`).
3. Sobe o Vite.

Se algo falhar, o script diz o motivo e o Vite sobe mesmo assim. `npm run dev:fast` ou `DEV_SYNC=off` pulam a sincronização.

### O que é anonimizado

- Contas: e-mail, telefone e nome trocados. As contas listadas em `DEV_KEEP_EMAILS` / `DEV_KEEP_PHONES` ficam como estão, para você entrar e ver seus próprios dados.
- Carros: nome, chassi (VIN), foto e anotações removidos; marca, modelo e ano ficam.
- Viagens: nome e caminho do arquivo e o CSV original removidos; chaves de GPS, latitude e longitude somem das leituras.
- Conversas: títulos e mensagens substituídos.
- Não são copiados: tokens do MCP e OAuth, configurações do app, limites de uso, eventos de segurança, relatórios compartilhados e fotos de viagem.

### Travas de segurança

O sync **recusa** gravar quando `DATABASE_URL` aponta para o mesmo servidor da produção ou para um servidor que não seja do Supabase nem local. Para um banco de desenvolvimento em outro lugar, defina `DEV_SYNC_ALLOW_TARGET=host:porta`.

## O que falta fazer à mão (precisa de você)

1. **Criar o PostgreSQL no Coolify** (Resources, New, Database, PostgreSQL), na mesma rede do app. Ligar o backup agendado.
2. No app do Coolify, definir `DATABASE_URL` (endereço interno do banco) e `FIREBASE_PROJECT_ID=skaleclub`. Sem `DATABASE_URL` o servidor segue como antes.
3. Em `.env`, preencher `DATABASE_URL` com a string de conexão do Supabase de desenvolvimento (Settings, Database). Para o `PROD_DATABASE_URL`, abrir um túnel até o banco de produção (SSH ou Tailscale) e usar um usuário somente leitura.

Nada disso é necessário para o app continuar funcionando hoje.

## Testes

- `npm run test:db`: migrador, verificação de token, rota `/api/account`, RLS e o sync com dois bancos PostgreSQL reais em memória.
- `npm run test:boot`: sobe o servidor empacotado contra um banco em memória e confere que migra sozinho (precisa de `npm run build:server` antes).

## Próximas fases

2. Portar as 17 tabelas e 11 funções que o navegador chama hoje para rotas `/api`.
3. Arquivos (fotos, anexos) e tempo real.
4. As 9 funções de borda (chat, análise, OAuth, MCP).
5. Corte: levar os dados reais para o banco do Coolify e desligar o acesso direto ao Supabase.
