# Banco de dados próprio e sincronização do desenvolvimento

Atualizado em 04/11/2026. Fases 1 a 4 da saída do Supabase (resta o corte). O banco do Coolify (`xpeed-db`) existe, está migrado e conectado ao app. O servidor já atende tabelas e funções em `/api/db`, mas o app só passa a usá-lo com `VITE_DATA_API=true` (fase 5), então hoje ainda lê e grava no Supabase.

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

O navegador e o app Android não falam mais com o PostgREST do Supabase quando `VITE_DATA_API=true`. O cliente (`src/lib/api-data.ts`) mantém as mesmas chamadas encadeadas (`from().select().eq()...`, `rpc()`), então nenhum dos ~16 arquivos de acesso a dados mudou. Com a mesma flag, arquivos e avisos de mudança também passam pelo servidor (seção abaixo). As edge functions seguem no Supabase até a fase 4.

- **Servidor** (`server/db-route.ts`, `server/db-query.ts`): recebe a consulta como dado (nunca SQL), confere tabela e coluna contra o esquema real, passa todos os valores como parâmetros e executa como `authenticated` com as claims do token verificado. A RLS do banco decide o acesso. Sem token roda como `anon` (páginas públicas, como o relatório compartilhado). Token inválido é recusado, não rebaixado.
- **Comportamento igual ao PostgREST:** teto de 1000 linhas por resposta, `single()` e `maybeSingle()` com o erro `PGRST116`, códigos do Postgres (`23505` etc.), `count`/`head`, `upsert`, relações embutidas por chave estrangeira e a expressão `or()` usada pela lista de viagens. `update` e `delete` sem filtro são recusados.
- **Dev:** `npm run dev` já serve `/api/db` pelo próprio Vite quando há `DATABASE_URL`. Para testar o app contra o banco de desenvolvimento, ponha `VITE_DATA_API=true` no `.env`.
- **Produção:** o app do Coolify já tem `DATABASE_URL` e `FIREBASE_PROJECT_ID`. A flag só liga no corte (fase 5), depois de levar os dados reais.

## Arquivos (`/api/storage`)

Os 5 buckets que o navegador usa passam pelo servidor quando `VITE_DATA_API=true`. `supabase.storage.from(bucket)` (`upload`, `remove`, `createSignedUrl`, `download`, `getPublicUrl`) é atendido por `src/lib/api-data.ts`.

- **Regras iguais às políticas antigas** (`server/files.ts`, `server/storage-route.ts`): em `session-csv`, `session-photos` e `car-photos` só a própria pessoa grava e lê, e o primeiro trecho do caminho tem de ser o id da conta. `app-icons` e `brand-assets` têm leitura pública e escrita de admin. `trip-checkpoints`, `vehicle-fuel-records` e `shared-trip-media` são só do servidor: nenhum navegador acessa. Limites de tamanho e tipos por bucket como antes.
- **Segurança:** caminhos com `..`, barras duplas, barra invertida ou caracteres de controle são recusados (e conferidos de novo contra a pasta do bucket); `upsert: false` nunca sobrescreve (a gravação é atômica); os arquivos são servidos com `nosniff` e `sandbox`, nunca como página.
- **Links assinados:** `POST /api/storage/sign` devolve um endereço com validade e assinatura HMAC (`STORAGE_SECRET`). Vale só para aquele arquivo, aceita `Range` (vídeo) e deixa de funcionar ao expirar.
- **Onde ficam os bytes:** em disco, atrás da interface `FileStore`, em `STORAGE_DIR` (`/data/files`, um volume persistente do Coolify). Trocar por S3/R2 depois é trocar uma classe. **O volume não entra no backup automático do banco**; a cópia dos arquivos é feita no corte (fase 5) e vale decidir antes um destino fora do servidor.
- **Avisos de mudança:** o Supabase realtime avisava "nova viagem" e mudanças em problemas. Agora o app consulta a contagem a cada 30 s com a página visível (`PollingChannel`), o que basta para esses dois avisos.
- **Dev:** `npm run dev` serve `/api/storage` em `.dev-files/` (ignorado pelo git).

## Handlers do servidor (`api/*`, `DATA_BACKEND`)

Combustível, cuidados do veículo, checkpoints de gravação, mídia compartilhada e sincronização de problemas rodam no servidor com a service role. Eles continuam escritos com as chamadas do supabase-js, e `api/_backend.ts` escolhe o que há por trás:

- `DATA_BACKEND` ausente: o Supabase, como sempre foi.
- `DATA_BACKEND=own` (com `DATABASE_URL`): o banco e os arquivos próprios. `server/service-client.ts` reaproveita o mesmo compilador de consultas de `/api/db` (papel `service` sem RLS, ou a pessoa verificada quando o handler age em nome dela) e o `FileStore`. `list()` devolve arquivos e pastas, e pastas vazias somem, como no Supabase.

Isso será ligado junto com a flag do cliente no corte. O teste `npm run test:handlers` roda os cinco handlers neste backend, com banco e pasta reais: recusas (sem token, token ruim, carro de outra pessoa), versão e conflito do cuidado do veículo, repetição e conflito por `Idempotency-Key` no combustível, e a gravação completa de uma viagem (checkpoints, reconstrução, finalização pela RPC `store_recorded_session` sob RLS, limpeza).

## Edge functions dentro do servidor (`/api/fn/<nome>`)

As 9 funções de `supabase/functions` rodam no servidor Node **sem mudar o código-fonte delas**. Na hora de empacotar (`scripts/esbuild-edge.mjs`), só quatro coisas que as prendiam ao Deno ou ao Supabase são trocadas por equivalentes em `server/functions/shims`:

- `serve()` do Deno: registra o manipulador em vez de abrir uma porta (`server/functions/registry.ts`);
- `createClient` do supabase-js: devolve o cliente de serviço do app. Com a chave de serviço, é o próprio servidor (sem RLS); com o cabeçalho `Authorization`, é a pessoa do token, verificada (RLS vale); sem nenhum dos dois, só o papel público;
- `npm:zod`: o pacote `zod` normal;
- `Deno.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_ANON_KEY` viram valores fixos que o `createClient` acima reconhece; `XPEED_APP_URL` cai em `PUBLIC_APP_URL`; o resto vem do ambiente.

Qualquer outro `https:`/`npm:` novo numa função **quebra o build** com uma mensagem dizendo onde pôr um adaptador, em vez de falhar só em produção. O mesmo código segue valendo no Supabase até o corte.

- O app chama `POST /api/fn/<nome>` (`supabase.functions.invoke` no `api-data.ts`, mesmo formato de erro: a resposta vai em `error.context`).
- `api/mcp` e `api/oauth/*` chamam a função dentro do processo quando `DATA_BACKEND=own`; `api/brand/manifest` lê o `brand_config` do banco próprio.
- Chave do provedor de IA, modelo e cotas já vivem no banco (`app_settings`, `consume_quota`), então vêm junto com os dados.
- **Segredos a levar no corte:** `XPEED_OAUTH_JWT_SECRET` (o mesmo valor do Supabase, para os tokens OAuth já emitidos continuarem válidos) e `XPEED_APP_URL` (ou `PUBLIC_APP_URL`).

`npm run test:functions` roda as funções reais com banco real e o provedor de IA simulado: login e corpo da requisição, chave e modelo vindos do banco, só o carro da própria pessoa no prompt, reembolso da cota quando o provedor falha, limite diário de 30 mensagens, funções aposentadas respondendo 410, registro OAuth gravado no banco, e os proxies chamando a função sem sair do processo.

## Estado da infraestrutura (04/11/2026)

- `xpeed-db` criado no Coolify (PostgreSQL 17, sem porta pública, 512 MB, backup diário às 04:00 mantendo 14, igual ao `xpot-db`).
- O servidor aplicou as 58 migrações ao subir. O banco está com o esquema completo e **vazio**; os dados reais ainda estão no Supabase.
- Volume `xpeed-files` montado em `/data/files`, mais `STORAGE_DIR` e `STORAGE_SECRET` (aleatório) no app do Coolify.
- Falta só você, no `.env` local: `DATABASE_URL` (string do Supabase de desenvolvimento) e, para a sincronização, um túnel até o banco de produção em `PROD_DATABASE_URL`.

## Testes

- `npm run test:db`: migrador, verificação de token, rota `/api/account`, RLS e o sync com dois bancos PostgreSQL reais em memória.
- `npm run test:dbapi`: as rotas `/api/db` e `/api/storage` contra o esquema migrado: isolamento entre pessoas pela RLS, filtros, paginação por cursor, relações, `upsert`, funções, tentativas de injeção de SQL, e nos arquivos: pastas por dono, travessia de caminho, tipos e tamanhos, links assinados adulterados ou expirados, `Range` e CORS.
- `npm run test:handlers`: os cinco handlers `api/*` no backend próprio (ver acima).
- `npm run test:functions`: as 9 edge functions hospedadas no servidor (ver acima).
- `npm run test:boot`: sobe o servidor empacotado contra um banco em memória e confere que migra sozinho (precisa de `npm run build:server` antes).

## Próximas fases

5. Corte: backup, levar os dados reais (banco e arquivos) para o Coolify, ligar `VITE_DATA_API` e `DATA_BACKEND=own` e desligar o acesso direto ao Supabase.
