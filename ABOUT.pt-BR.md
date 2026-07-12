# Sobre este projeto

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

## Segurança e licença

Nenhuma chave, credencial ou config real está aqui — apenas exemplos, com hosts e
IPs substituídos por placeholders. Licença MIT: use, modifique, distribua.
