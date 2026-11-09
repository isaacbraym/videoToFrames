# Captura Inteligente

Transforma o vídeo que você gravou com o celular apontado para a tela do notebook em um
conjunto pequeno de **capturas nítidas, recortadas e em ordem**. As capturas vão para uma
pasta do **Google Drive**, prontas para o ChatGPT consultar.

**Selecionar vídeo → Processar → Revisar → Enviar ao Drive → Pronto**

- Detecta quando o conteúdo **muda de verdade** (troca de questão, rolagem, alternativa
  marcada, mensagem nova) e ignora tremor, cursor, mão passando e transições.
- Escolhe o **quadro mais nítido** de cada conteúdo, com menos reflexo e com a tela inteira.
- Corrige **perspectiva e inclinação** recortando a tela, com realce conservador de
  contraste e nitidez. Nada é "inventado": só geometria e curvas de tom.
- Marca **capturas repetidas** (por exemplo, quando você volta a uma questão), sem apagar:
  você pode restaurar na revisão.
- Na revisão: ampliar, girar, ver o original, **ajustar os 4 cantos** do recorte, remover e
  **adicionar um quadro** que tenha faltado.
- Envia ao Drive com **nomes ordenados**, **índice com transcrição (OCR)** e um arquivo fixo
  `_ULTIMA_SESSAO.txt` que aponta a sessão mais recente. **Retoma envios interrompidos sem
  duplicar.**
- **Privacidade:** o vídeo nunca sai do aparelho. Só as capturas finais vão para o seu Drive.

Análise técnica completa (viabilidade, decisões, limitações, IA opcional): [docs/ANALISE.md](docs/ANALISE.md).

## Publicar no GitHub Pages
1. Crie um repositório (ex.: `captura-frames`) e envie estes arquivos.
2. **Settings › Pages › Build and deployment**: *Deploy from a branch*, branch `main`, pasta `/ (root)`.
3. O site fica em `https://SEU-USUARIO.github.io/captura-frames/`.
4. Configure o Google Drive: [docs/CONFIGURAR_GOOGLE.md](docs/CONFIGURAR_GOOGLE.md). Preencha
   `js/config.js` e envie de novo.

Sem configurar o Google, o app já funciona até a revisão e permite **Baixar .zip**.

## Usar no ChatGPT
- Peça: *"Abra o `_ULTIMA_SESSAO.txt` na minha pasta de capturas, depois o índice da sessão
  indicada, e responda sobre as questões."* O índice traz o texto (OCR) de cada captura.
- Para ele **ver as imagens**: **+ › Adicionar do Google Drive** › selecione as capturas da sessão.
- Arquivos novos podem levar alguns minutos para aparecer na busca do ChatGPT.

## Dicas de gravação
Enquadre a tela inteira. Pare ~2 s em cada questão ou página. Ao rolar, pare antes de seguir.
Evite reflexos. Grave em 1080p/4K, de preferência a 60 fps.

## Desenvolvimento
Sem build: HTML + módulos JS. Requer Node 20+ só para os testes.

```bash
npm test                      # testes unitários (node:test)
npm run serve                 # http://localhost:8080
npm run gerar-video-teste     # gera tests/fixtures/sintetico.mp4 (Python + OpenCV + ffmpeg)
npm run calibrar              # roda o pipeline em Node sobre o vídeo sintético e compara com o gabarito
```
Modo demonstração: `http://localhost:8080/?demo=tests/fixtures/sintetico.mp4`.

| Arquivo | Papel |
|---|---|
| `js/vision.js` | Medidas de imagem: features, alinhamento, comparação (envelope e NCC por célula), nitidez |
| `js/segmenter.js` | Decide quando o conteúdo mudou; trechos estáveis; A-B-A; ranking |
| `js/pipeline.js` | Orquestra: amostragem → trechos → melhor quadro → retificação → duplicatas |
| `js/imageops.js` | Detecção da tela, homografia, retificação, realce, rotação |
| `js/video-source.js` | Leitura de quadros no navegador (`<video>` + canvas) |
| `js/drive.js`, `js/uploader.js` | OAuth (GIS), Picker, envio retomável e sem duplicação |
| `js/naming.js` | Nomes de arquivos/pastas e textos de índice |
| `js/ocr.js` | Transcrição com Tesseract.js (carregado sob demanda) |
| `js/store.js` | Envios pendentes no aparelho (IndexedDB) |
| `js/app.js` | Interface |
