# Confiabilidade e preferências regionais

Trabalho local de 30/10/2026. Nenhum push, deploy ou aplicação de migração em produção neste pacote. A base publicada continua sendo o header compacto do commit f243ac4.

## Preferências

- Idioma, distância, temperatura, volume de combustível, consumo, moeda e fuso são escolhas independentes. Português pode ser combinado com USD, milhas, Fahrenheit, galões dos EUA e MPG.
- As preferências são confirmadas pelo botão Salvar e persistidas em um único registro. Falha na gravação não aplica metade das escolhas. As chaves antigas são espelhadas para compatibilidade.
- Migração preserva a apresentação de combustível antiga na primeira abertura. Depois, trocar milhas por quilômetros não altera litros/galões nem o formato de consumo.
- Volume usa L ou US gal; consumo usa km/L, L/100km ou MPG dos EUA. Conversões afetam somente a apresentação, mantendo litros e quilômetros no armazenamento.
- Combustível, histórico, comparação de períodos e detalhes da viagem usam as preferências escolhidas.
- Manutenção usa a moeda escolhida para novos registros, sem vinculá-la ao idioma. Preços e gastos antigos mantêm a moeda original, sem conversão cambial.
- Um preço antigo em outra moeda não é pré-preenchido como se tivesse a nova moeda.
- Datas de manutenção, inclusive a validação contra datas futuras, seguem o fuso do aplicativo.

## Gravação e sensores

- Gravação automática pronta para começar mostra Aguardando movimento.
- Confirmação de cópia local em Ajustes é baseada no número de amostras efetivamente gravadas; o horário só avança após confirmação do armazenamento. Backup na nuvem tem sua própria confirmação.
- Leituras ausentes ficam como — e Sem leitura. Um zero válido continua sendo exibido como zero. Valores não finitos não são apresentados como números.
- O painel mostra a hora do último ciclo recebido e identifica leituras pausadas. Leituras antigas deixam de ser mostradas como atuais; o histórico continua disponível, com lacunas no gráfico.
- A detecção de leitura antiga considera o tempo do ciclo do adaptador (mínimo de 15 segundos ou três ciclos).

## Notificações

- Avisos apresentam acesso explícito aos detalhes e a última ocorrência do problema.
- Um aviso de problema abre o card correspondente em Problemas, com foco e rolagem. Links para problemas resolvidos abrem a aba adequada.
- Repetições do mesmo problema atualizam a evidência e o contador, preservando o estado lido. Mudança de gravidade ou estado gera novo aviso.
- A migração do formato anterior de fingerprint preserva avisos já lidos.

## Pacote de confiabilidade anterior

Incluído na validação conjunta: fila durável de problemas, idempotência de abastecimentos e gravações, marcadores de exclusão, metadados de inspeção completos, identidade do carro conectado, paginação/calendário, cobertura dos dados, cache compartilhado e regras por modelo/ano. Evidências em ../revisao-2026-10-30/correcoes.md.

Antes de uma futura publicação, aplicar a migração 20261030160000_durable_issue_jobs_and_deletions.sql no ambiente de destino e verificar a recuperação. A validação SQL usa somente PostgreSQL isolado com dados sintéticos.

## Limites da validação

As verificações de interface usam a conta e o adaptador simulados. O servidor de interface não simula todos os RPCs de gravação, por isso não substitui os testes do banco. Não houve teste de Bluetooth físico ou de tela apagada em um Android real. Não foi implementada leitura automática de recibo por foto nesta etapa de confiabilidade e preferências.

## Conferência visual

- 390 px: escolha e salvamento de Português + USD + milhas + Fahrenheit + US gal + MPG; reabertura preservou as escolhas e o botão Salvar desapareceu após confirmação.
- Painel conectado: velocidade em mph e temperatura em Fahrenheit; limites numéricos legíveis, botão de detalhes contido nos cards e horário da leitura visível.
- Notificação abriu /issues#issue-i-1, focou o card do problema e atualizou o contador de não lidas.
- Evidências: preferencias-mobile.png, painel-mobile.png e aviso-abre-problema.png.
