# Banco de dados próprio e sincronização do desenvolvimento

Atualizado em 04/11/2026. Fases 1 e 2 da saída do Supabase. O banco do Coolify (`xpeed-db`) existe, está migrado e conectado ao app. O servidor já atende tabelas e funções em `/api/db`, mas o app só passa a usá-lo com `VITE_DATA_API=true` (fase 5), então hoje ainda lê e grava no Supabase.

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

## Dados pelo servidor (`/api/db`)

O navegador e o app Android não falam mais com o PostgREST do Supabase quando `VITE_DATA_API=true`. O cliente (`src/lib/api-data.ts`) mantém as mesmas chamadas encadeadas (`from().select().eq()...`, `rpc()`), então nenhum dos ~16 arquivos de acesso a dados mudou. Storage, edge functions e realtime seguem no Supabase até as fases 3 e 4.

- **Servidor** (`server/db-route.ts`, `server/db-query.ts`): recebe a consulta como dado (nunca SQL), confere tabela e coluna contra o esquema real, passa todos os valores como parâmetros e executa como `authenticated` com as claims do token verificado. A RLS do banco decide o acesso. Sem token roda como `anon` (páginas públicas, como o relatório compartilhado). Token inválido é recusado, não rebaixado.
- **Comportamento igual ao PostgREST:** teto de 1000 linhas por resposta, `single()` e `maybeSingle()` com o erro `PGRST116`, códigos do Postgres (`23505` etc.), `count`/`head`, `upsert`, relações embutidas por chave estrangeira e a expressão `or()` usada pela lista de viagens. `update` e `delete` sem filtro são recusados.
- **Dev:** `npm run dev` já serve `/api/db` pelo próprio Vite quando há `DATABASE_URL`. Para testar o app contra o banco de desenvolvimento, ponha `VITE_DATA_API=true` no `.env`.
- **Produção:** o app do Coolify já tem `DATABASE_URL` e `FIREBASE_PROJECT_ID`. A flag só liga no corte (fase 5), depois de levar os dados reais.

## Estado da infraestrutura (04/11/2026)

- `xpeed-db` criado no Coolify (PostgreSQL 17, sem porta pública, 512 MB, backup diário às 04:00 mantendo 14, igual ao `xpot-db`).
- O servidor aplicou as 58 migrações ao subir. O banco está com o esquema completo e **vazio**; os dados reais ainda estão no Supabase.
- Falta só você, no `.env` local: `DATABASE_URL` (string do Supabase de desenvolvimento) e, para a sincronização, um túnel até o banco de produção em `PROD_DATABASE_URL`.

## Testes

- `npm run test:db`: migrador, verificação de token, rota `/api/account`, RLS e o sync com dois bancos PostgreSQL reais em memória.
- `npm run test:dbapi`: a rota `/api/db` contra o esquema migrado: isolamento entre pessoas pela RLS, filtros, paginação por cursor, relações, `upsert`, funções, tentativas de injeção de SQL e CORS.
- `npm run test:boot`: sobe o servidor empacotado contra um banco em memória e confere que migra sozinho (precisa de `npm run build:server` antes).

## Próximas fases

3. Arquivos (fotos, anexos, CSV) e tempo real.
4. As 9 funções de borda (chat, análise, OAuth, MCP).
5. Corte: backup, levar os dados reais para o banco do Coolify, ligar `VITE_DATA_API` e desligar o acesso direto ao Supabase.
