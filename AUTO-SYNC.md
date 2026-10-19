# Colocar comboios no painel automaticamente

O deploy anterior só consultava o arquivo histórico. Esta atualização lê os horários GTFS do Train Archive e cria mercados futuros no Supabase. O site abre agora em Comboios reais e atualiza os dados a cada minuto enquanto o separador estiver visível.

## Instalação

1. Copia os ficheiros deste pacote para a raiz do repositório RailBET, preservando as pastas. Inclui a pasta .github (pode estar oculta). O único ficheiro da interface substituído é app/railbet.tsx: se o alteraste entretanto, compara as versões.
2. No SQL Editor do Supabase, executa apenas supabase/migrations/002_train_archive_sync.sql. A migração 001 tem de já existir; não a voltes a executar.
3. Inicia sessão no RailBET com a tua conta administradora pelo menos uma vez. A sincronização exige uma conta registada nas tabelas admins e players; caso contrário falha sem criar viagens.
4. No GitHub, abre dtoAndre/RailBET → Settings → Secrets and variables → Actions → New repository secret. Cria:

| Secret | Valor |
| --- | --- |
| TRAIN_ARCHIVE_API_KEY | O teu token do Train Archive |
| SUPABASE_URL | A mesma URL do projeto usada no Vercel |
| SUPABASE_SERVICE_ROLE_KEY | Chave service_role do projeto Supabase (JWT legado) |

A service_role é uma credencial administrativa. Usa-a apenas no secret do GitHub para este processo; não a coloques no código, .env.example, navegador ou variável NEXT_PUBLIC_. Esta atualização não precisa dela no Vercel. Mantém as três variáveis do Vercel já existentes.

5. No PowerShell, na raiz do repositório:

```powershell
git add .github/workflows/sync-trains.yml scripts/sync_timetable.py scripts/test_sync.py scripts/requirements-sync.txt supabase/migrations/002_train_archive_sync.sql tests/sync.test.mjs app/railbet.tsx AUTO-SYNC.md
git commit -m "Automatically import future Train Archive schedules"
git push
```

6. No GitHub abre Actions → Sync future trains → Run workflow → main → Run workflow. O workflow tem de estar na branch predefinida para a execução agendada funcionar. Se o GitHub pedir para ativar Actions, ativa-as neste repositório.
7. Abre os logs da etapa python scripts/sync_timetable.py. Procura Validated future journeys e Supabase sync com inserted/received. Se inserted=0 numa repetição, as viagens podem já existir.
8. Quando a execução terminar com sucesso e o Vercel concluir o deploy, abre https://rail-bet.vercel.app, inicia sessão e seleciona Comboios reais. Recarrega a página se necessário.

## Execução automática

O GitHub Actions executa de seis em seis horas, ao minuto 17 (UTC), e permite execução manual. Pode sofrer atrasos ou ser desativado pelo GitHub. Não precisa do computador ligado nem de cron do Vercel. Em repositórios privados consome a quota de minutos do GitHub; verifica Billing/Usage e não atives despesa adicional se queres manter o limite gratuito.

Cada execução escolhe até 20 partidas futuras por data dentro das próximas 48 horas, respeitando o calendário e as exceções. Repetições são idempotentes. Para restringir os comboios, cria em Actions → Variables a variável RAILBET_TRAINS, por exemplo 125,127,129. A correspondência utiliza trip_short_name numérico do GTFS; identificadores opacos nunca são convertidos adivinhando números.

Os horários existentes ficam congelados para proteger as condições das apostas. Alterações posteriores de horário ou supressões exigem revisão manual. O processo não apaga mercados antigos, não altera saldos e não liquida prémios.

## Limites explícitos

Esta atualização resolve a criação automática de viagens reais no painel, usando o Train Archive em vez de pedidos individuais à IP. Não implementa acompanhamento automático dos atrasos intradiários nem confirma a chegada efetiva. O painel histórico continua disponível para análise e a confirmação de resultados continua manual. Não utiliza atrasos históricos como se fossem previsões de hoje.

O importador rejeita calendários ausentes, números de comboio desconhecidos, viagens ambíguas e horários inválidos. Se a fonte mudar de formato, o workflow falha com diagnóstico em vez de inventar comboios. Horas GTFS acima de 24:00 e mudanças de hora são tratadas conforme a definição GTFS.

## Diagnóstico

- HTTP 401/403 no Train Archive: confirma o token no secret do GitHub.
- HTTP 401/403 no Supabase: confirma URL e service_role do mesmo projeto.
- HTTP 404 no Supabase: confirma que a migração 002 foi executada.
- HTTP 400 no Supabase: verifica a migração e a existência de um administrador com perfil em players.
- No eligible future journeys: verifica os campos/calendário da fonte e eventual filtro RAILBET_TRAINS; não há inserções nessa execução.
- Workflow verde mas painel vazio: confirma que site e workflow usam o mesmo projeto Supabase e que estás autenticado no modo Comboios reais.

Documentação: https://www.train-archive.eu/connect ; https://gtfs.org/documentation/schedule/reference/ ; https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
