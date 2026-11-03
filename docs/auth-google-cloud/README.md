# Autenticação sem senha e hospedagem

Atualizado em 03/11/2026. O frontend deste branch usa SMS como entrada principal e Google como alternativa. Banco, arquivos e funções continuam no Supabase nesta etapa. A hospedagem está sendo migrada da Vercel para o Coolify, conforme solicitado.

## Google Cloud configurado

Projeto compartilhado `skaleclub` (`937861185231`), com dois clientes OAuth web:

- Xpeed: `937861185231-1vsp3u6dhdb9cmvq0vcg4c9nq3v7sg41.apps.googleusercontent.com`.
- Xpot: `937861185231-5fn813rl7kmq72pk2b48bk9rhpqk0amd.apps.googleusercontent.com`.

O retorno de ambos é `https://skaleclub.firebaseapp.com/__/auth/handler`. O provedor Google usa o cliente Xpot por padrão; o cliente Xpeed também está autorizado e é usado pelo botão oficial Google Identity Services do Xpeed. Segredos OAuth ficam fora do frontend e do Git.

Phone e Google estão habilitados. As regiões SMS liberadas são Estados Unidos e Brasil. O SMS será enviado pelo Google Identity Platform; a implementação nova não usa Twilio. O projeto compartilha a base de identidades, mas permissões e contas de cada aplicação são independentes. Clientes OAuth separados não isolam a base de usuários nem a identidade visual do consentimento Google.

Não há tenant no fluxo de login. O Identity Platform não suporta telefone como primeiro fator em tenants. Dois tenants vazios criados durante a preparação não são usados pelos aplicativos.

O hook `xpeedBeforeSignIn`, em `us-east1`, está publicado e registrado. Ele aceita Google/Phone e atribui `role=authenticated`, exigido pela integração externa do Supabase. Não concede privilégios de administrador do app.

## Banco e compatibilidade

A migração `20261103140000_google_cloud_auth.sql` já foi aplicada no projeto Xpeed `drqmrddxlrlbqnydumjm`. Os UUIDs e os caminhos de arquivos foram preservados. O banco passa a associar UID Firebase a `app_accounts`, e as políticas usam `current_app_user_id()`. A integração Firebase do projeto `skaleclub` já está cadastrada no Supabase.

Um backup de esquema e um backup de dados foram feitos antes da migração e ficam fora do Git, em `C:/Users/Vanildo/Dev/xpeed/.codex-local/`. O ensaio no PostgreSQL remoto foi revertido antes da aplicação definitiva. As 2 contas e 19 viagens originais foram preservadas. Uma conta fictícia usada no ensaio foi removida depois da validação.

`google_auth_projects.allow_legacy=true` mantém a versão anterior funcionando durante o rollout web/Android. Contas antigas criadas durante essa janela também recebem seu UUID em `app_accounts`. Encerrar essa janela somente após validar e distribuir as versões novas; não apagar `auth.users`.

As funções `chat`, `analyze-session`, `ai-health`, `xpeed-oauth`, `xpeed-mcp` e `mcp-server` já foram republicadas. A nova versão de `read-fuel-receipt` deve ser publicada com o mesmo verificador antes do corte. As rotas do servidor de hospedagem verificam tokens Google por um RPC autenticado do Data API, sem consultar Supabase Auth.

## Evidências e limites

- 610 testes de componentes e lógica passaram na versão integrada à produção mais recente.
- As 58 migrações foram reproduzidas em PostgreSQL em memória, incluindo isolamento, continuidade dos UUIDs e rejeição de sessões antigas após o corte.
- Um número fictício oficial atravessou o serviço real Google, o hook e a autorização do Supabase. O número configurado e a conta de teste foram removidos. Nenhum SMS real foi enviado por esse teste.
- O servidor de contêiner foi validado com HTTP real: SPA, assets, cache, OAuth discovery, CORS, recusa de rotas inválidas, arquivos privados e corpos acima do limite.
- A configuração nativa Android (`google-services.json`, certificado de assinatura e teste em dispositivo) ainda precisa ser concluída antes da distribuição de um APK novo. O workflow recusa um arquivo de outro projeto, pacote ou cliente web.

## Xpot

As mudanças de login ficam na cópia isolada `C:/Users/Vanildo/Dev/xpot-google-auth`, branch `codex/google-passwordless-auth`, preservando as alterações locais de outras funcionalidades. O Xpot mantém seu PostgreSQL e suas sessões próprias, usa tokens Firebase verificados no backend e exige telefone na primeira associação do Google. Contas pendentes e bloqueadas não recebem sessão de acesso. O painel de clientes continua separado das sessões da equipe. Ativar `GOOGLE_AUTH_ENABLED=true` somente junto da versão validada e da migração `0079_google_identity_auth.sql`.

## Referências

- [Firebase com Supabase](https://supabase.com/docs/guides/auth/third-party/firebase-auth)
- [Autenticação Google para web](https://firebase.google.com/docs/auth/web/google-signin)
- [Telefone no Firebase](https://firebase.google.com/docs/auth/web/phone-auth)
- [Identity Platform: vários tenants](https://docs.cloud.google.com/identity-platform/docs/multi-tenancy)
