# Prime Sync

Extensão de navegador que mantém o Prime Video de **duas pessoas em sincronia**:
quando um dá play, pausa, avança ou muda a velocidade, o outro acompanha em
menos de um segundo.

Feita para o caso "mesma conta, duas telas": o Prime Video permite até 3
reproduções simultâneas na mesma conta, mas não tem recurso de "assistir juntos".
Esta extensão cobre essa lacuna.

---

## Como funciona

```
Chrome A ──► service worker A ──┐
                                ├──► broker MQTT público (broker.emqx.io)
Chrome B ──► service worker B ──┘
```

- Cada aba do Prime Video encontra o `<video>` do player e publica um pequeno
  JSON (`posição`, `tocando`, `velocidade`, `título`) num tópico privado.
- O tópico é derivado do **código da sala** (ex.: `K7QX2M`) → `primesync/v1/K7QX2M`.
- O outro navegador recebe, compara com a posição local e, se estiver mais de
  ~0,9s fora, corrige. Play/pause/velocidade são aplicados na hora.
- Sem servidor para hospedar: usa um broker MQTT público via WebSocket (WSS).

### Arquivos

| Arquivo | Papel |
| --- | --- |
| `extension/manifest.json` | Manifesto MV3, sites e permissões |
| `extension/background.js` | Service worker: mantém a conexão MQTT e faz a ponte com as abas |
| `extension/mqtt-lite.js` | Cliente MQTT 3.1.1 mínimo (QoS 0), sem dependências |
| `extension/content.js` | Acha o vídeo, envia estado, aplica o estado remoto e desenha pílula + chat |
| `extension/overlay.css` | Painel flutuante e barra lateral de chat |
| `extension/popup.*` | Configuração: código da sala, ligar/desligar, copiar código |
| `test/mqtt-lite.test.cjs` | Testa a troca de mensagens real contra o broker |
| `tools/make-icons.cjs` | Gera os ícones PNG |

---

## Instalação (nos dois computadores)

1. Copie a pasta `extension/` para a máquina da outra pessoa
   (ou envie `prime-sync-extension.zip` e peça para descompactar).
2. Abra `chrome://extensions` (no Edge: `edge://extensions`, no Brave:
   `brave://extensions`).
3. Ligue **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta `extension`.
5. Fixe o ícone do Prime Sync na barra do navegador (ícone de peça → alfinete).

> A extensão não é publicada na Chrome Web Store, então esse passo manual é
> necessário nas duas máquinas. Depois disso, ela atualiza sozinha quando o
> navegador reinicia.

---

## Uso

1. Cada um abre o Prime Video e o mesmo episódio/filme.
2. Clique no ícone do Prime Sync → **Novo** para gerar um código de sala →
   **Copiar** e mande para a outra pessoa.
3. A outra pessoa cola o código no campo e clica Enter.
4. Dê play. A pílula no canto inferior esquerdo do vídeo deve ficar **verde
   (conectado)**.
5. Se algo sair do ritmo, clique em **Sincronizar** na pílula (ou pausar e dar
   play novamente).

O código da sala pode ser o mesmo para sempre — não expira, é só um nome de
tópico.

### Chat da sala

Ao lado de "Sincronizar", o botão **Chat** abre uma barra lateral com a conversa
das duas pessoas. É só digitar e apertar Enter.

- Funciona no mesmo broker e no mesmo código de sala da sincronização, mas em
  um tópico separado (`primesync/v1/<CÓDIGO>/chat`).
- Seu nome aparece no chat; ajuste em **ícone do Prime Sync → "Seu nome no
  chat"**.
- Com a barra fechada, mensagens novas mostram um aviso no canto e um contador
  no botão **Chat**.
- **Não fica salvo**: o chat existe enquanto a janela dos dois estiver aberta na
  sala. Fechou a aba, a conversa foi embora (o broker público não guarda
  histórico). Por isso não use para nada que precise durar.
- Nada é renderizado como HTML: o texto do parceiro entra como texto puro.
- Dá para **minimizar** no botão `–` (ou clicando no cabeçalho) e
  **redimensionar** arrastando o pegador no topo da barra (duplo clique volta
  ao tamanho padrão; a altura fica salva).
- Para sair da sala: ícone do Prime Sync → **Sair da sala**. O chat é limpo e a
  sincronização para até você usar um código de novo.

### Indicador de conexão

A pílula mostra quem está com problema, não só que existe um problema:

| Na tela | Significado |
| --- | --- |
| `⚠ sua conexão` | **você** está travando (buffer/`waiting`) agora ou nos últimos 8s |
| `⚠ Ana lenta` | o **parceiro** avisou que está travando |
| `⚠ Ana sem sinal` | 25s sem nenhuma mensagem dele (aba suspensa ou internet caída) |

Na primeira vez que o outro começa a travar aparece um aviso no canto. O
`+1.4s` continua sendo outra coisa: é a diferença de posição entre os dois, não
a qualidade da rede.

---

## Limites conhecidos

- **Anúncios**: na faixa com anúncios, o player pode trocar de stream e o tempo
  exibido muda; o sync pode se perder durante o comercial. Dê **Sincronizar**
  depois que o episódio voltar.
- **Autoplay**: se o navegador bloquear o `play()` automático, a pílula avisa
  "Clique no player uma vez". Um clique resolve para o resto da sessão.
- **Drift de rede**: tolerância de ~0,6s tocando e ~0,4s pausado. Acima disso a
  extensão corrige sozinha. O tempo de rede entre vocês aparece como `+0.3s` na
  pílula quando passa de 1,2s.
- **Como a correção é feita**: diferenças pequenas são compensadas mudando a
  velocidade em até 8% por alguns segundos (imperceptível, sem rebufferizar);
  só diferenças acima de 1,6s viram seek. Depois de um seek há uma pausa de 4s
  e, se o player local estiver carregando, nenhuma correção é aplicada — é isso
  que evita o "puxa-empurra" quando a internet de um dos dois está ruim.
  ⚠️ **Privacidade**: o broker é público. Quem souber o código da sala consegue
  publicar comandos de play/pause e ler o chat. Use códigos longos/aleatórios
  (o botão **Novo** gera 6 caracteres de um alfabeto de 32 = ~1 bilhão de
  combinações) e não compartilhe o código fora da conversa de vocês. Nenhum dado
  de conta, e-mail ou senha passa pela extensão — só posição do vídeo, título do
  episódio e as mensagens do chat.
- **Regiões**: o Prime Video em `primevideo.com` e nas páginas
  `amazon.*/gp/video/*` (BR, US, UK, DE, ES, MX) estão cobertos. Outra região?
  Adicione o padrão em `manifest.json` (em `content_scripts.matches`).

---

## Desenvolvimento

```bash
# testar o cliente MQTT contra o broker real (precisa de internet)
node test/mqtt-lite.test.cjs

# usar o broker alternativo
BROKER=wss://broker.hivemq.com:8884/mqtt node test/mqtt-lite.test.cjs

# regerar ícones
node tools/make-icons.cjs

# monitorar a sala pelo terminal (teste sem segundo navegador)
node tools/room.cjs SEUCODIGO
node tools/room.cjs SEUCODIGO --say "oi"
node tools/room.cjs SEUCODIGO --pause 90
```

Depois de editar arquivos, vá em `chrome://extensions` e clique no **⟳** do
cartão do Prime Sync (e recarregue a aba do Prime Video).

### Broker próprio (opcional)

O app funciona com qualquer broker MQTT 3.1.1 acessível por WebSocket. Para
mais privacidade, troque a lista `BROKERS` em `extension/background.js` por um
broker seu (Mosquitto com `listener 8083` + `protocol websockets`, ou EMQX
Cloud free tier). Basta uma URL `wss://.../mqtt`.
