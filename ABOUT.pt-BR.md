# Sobre este projeto

Um kit de operações remotas para agentes de IA (Claude Code), construído e testado
em produção num Mac Mini. Duas peças independentes, unidas por uma mesma filosofia:
**dar mãos ao agente sem entregar as chaves.**

## 1. `ssh-mcp-server/` — SSH com guarda-corpos para agentes

Um servidor MCP (Model Context Protocol) que permite a um agente de IA executar
comandos e transferir arquivos em máquinas remotas via SSH — com quatro ferramentas
(`ssh_execute`, `ssh_upload`, `ssh_download`, `ssh_list_connections`) e um modelo de
segurança estrutural:

- **As credenciais nunca chegam ao modelo.** Host, usuário e chave privada ficam num
  arquivo de configuração na máquina que roda o servidor (`chmod 600`, fora de
  qualquer repositório git). O agente só conhece o *nome* da conexão.
- **Todo comando é filtrado antes de conectar.** Duas listas de expressões regulares:
  `deny` (sempre vence — `rm -rf`, `shutdown`, `mkfs`, desligar firewall ou SSH) e
  `allow` (se existir, o comando precisa corresponder a pelo menos uma entrada).
- **Perfis explícitos:** `readonly` (status, logs, disco, uptime — diagnóstico sem
  efeitos colaterais) ou `ops` (verbos de deploy/restart). Você escolhe o raio de
  ação na instalação, não no calor da sessão.
- **Por que não dar um terminal com `ssh` direto?** Porque aí a política vira
  esperança. Aqui a lista de bloqueio é aplicada por um processo que o agente não
  pode modificar, e o padrão somente-leitura significa que uma sessão confusa (ou
  comprometida) pode olhar logs, mas não pode mudar estado.

Instalação: `npm install && npm run build`, depois `bash setup-vps.sh <alias-ssh>`
— o script resolve os detalhes da conexão a partir do seu `~/.ssh/config`.

## 2. `grok/` — Claude Code rodando sobre a Grok (xAI)

A API da xAI fala o formato de mensagens da Anthropic, então em teoria dá para
apontar o Claude Code para ela. Na prática, a sessão morre na hora com um erro
enganoso (`Model not found: claude-sonnet-4-6`) — que não tem nada a ver com a causa
real. O validador da xAI é mais rígido que o da Anthropic e rejeita três coisas que
o Claude Code envia rotineiramente:

1. Ferramentas cujo `input_schema` não tem o campo `required`;
2. Mensagens com `role: "system"` dentro do array `messages`;
3. Blocos `tool_reference` (proprietários da Anthropic) nos resultados de ferramenta.

O `grok-proxy.mjs` (~130 linhas de Node, zero dependências, só localhost) conserta
os três em cada requisição e repassa para `api.x.ai` — streaming, prompt caching e
autenticação passam intactos. O launcher `grok` sobe o proxy, mapeia os tiers de
modelo (`grok-4.20-reasoning` para trabalho pesado, `-non-reasoning` para chamadas
rápidas) e abre uma sessão Claude Code completa com a Grok por trás.

Lição geral documentada em `docs/claude-code-on-grok.md`: quando um backend
não-Anthropic falhar sob o Claude Code, desconfie da *forma* da requisição e da
cadeia de fallback antes de acreditar no nome do modelo no erro.

## Segurança

Nenhuma chave, credencial ou configuração real está neste repositório — apenas
exemplos. Nomes de host e IPs nos documentos foram substituídos por placeholders.

## Licença

MIT — use, modifique e distribua à vontade.
