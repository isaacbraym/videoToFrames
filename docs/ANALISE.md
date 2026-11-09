# Análise de viabilidade e arquitetura

**Resumo:** é viável, de graça, no GitHub Pages. Todo o processamento roda no navegador.
O Google Drive é acessado por OAuth com o escopo mínimo (`drive.file`). Não precisa de
servidor nem de API paga para a primeira versão. O ponto que exigiu mudança de plano foi
o ChatGPT: o conector do Drive lê **texto** com muito mais confiabilidade do que imagens soltas.
Por isso a página também grava um índice com a transcrição (OCR) de cada captura.

---

## 1. O GitHub Pages atende?

| Requisito | Atende? | Observação |
|---|---|---|
| HTTPS (obrigatório para OAuth) | Sim | `https://usuario.github.io/repo/` |
| Página estática, sem servidor | Sim | HTML + JS em módulos, sem etapa de build |
| Processar vídeo no navegador | Sim | Decodificação nativa do navegador (hardware) via `<video>` + canvas |
| Guardar segredo (chave de API de IA) | **Não** | Tudo no Pages é público. Para usar IA paga, só com um proxy (ver §6) |
| Cabeçalhos COOP/COEP (para WASM multithread) | **Não** | Por isso evitei FFmpeg.wasm multithread; não faz falta |

Credenciais do Google: o **Client ID** de OAuth e a **chave de API do Picker** são
identificadores públicos por natureza. A proteção vem das restrições configuradas no Google
Cloud: origem autorizada e chave restrita por site e por API. **Não existe "client secret"**
no fluxo usado (modelo de token do Google Identity Services).

## 2. Tecnologias avaliadas

| Opção | Veredito | Motivo |
|---|---|---|
| `<video>` + canvas (decodificação nativa) | **Escolhida** | Usa o decodificador de hardware; não baixa nada; lê o arquivo do disco sob demanda (não estoura memória) |
| FFmpeg.wasm | Descartada | ~30 MB de download; single-thread é lento demais no celular; multithread exige COOP/COEP (o Pages não permite) e quebraria o popup do login Google |
| OpenCV.js | Descartada na v1 | 10,4 MB para usar 3 ou 4 funções. Detecção de tela, homografia e realce foram escritos em JS puro (~600 linhas, testados) |
| WebCodecs + mp4box.js | Melhoria futura | Mais rápido que buscar quadro a quadro, mas com suporte desigual (iOS) e mais código |
| Tesseract.js (OCR) | **Escolhida, opcional** | Carregado só no envio (~3,4 MB); roda local; gera o texto que o ChatGPT consegue ler pelo conector |

## 3. Como diferenciar mudança relevante de irrelevante

O problema real: filmando a tela com o celular, **tudo** se mexe o tempo todo (tremor,
foco, exposição automática, cursor, reflexo). E duas questões diferentes com o **mesmo
layout** são quase idênticas em baixa resolução: as linhas de texto ficam nas mesmas
posições e só mudam as palavras. Medi isso: em 320 px, a diferença entre a "Questão 8" e a
"Questão 9" foi de 0,8%, igual ao ruído de duas imagens da mesma questão.

A solução tem duas escalas:

1. **Movimento (320 px, a cada amostra):** compara cada amostra com a anterior depois de
   alinhar o tremor (translação) e compensar a exposição, com tolerância de 1 px
   ("envelope" mín/máx). Diz se a imagem está **parada**.
2. **Conteúdo (1280 px, só em amostras paradas):** divide a imagem numa grade 8×6. Em cada
   célula, procura o melhor deslocamento local, o que absorve rotação e zoom da mão. Depois
   mede duas coisas:
   - **correlação normalizada (NCC)**, que ignora brilho e contraste: pega troca de texto;
   - **área alterada**: fração de pixels fora do envelope 3×3. Separa o cursor (<1% da
     célula) de uma alternativa destacada ou de uma mensagem nova (≥10%).

**Regra de decisão:** um novo trecho começa quando 2 ou mais células mudaram (ou 1 célula
mudou muito) **e** o novo estado ficou parado por 2 amostras seguidas. Mão passando,
cursor, tranco da câmera e transições não viram captura. No fim:
- trechos com menos de 0,6 s parados são descartados;
- **A-B-A** (B curto entre dois estados iguais) é colapsado: obstrução passageira;
- trechos vizinhos iguais são unidos;
- depois da correção de perspectiva, capturas com o mesmo conteúdo (por exemplo, voltar a
  uma questão) são marcadas como **repetidas**, e não apagadas: dá para restaurar na revisão.

### Escolha do melhor quadro
Em cada trecho: maior nitidez (variância do Laplaciano em 1280 px) com penalidade para
reflexo (pixels estourados acima do mínimo do trecho). Em volta do melhor instante, o app
examina ~12 quadros vizinhos (15/s) e escolhe o mais nítido em que a tela inteira aparece.

### Resultado medido (vídeo sintético de 91 s, `tools/gerar_video_teste.py`)
Simula perspectiva, tremor, borrão de movimento, ruído, exposição variando, cursor, mão
passando, tranco na câmera, reflexo em movimento, rolagem e alternativa marcada.

- **13 de 13 trechos corretos, tanto em Node quanto no navegador (Chromium):** exatamente
  12 capturas mantidas, uma por questão ou estado. A alternativa marcada e as duas partes da
  página rolada viraram capturas próprias. Mão passando, tranco e reflexo não geraram extras,
  e a volta à Q3 foi marcada como repetida.
- Margem medida: pares da mesma questão ficam em "diferença global" ≤ 0,09; questões
  diferentes com o mesmo layout ficam em ≥ 0,27.
- OCR (Tesseract, português) numa captura: ~3 s, texto fiel, inclusive acentos.

**Limitações conhecidas:**
- Mudança só de um "pontinho" (rádio marcado sem destaque na linha) pode passar na
  sensibilidade Normal. A Alta pega mais, ao custo de mais capturas. "Adicionar quadro"
  cobre qualquer falso negativo.
- Tela com fundo escuro (modo noturno) dificulta a detecção automática dos cantos. A
  captura sai sem correção de perspectiva, e você ajusta os 4 cantos na revisão.
- O vídeo sintético não reproduz moiré real nem foco automático "caçando". Os limiares
  devem ser conferidos com os primeiros vídeos reais (a linha do tempo na revisão mostra
  por que cada captura foi feita).

## 4. Vídeos longos e memória

- O arquivo não é lido para a memória: o navegador lê do disco conforme busca os quadros.
- Só ficam na memória a amostra atual, a anterior e uma referência por trecho (~1 MB cada).
- Amostragem de 4/s até 5 min de vídeo; acima disso, limitada a ~1200 amostras (mínimo de 1,5/s).
- Cada captura final vira JPEG na hora (0,3 a 1,5 MB).
- **Leitura dos quadros por reprodução acelerada (2×, sem som)** em vez de posicionar o vídeo
  a cada amostra. Cada posicionamento redecodifica desde o quadro-chave anterior; isso
  deixava a análise ~3× mais lenta. Se o navegador parar de entregar quadros (aba em
  segundo plano), o app continua automaticamente por posicionamento.
- Tempo medido no navegador do PC: ~2 min para 91 s de vídeo (análise ~55 s; escolha do
  melhor quadro e correção ~60 s). No celular, conte 2 a 3 vezes isso. Mantenha a tela
  ligada (o app pede para não apagar a tela quando o navegador permite).

## 5. Google Drive com segurança

- **OAuth 2.0** com Google Identity Services (modelo de token, sem client secret).
- Escopo **`drive.file`**: o app só enxerga o que ele criou ou o que você escolher no
  seletor do Google. É um escopo "não sensível" e não exige verificação do Google.
- O token fica só na memória da página (expira em ~1 h). Nada é salvo em servidor.
- **Organização:** `Pasta escolhida/2026-11-08_14h32_nome-do-video/` com
  `…_000_indice.txt` e `…_cap001_00m12s.jpg`, `…_cap002_…`. Na pasta escolhida fica
  `_ULTIMA_SESSAO.txt`, que aponta a sessão mais recente e guarda o histórico.
- **Sem duplicar:** cada arquivo leva `appProperties` com o ID da sessão e da captura. Se o
  envio cair, "Tentar novamente" pergunta ao Drive o que já subiu e continua dali. O estado
  fica salvo no aparelho (IndexedDB), e dá para retomar mesmo depois de fechar a aba.

### Sobre a pasta compartilhada "qualquer pessoa com o link pode editar"
Não é necessária e é um risco: quem tiver o link pode apagar ou trocar arquivos. Sem login,
o Drive não aceita gravação de forma nenhuma, e o ChatGPT acessa pela **sua** conta, não pelo
link público. **Recomendação:** volte a pasta para "Restrito". O ID dela não está no código
público. Você escolhe a pasta uma vez pelo seletor do Google, ou cola o link depois que ela
já foi autorizada.

## 6. ChatGPT: o que esperar de verdade

Fontes: OpenAI Help Center (arquivos de apps conectados; recuperação visual em PDFs).

- O conector do Google Drive é confiável com **documentos de texto**. Para imagens soltas
  numa pasta, não há garantia de que a busca do ChatGPT as abra e "veja" por conta própria.
- **PDF só com imagens não resolve:** fora do plano Enterprise, o ChatGPT extrai o texto do
  PDF e ignora as imagens dentro dele.
- Arquivos recém-enviados podem levar alguns minutos para aparecer na busca do conector.
- Imagens enviadas como anexo: limite de 20 MB cada. As capturas ficam bem abaixo disso.

**Desenho resultante:**
1. `_ULTIMA_SESSAO.txt` (nome fixo) diz qual é a sessão nova. Responde ao seu fluxo
   "vê aí que teve vídeo novo".
2. O índice da sessão traz a **transcrição OCR** de cada captura, com aviso de que pode ter
   erros e de que a imagem é a fonte fiel.
3. Para o ChatGPT **ver** as imagens: "+" › "Adicionar do Google Drive" › selecionar as
   capturas da pasta da sessão. Esse caminho é garantido.

Teste recomendado logo após publicar: envie uma sessão curta e peça ao ChatGPT para ler o
`_ULTIMA_SESSAO.txt`. A disponibilidade do conector depende de plano e configuração da conta.

## 7. IA externa: três caminhos comparados

| | 1. Só local (v1) | 2. Híbrido | 3. Serviço externo |
|---|---|---|---|
| Como | O que está implementado | Local seleciona; IA só confere casos duvidosos (ex.: "estas 2 capturas são a mesma questão?") ou lê as finais | Envia o vídeo/quadros para um modelo multimodal |
| Precisão | Boa para troca de página/rolagem/destaque; fraca para reflexo forte e mudanças minúsculas | Melhor deduplicação semântica e checagem de legibilidade | Potencialmente a melhor semântica, mas sem garantia de fidelidade de quadro |
| Custo | Zero | Centavos por vídeo (miniaturas pequenas, poucas chamadas) | Maior: vídeo inteiro vira muitos tokens |
| Privacidade | Nada sai do aparelho além do que vai ao Drive | Miniaturas saem para o provedor | Vídeo inteiro sai |
| Complexidade | Baixa | Média: exige um proxy (ex.: Cloudflare Worker, plano gratuito) para esconder a chave | Média/alta |

**Recomendação:** começar no caminho 1, que está pronto. Se na prática aparecerem muitas
capturas repetidas por reflexo, ou faltar alguma questão, o caminho 2 é o próximo passo. A
estrutura já permite: o `pipeline.js` devolve trechos e candidatos, e um "juiz" opcional entra
depois do `markDuplicates`. **A chave da IA nunca pode ir no GitHub Pages:** só num proxy
com a chave em variável de ambiente.

## 8. Existe arquitetura melhor?

- **Captura ao vivo no celular** (página aberta apontando para a tela, fotos de alta
  resolução tiradas automaticamente quando o conteúdo estabiliza). Foto de 12 MP é bem mais
  nítida que um quadro de vídeo. É a melhor evolução de qualidade, mas muda o fluxo
  (exige a página aberta durante a gravação).
- **Print direto no notebook** dá sempre a melhor qualidade, se o computador permitir.
- **Compartilhar direto da galeria para o app** (Web Share Target, Android): exige PWA
  instalado. Melhoria futura.
