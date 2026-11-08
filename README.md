# Já Vi 🎬

App para um grupo marcar os filmes que já assistiu e ver a lista de cada pessoa.

- Quem cria o grupo recebe um link (`/g/CODIGO`). Quem tiver o link entra, informa o nome no primeiro acesso e marca os filmes.
- Na aba **Pessoas**, ao clicar no nome de alguém, você vê os filmes dessa pessoa, quantos vocês têm em comum e pode marcar com **+ Também vi**.
- A base de filmes vem das plataformas **Netflix**, **Disney+**, **Prime Video**, **Globoplay** e **Apple TV** (catálogos do **Brasil** e da **Irlanda**). Dá para navegar pelos populares de cada plataforma ou buscar pelo nome.
- Cada filme mostra, na frente do título, em qual plataforma e em qual país está disponível (ex.: `Netflix BR IE`, `Prime Video IE`). Dá para filtrar por país: Brasil, Irlanda ou os dois. Isso também aparece na sua lista e na lista das outras pessoas.
- Filmes que não estão em nenhuma delas aparecem separados, em "Não está nas plataformas agora", e também podem ser marcados.
- Em **Ajustes** (⚙️) tem o *link pessoal*, que serve para usar a mesma lista em outro aparelho.

## Base de filmes (TMDB + JustWatch)

Essas plataformas não têm API pública. Os catálogos e a disponibilidade vêm do **TMDB** (gratuito), que usa os dados do **JustWatch** para dizer onde cada filme está no Brasil e na Irlanda.

1. Crie uma conta em https://www.themoviedb.org/signup
2. Em https://www.themoviedb.org/settings/api, peça uma chave de API (uso pessoal) e copie o **API Read Access Token** (o token longo).
3. No Cloudflare: Workers & Pages → `ja-vi` → Settings → Variables and Secrets → Add → tipo **Secret**, nome `TMDB_TOKEN`, valor = o token.
   (ou pela linha de comando: `npx wrangler secret put TMDB_TOKEN`)

Os países ficam em `REGIONS` no `wrangler.jsonc` (padrão `BR,IE`). Para adicionar outro país, inclua o código dele ali e em `REGIONS` no `dist/index.html`.

A disponibilidade é salva no momento em que o filme é marcado. Se o filme sair da plataforma depois, a etiqueta antiga continua aparecendo.

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
- Buscas e páginas de catálogo ficam em cache por 12 h (no navegador e na borda da Cloudflare). A mesma busca feita por várias pessoas só consulta o TMDB uma vez.

## KV

| Chave | Conteúdo |
|---|---|
| `g:CODIGO` | nome do grupo + membros (nome, quantidade de filmes) |
| `m:CODIGO:ID` | lista de filmes da pessoa + hash do token dela |

Cada pessoa grava só a própria chave, então uma não sobrescreve a lista da outra. Para editar uma lista é preciso o token salvo no aparelho da pessoa. Para ver, basta o link do grupo.

Custo por ação: abrir o grupo = 1 leitura; ver a lista de alguém = 1 leitura; salvar = 2 leituras + 1–2 gravações.
