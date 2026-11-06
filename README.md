# Já Vi 🎬

App para um grupo marcar os filmes que já assistiu e ver a lista de cada pessoa.

- Quem cria o grupo recebe um link (`/g/CODIGO`). Quem tiver o link entra, informa o nome no primeiro acesso e marca os filmes.
- Na aba **Pessoas**, ao clicar no nome de alguém, você vê os filmes dessa pessoa, quantos vocês têm em comum e pode marcar com **+ Também vi**.
- A busca usa o lista do **IMDb** (mesmo endpoint de sugestões da caixa de busca do imdb.com), com poster, ano, elenco e link para a página do filme. Também dá para adicionar o título digitado à mão.
- Em **Ajustes** (⚙️) tem o *link pessoal*, que serve para usar a mesma lista em outro aparelho.

## Deploy (Cloudflare Workers + KV)

Mesma estrutura do Water Play: `wrangler.jsonc` na raiz, Worker em `src/`, site em `dist/`.

**Pelo painel (deploy automático a cada push):** Cloudflare → Workers & Pages → Create → Import a repository → escolha este repositório. Build command vazio, deploy command `npx wrangler deploy`.

**Pela linha de comando:**

```bash
npx wrangler kv namespace create FILMES   # copie o id para o wrangler.jsonc (kv_namespaces[0].id)
npx wrangler deploy
```

Versões recentes do Wrangler criam o namespace sozinhas no deploy, se o `id` ficar de fora.

Para rodar local: `npx wrangler dev`.

## Por que gasta pouco

- Os arquivos estáticos são servidos pelo Assets e **não executam o Worker**. Só `/api/*` executa (`run_worker_first`).
- Não tem polling. Os dados só são atualizados ao abrir o app, ao voltar para ele (no máximo 1x por minuto) ou no botão ↻.
- As edições são agrupadas: marcar vários filmes seguidos gera **um** salvamento (2 s de espera).
- A busca de filmes sai do navegador direto para o IMDb, sem passar pelo Worker. Se o navegador bloquear, cai para `/api/imdb`, que usa cache de 1 dia na borda.

## KV

| Chave | Conteúdo |
|---|---|
| `g:CODIGO` | nome do grupo + membros (nome, quantidade de filmes) |
| `m:CODIGO:ID` | lista de filmes da pessoa + hash do token dela |

Cada pessoa grava só a própria chave, então uma não sobrescreve a lista da outra. Para editar uma lista é preciso o token salvo no aparelho da pessoa. Para ver, basta o link do grupo.

Custo por ação: abrir o grupo = 1 leitura; ver a lista de alguém = 1 leitura; salvar = 2 leituras + 1–2 gravações.
