# RailBET

Um jogo de palpites sobre atrasos dos comboios portugueses, apenas com créditos fictícios. Interface em português, Next.js 16, React 19 e TypeScript. Preparado para Vercel; contas e dados partilhados em Supabase.

**Estado:** MVP com demonstração funcional. A ligação à IP está implementada a partir do `comboios-rs`, mas os pedidos de verificação nesta sessão devolveram HTTP 403. Não há importação de viagens reais sem uma resposta válida. A confirmação de chegadas é manual nesta versão.

## Experimentar em dois minutos

Instala Node.js 24, abre esta pasta no terminal e executa:

```sh
npm ci
npm run dev
```

Abre `http://127.0.0.1:3000`. Não precisas de variáveis de ambiente para experimentar. Tens 1 000 créditos locais, três comboios e quatro adversários simulados por viagem. Dá um palpite e carrega em **Simular chegada**. O cenário chega com 13 minutos de atraso. Aposta 100 créditos em 12 minutos para experimentar um empate proporcional que paga 270 créditos.

A demonstração fica apenas no armazenamento deste navegador. Limpar os dados do site apaga-a. Não entra na classificação nem altera créditos da conta. O modo partilhado precisa da configuração abaixo.

## Publicar na Vercel

### 1. Publicar a demonstração

1. Cria um repositório GitHub teu e coloca nele **o conteúdo desta pasta**, incluindo `package.json`, `package-lock.json`, `app`, `lib`, `supabase`, `public`, `tests` e `vendor`. Inclui também os ficheiros de configuração. Não envies `node_modules`, `.next`, `.env.local` nem os logs.
2. Na Vercel, escolhe **Add New → Project → Import Git Repository** e seleciona esse repositório.
3. Framework: **Next.js**. Root Directory: a pasta que contém `package.json` (`.` se colocaste os ficheiros na raiz). Node.js: **24.x**. `vercel.json` já define `npm ci` e `npm run build`.
4. Carrega em **Deploy**. A demonstração funciona sem configurar serviços externos. A Vercel atribui um endereço `*.vercel.app`.

Também podes publicar pela CLI, a partir desta pasta: `npx vercel`, seguido de `npx vercel --prod`. A CLI pede autenticação na tua conta. Este projeto não foi publicado durante o desenvolvimento.

### 2. Ativar contas e dados partilhados

1. Cria um projeto Supabase, de preferência na Europa.
2. No **SQL Editor**, executa o ficheiro completo `supabase/migrations/001_railbet.sql` uma vez, num projeto novo. A migração é transacional e não apaga tabelas existentes. Se já estiver aplicada, não a voltes a executar.
3. Copia o URL do projeto e a **publishable key** da secção de API/Connect. Na Vercel → Project Settings → Environment Variables, adiciona:

| Nome | Valor |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | URL `https://...supabase.co` do teu projeto |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Chave pública `sb_publishable_...` |

Não é necessária uma chave `service_role`, a palavra-passe de Postgres ou um token da IP. As permissões estão na base de dados. Para desenvolvimento local, copia `.env.example` para `.env.local` e preenche estes dois valores.

4. Supabase → **Authentication → URL Configuration**: define o **Site URL** como o endereço público da aplicação. Em **Redirect URLs**, autoriza exatamente `https://TEU-PROJETO.vercel.app/auth/callback`. Para testes locais, acrescenta `http://127.0.0.1:3000/auth/callback`.
5. Ativa email/password. Para inscrições por email fora da equipa do projeto, configura **Custom SMTP** no Supabase. O envio de emails integrado tem limites e destinatários restritos; não serve como serviço de email público. Mantém o template de confirmação com o link padrão de confirmação. Abre esse link no navegador onde criaste a conta, pois o fluxo usa PKCE.
6. Faz **Redeploy** na Vercel após guardar as variáveis. Regista e confirma a tua conta em `/login` e entra na aplicação.

Para uma beta pequena sem envio de emails, podes criar contas confirmadas diretamente em **Authentication → Users → Add user**. A aplicação aceita o login dessas contas. Não disponibiliza ainda recuperação de palavra-passe pela interface; a gestão fica no Supabase.

### 3. Escolher o administrador

Depois de entrares pelo menos uma vez, copia o teu UUID em Supabase → Authentication → Users e executa no SQL Editor:

```sql
insert into public.admins(user_id)
values ('SUBSTITUI-PELO-TEU-UUID')
on conflict do nothing;
```

Atualiza a aplicação. Surge **Gestão de viagens** na navegação. Não existe atribuição automática de administração ao primeiro visitante.

### 4. Abrir uma viagem real

Em **Gestão de viagens**, indica um número de comboio e uma data futura. A IP tem de devolver origem, destino e horários reconhecidos; a abertura fecha 10 minutos antes da partida. Os jogadores autenticados veem a viagem em **Comboios reais** e podem apostar.

A atualização da IP é manual e limitada a uma consulta a cada 15 segundos. Se aparecer HTTP 403, não são inventadas viagens: o acesso precisa de ser confirmado com a fonte ou de um endpoint autorizado alternativo. Um deploy na Vercel não garante acesso à IP.

Após a chegada programada, o administrador pode indicar o atraso efetivo e registar uma fonte/justificação. Usa os minutos completos entre a chegada efetiva e a chegada programada; chegadas antecipadas valem zero. Uma viagem suprimida ou sem resultado confirmável deve ser anulada. Não uses horas previstas como se fossem uma chegada efetiva.

## Regras implementadas

- Cada conta começa com 1 000 créditos fictícios. Há uma reposição de 500 a cada 7 dias após a entrada ou a última reposição, mediante pedido.
- Uma aposta por pessoa, comboio e data. Previsão de 0 a 360 minutos inteiros. Aposta de 10 a 500 créditos, em múltiplos de 10.
- O servidor fecha apostas 10 minutos antes da partida programada na origem. Os palpites alheios ficam escondidos até ao fecho.
- Ganha o menor erro absoluto em relação ao atraso no destino. Os vencedores dividem 90% do total, proporcionalmente às suas apostas. O pagamento inclui a aposta original.
- A parcela da casa é exatamente 10%. Restos inteiros são atribuídos pelas maiores partes decimais, com desempate pelo identificador da aposta.
- Anulação ou menos de dois participantes: devolução integral, sem parcela da casa.
- Apostas repetidas com os mesmos dados e confirmações repetidas não voltam a movimentar créditos. As transações registam todos os movimentos.
- Não há compra, transferência, levantamento ou conversão dos créditos em dinheiro.

## Como está organizado

| Caminho | Responsabilidade |
| --- | --- |
| `app/railbet.tsx` e `app/railbet.css` | Painel, palpite, carteira, historial, classificação, regras e administração |
| `app/api/game/route.ts` | Sessão validada, ações partilhadas e consulta da IP no servidor |
| `app/api/auth` e `app/auth/callback` | Login email/password e confirmação por PKCE |
| `lib/rules.ts` | Referência dos cálculos e validação de apostas |
| `lib/demo.ts` | Demonstração isolada no navegador |
| `lib/ip.ts` | Adaptador IP e conversão de horas Europe/Lisbon |
| `supabase/migrations/001_railbet.sql` | Tabelas, RLS, permissões e transações Postgres |
| `tests` | Regras, demonstração, permissões e pagamentos em Postgres local |
| `vendor/comboios-rs` | Fonte original, versão fixada e licença MIT |

As contas reais usam Supabase Auth com cookies. Cada pedido valida a identidade com `getUser`; as funções SQL confirmam `auth.uid()`. As tabelas têm RLS ativa e não permitem escrita direta aos clientes. As funções privilegiadas validam utilizador ou administrador e usam um `search_path` fixo. Os pagamentos e o diário de movimentos são atualizados na mesma transação. Atualizar dados da IP não altera os termos originais de uma aposta.

Não há SQLite local, servidor persistente ou estado global em memória para as contas partilhadas. As rotas funcionam em Vercel Functions com Postgres externo. A região está definida como `fra1`.

## Verificação

```sh
npm test
npm run typecheck
npm run build
npm start
```

Os testes da migração usam PGlite (Postgres em WASM), com a identidade Supabase simulada. Cobrem permissões, palpites privados, débito único, falta de saldo, fecho, pagamentos proporcionais, arredondamentos, devoluções, repetição de pagamentos, reposição semanal e uma falha a meio do pagamento que tem de reverter toda a transação. Não substituem um teste integrado nas tuas contas reais.

Depois de configurar Supabase/Vercel, verifica a confirmação de email, o login de duas contas distintas, a persistência dos saldos, as permissões de administrador e o acesso efetivo à IP. Autenticação alojada, entregabilidade de emails e acesso IP desde Vercel não foram validados sem essas contas.

## Custos e limites desta versão

O objetivo é um projeto pessoal pequeno nos planos gratuitos, sujeito aos limites e condições atuais dos serviços. Consulta os painéis de utilização antes de alargar o acesso. Supabase pode pausar projetos gratuitos por inatividade.

Não há consultas automáticas em segundo plano. O cron de Vercel Hobby não permite a frequência de minutos necessária a um acompanhamento de comboios. A primeira versão permite consultas manuais. Uma fase seguinte pode acrescentar um coletor com agendamento adequado, histórico de chegadas confirmadas e resolução automática apenas com evidência válida.

Outras limitações: a demonstração não sincroniza entre dispositivos; contas e recuperação de acesso dependem da configuração Supabase; não existe prevenção de múltiplas contas por pessoa; a classificação é simples e global. A interface não apresenta posição GPS nem inventa posições a partir do horário.

## Origem dos dados e licença

Foi usado o repositório pedido: [caiocdcs/comboios-rs](https://github.com/caiocdcs/comboios-rs), commit `842a93b1f2f5b780301792f45992fad13274a8d4`. O adaptador foi portado de Rust para TypeScript para funcionar em Next.js/Vercel. O código original e a licença MIT de Caio Silva acompanham o projeto. Os caminhos e campos JSON seguem essa implementação, incluindo o endpoint `horarios-ncombio`.

No adaptador original, `actual_arrival` é `None`. O RailBET mantém essa distinção: `Hora Prevista` e o simples passar da hora não provam uma chegada. A licença do código não é uma garantia de disponibilidade ou autorização de uso do serviço de dados.

Referências de configuração:

- [Next.js na Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Publicar um repositório Git](https://vercel.com/docs/git)
- [Versões Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Supabase Auth no servidor](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Limites do cron Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing)
