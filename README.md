# Claude Code remote-ops

🇬🇧 [Read in English: ABOUT.en.md](ABOUT.en.md)

Todo mundo quer que o agente de IA *faça* coisas — deploy, diagnóstico, operação de
servidores. Quase ninguém quer descobrir da pior forma o que acontece quando um
agente confuso roda `rm -rf` como root. Este repositório é a nossa resposta para
esse dilema, extraída de um harness real que opera em produção todos os dias, num
Mac Mini que controla VPSs, pipelines de deploy e sessões remotas iniciadas do
celular.

A filosofia inteira cabe numa frase: **dê mãos ao agente, nunca as chaves.**

## As duas peças

### `ssh-mcp-server/` — mãos remotas com guarda-corpos

Um servidor MCP (Model Context Protocol) em TypeScript que dá a qualquer agente
compatível quatro ferramentas SSH: executar comando, subir arquivo, baixar arquivo,
listar conexões. A parte importante não são as ferramentas — é o que o agente **não**
consegue fazer:

- **Não vê credenciais.** Host, usuário e chave privada moram num arquivo de config
  na máquina que roda o servidor (`chmod 600`, fora de qualquer repo git). O agente
  só conhece o apelido da conexão. Não há o que vazar numa transcrição.
- **Não executa o que a política proíbe.** Cada comando passa por duas listas de
  regex antes de qualquer conexão: `deny` sempre vence (`rm -rf`, `shutdown`,
  `mkfs`, desligar firewall ou o próprio SSH) e `allow`, quando existe, exige
  correspondência. O padrão gerado pelo setup é **somente leitura**: status, logs,
  disco, uptime. Uma sessão confusa consegue diagnosticar; não consegue destruir.
- **Não decide o próprio raio de ação.** Ampliar de `readonly` para `ops`
  (deploy/restart) é uma regeneração deliberada da config, feita por um humano —
  não algo que o modelo possa se convencer a fazer no meio de uma tarefa.

Por que não simplesmente dar um terminal com `ssh`? Porque aí a política vira
esperança. Aqui ela é estrutural: aplicada por um processo que o agente não pode
editar.

### `grok/` — Claude Code rodando sobre a Grok (xAI)

A API da xAI fala o formato Anthropic, então "deveria" ser só apontar o Claude Code
para ela. Na prática a sessão morre na hora com um erro que aponta para o lugar
errado (`Model not found: claude-sonnet-4-6`). A causa real: o validador da xAI é
mais rígido que o da Anthropic e rejeita três coisas que o Claude Code envia o tempo
todo —

1. schemas de ferramenta sem o campo `required`;
2. mensagens com `role: "system"` dentro do array `messages`;
3. blocos `tool_reference` (proprietários da Anthropic) em resultados de ferramenta.

O erro enganoso vem da cadeia de fallback do CLI, que mascara a rejeição original.
Levamos uma tarde de depuração para chegar nisso; o writeup completo está em
`docs/claude-code-on-grok.md` para que você não precise repetir o processo.

O `grok-proxy.mjs` (~130 linhas de Node, zero dependências, só localhost) conserta
os três problemas em cada requisição e repassa para `api.x.ai` — streaming, prompt
caching e autenticação passam intactos. O launcher `grok` sobe o proxy, mapeia os
tiers de modelo e abre uma sessão Claude Code completa — skills, hooks, MCP servers
— com a Grok respondendo. Quando algo novo quebrar, o proxy registra o erro e a
*forma* da requisição (roles, modelos, tipos de bloco — nunca o texto do prompt),
transformando o próximo mistério num diagnóstico de uma rodada.

## Como instalar e utilizar

Pré-requisitos: Node 18+, [Claude Code](https://claude.com/claude-code) instalado, e —
para o ssh-mcp — um host já configurado no seu `~/.ssh/config` (teste antes:
`ssh <alias> uptime` tem que funcionar sem senha).

### ssh-mcp-server (agente com mãos SSH)

```bash
git clone https://github.com/escotilha/claude-code-remote-ops.git
cd claude-code-remote-ops/ssh-mcp-server
npm install && npm run build

# gera a config (perfil somente-leitura) a partir do seu alias SSH
bash setup-vps.sh <alias-do-seu-host>

# registre no Claude Code com a linha exata que o script imprime, no formato:
claude mcp add -s user --transport stdio ssh-mcp -- \
  node "$PWD/dist/index.js" --config "$HOME/.config/ssh-mcp/<alias>.json"
```

Abra uma sessão **nova** do Claude Code e peça: *"rode uptime no `<alias>` via
ssh_execute"*. Se voltar a linha de load average, está pronto. Para liberar
deploy/restart depois: `bash setup-vps.sh <alias> ops`.

### grok (Claude Code rodando na xAI)

```bash
cd claude-code-remote-ops/grok

# guarde sua chave xAI (macOS/Keychain — cola a chave quando pedir):
security add-generic-password -U -s "xai-api-key" -a "$USER" -w
# (Linux: salve a chave em ~/.config/xai/key com chmod 600 e troque a linha KEY= do launcher)

# coloque os dois arquivos no PATH e teste:
chmod +x grok && cp grok grok-proxy.mjs ~/bin/
grok -p "Responda exatamente: ok"
```

Voltou "ok"? Então `grok` (sem argumentos) abre uma sessão interativa completa —
suas skills, hooks e MCP servers — com a Grok respondendo.

## O que este repositório não é

Não é um framework. Não tem 300 ferramentas, não instala daemon, não pede npx na
sua máquina. São duas peças pequenas, legíveis em uma sentada, que você pode
auditar linha por linha antes de confiar — que é exatamente o critério que usamos
para o código que roda com acesso root perto de produção.

## Sobre o autor

Construído por **Pierre Schurmann** ([@escotilha](https://github.com/escotilha)),
empreendedor brasileiro de tecnologia. Este repositório é um recorte público do
harness de agentes que ele opera no dia a dia — a parte que dava para compartilhar
sem compartilhar as chaves.

## Conteúdo do repositório

- `ssh-mcp-server/` — código completo do servidor (TypeScript). `npm install &&
  npm run build`, depois `bash setup-vps.sh <alias-ssh>` conecta a um host do seu
  `~/.ssh/config`.
- `grok/grok-proxy.mjs` + `grok/grok` — proxy e launcher para Claude Code sobre Grok.
- `docs/` — os dois writeups completos (modelo de segurança do ssh-mcp; a
  depuração do Claude Code na xAI).

## Segurança e licença

Nenhuma chave, credencial ou config real está aqui — apenas exemplos, com hosts e
IPs substituídos por placeholders. Licença MIT: use, modifique, distribua.
