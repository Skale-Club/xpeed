# Execução conservadora da revisão

Registro histórico da primeira execução. O estado mais recente, após a continuação autorizada, está em [EXECUCAO.md](EXECUCAO.md).

Data: 29/10/2026. Base: `61340cde3514af1bb1b6102bfaeca7d97e65d95a`. Trabalho local, sem GSD. O usuário autorizou implementar os itens seguros após concluir o plano, deixando dúvidas para decisão posterior.

## Resultado verificado

- **292 testes passaram em 38 arquivos**, contra 264/30 no baseline.
- `npm run typecheck`: frontend e `api/` passaram.
- `npm run lint`: **0 erros, 13 avisos** (baseline: 8 erros/14 avisos). Avisos remanescentes: exports para Fast Refresh e dependências de hooks em `use-cars`/`McpTokensSection`; não foram suprimidos.
- `npm run build`: passou com URL/chave públicas fictícias; PWA gerou 71 entradas, 1801,83 KiB de precache. Avisos de imports dinâmicos/estáticos misturados permanecem; não impedem build.
- `git diff --check`: passou; Git emite avisos de conversão LF/CRLF, sem erro de whitespace.
- Script de reproduções atuais executado sem rede real; JSON original preservado. Verificações estáticas não substituem integração.
- Navegador Chrome com harness sintético: Home → Trips → detalhe; problemas e fotos visíveis. Rodapé desktop com padding inferior **16 px**, altura 49,5 px na amostra. Detalhe sem overflow horizontal em **390×844** e **360×800**; viewport restaurado após ensaio.

Testes/build usaram `https://example.supabase.co` e `test-placeholder`. Nenhum teste precisou de dados, chave de IA ou conexão de produção. Os workflows foram editados localmente; nenhum run remoto foi disparado.

## Correções implementadas

| Área/achados | Mudança | Limite |
|---|---|---|
| Leituras A03/A06/A10 | Helpers lançam erros; histórico tem retry; listagem inclui DTCs; cursor de sessões e paginação de flags em lotes de IDs | Retorna histórico completo para preservar consumidores; grandes contas ainda podem justificar paginação de UI/agregados dedicados |
| Unidades A02 | °F/K → °C, mph/m/s → km/h, psi → kPa e mV → V quando explicitamente declarados; long-format preserva UNITS | Sem unidade mantém convenção antiga; unidades físicas explícitas não reconhecidas são rejeitadas |
| Tempo A05 | Segundos e timestamps usam tempo decorrido; duração persistida; null/tempo inválido interrompe trecho; ordem invertida é rejeitada; última amostra não inventa intervalo | Sem eixo temporal mantém índice para regras legadas; saltos longos entre duas leituras válidas ainda exigem política |
| Reavaliação A01 | Serviço lê CSV original; gera derivados completos; usa uma única RPC; ausência do original/RPC falha sem fallback parcial; mantém ID e análise paga anterior marcada desatualizada | **Preparado, não homologado no banco**; reconciliação de problemas é best effort e não remove ocorrências antigas |
| Esquema A04 | Migração aditiva acrescenta `details`/`updated_at`, remove duas policies permissivas antigas e cria RPC com auth/ownership e `SECURITY INVOKER` | SQL/RLS não executados; não chamar este achado de resolvido em produção |
| PWA A11/H02 | Reload normal e erro de chunk respeitam gravação e holds de persistência; erro de página protegida preserva providers do scanner | Ensaio real com duas versões de SW e IndexedDB ainda pendente |
| Chat A08 | Respostas/histórico obsoletos não entram na conversa atual; envio trava por ref; contexto segue o carro da conversa; pergunta já salva permanece após erro | UX de retry/retomada de uma pergunta ainda pode evoluir |
| IA A14 | Card normaliza formato atual/legado; servidor valida JSON/campos antes de aceitar, reembolsando resposta inválida | Caminho Deno preparado, sem runtime/provedor real nesta sessão |
| MCP A09 | Preserva desafio `WWW-Authenticate`, versão de protocolo e cache; CORS aceita/expõe os cabeçalhos pertinentes | OAuth completo externo não homologado |
| Fotos A12/A15 | Assina foto recém-enviada; carrega por efeito cancelável; erros de remoção propagam; EN/PT/ES deixam de prometer análise visual | Expiração de URL, HEIC e limpeza de órfãos pendentes |
| Fuso/visual A13 | Helpers principais usam preferência validada; nomes de viagens/chat/compartilhamento/IA; rodapé compacto | Datas civis de manutenção não foram deslocadas; nem toda tela administrativa foi migrada |
| Qualidade | Harness respeita projeção/range/ordem; RPC desconhecida falha; CI bloqueia typecheck/lint; APK verifica antes do build; lint de APIs/scripts corrigido | Harness continua sem RLS/transação; gates externos não alterados |

## Decisões para o usuário

1. **Banco de homologação e publicação.** Escolher ambiente descartável/staging e janela para validar a migração. Docker existe, mas não havia daemon acessível; não há replay SQL/RLS. Não publicar o frontend dependente da RPC antes desse passo. A função indisponível deixa a viagem intacta, porém a ação de reavaliar retorna erro.
2. **Recuperação idempotente (H03, prioridade alta).** Ainda existe caminho que remove a sessão anterior pelo horário antes de refazer upload. Se a remoção do backup local falhou após sucesso, um retry pode substituir viagem completa. É preciso decidir/implementar identificador estável e reconhecimento de conclusão antes de migrar dados ou automatizar recuperação em massa. O retorno de deleção local agora é verificado/logado; a semântica de substituição não foi alterada sem um desenho validado.
3. **Lacunas e unidades desconhecidas.** Definir amostragem para CSV sem tempo, comportamento para unidades ausentes e intervalo máximo contínuo. Não mudei limiares mecânicos nem inventei limite de gap. Conversões de tempo declaradas em milissegundos/minutos e formatos externos adicionais precisam de fixtures reais antes de habilitar.
4. **Análises históricas.** Definir se/quando regenerar IA paga após reprocessar, o custo/cota permitido e como reconciliar problemas/ocorrências que deixaram de se justificar. O padrão implementado preserva análises e decisões antigas sem mostrá-las como atuais; não faz limpeza automática.
5. **OAuth e retenção.** Definir UI para revogar concessões OAuth (diferente dos tokens opacos), retenção/limpeza de fotos/CSVs órfãos, manifesto/share target e eventual necessidade de heartbeat por commit. Não concedi permissões nem alterei configurações remotas.

## Investigações mantidas

| ID | Estado após execução |
|---|---|
| H01 | Android tela apagada/foreground/bateria: exige aparelho e adaptador físicos |
| H02 | Guardas e testes de reload/persistência acrescentados; integração IDB/SW real pendente |
| H03 | Risco estático permanece; retorno de deleção observado/logado; decisão 2 acima |
| H04 | Proxy corrigido; gestão de concessões e ciclo de revogação externo pendentes |
| H05 | Não houve exclusão/varredura remota; inventário de órfãos pendente |
| H06 | Sem alterar share target/ícones dinâmicos antes de ensaio e decisão de produto |
| H07 | A → B → A por VIN e troca manual durante conexão: teste físico/controlado pendente |
| H08 | README corrigido; APK ganhou checks; heartbeat por commit/gates externos pendentes |

Bootstrap A07 também permanece pendente: há pressupostos históricos de `exec_sql`/seeds que precisam ser reproduzidos antes de editar migrações antigas. Não foi feito reset, squash ou marcação artificial de migrations como aplicadas.

## Limites de entrega

Sem commit, push, PR, deploy, migração remota ou automação criada. O arquivo preexistente `.github/keepalive-heartbeat` foi preservado. As alterações estão no working tree para revisão. Passar testes locais não demonstra isolamento real entre usuários, transação SQL, OAuth externo, funcionamento do adaptador ou segurança de todos os cenários.

O próximo trabalho é o [runbook de homologação](RUNBOOK.md), começando pelo banco isolado e pela idempotência. A avaliação inicial permanece como histórico dos achados, com links para este estado atual.
