# Configurar o Google Drive (uma vez, ~10 minutos)

Você vai criar, no Google Cloud, um "app" só seu que pode gravar no seu Drive. É gratuito.
Nos exemplos, o site publicado é `https://isaacbraym.github.io/captura-frames/`. Troque pelo
seu endereço real.

## 1. Projeto e APIs
1. Acesse <https://console.cloud.google.com/> e crie um projeto (ex.: `captura-frames`).
2. Em **APIs e serviços › Biblioteca**, ative:
   - **Google Drive API**
   - **Google Picker API** (para escolher a pasta pelo seletor; recomendado)

## 2. Tela de consentimento OAuth
1. **APIs e serviços › Tela de consentimento OAuth** (ou "Google Auth Platform › Branding").
2. Tipo de usuário: **Externo**. Nome do app: `Captura Inteligente`. Coloque seu e-mail
   como suporte e contato.
3. Em **Acesso a dados / Escopos**, adicione só `.../auth/drive.file`. É um escopo não
   sensível: não precisa de verificação do Google.
4. Em **Público / Usuários de teste**, adicione o seu e-mail. Enquanto o app estiver em
   "Teste", só os e-mails listados conseguem entrar, o que é ótimo para uso pessoal.

## 3. ID do cliente OAuth (obrigatório)
1. **APIs e serviços › Credenciais › Criar credenciais › ID do cliente OAuth**.
2. Tipo: **Aplicativo da Web**.
3. **Origens JavaScript autorizadas**:
   - `https://isaacbraym.github.io` (só o domínio, sem `/captura-frames`)
   - `http://localhost:8080` (opcional, para testar no computador)
4. Não é preciso "URI de redirecionamento".
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`).

## 4. Chave de API para o seletor de pasta (recomendado)
1. **Credenciais › Criar credenciais › Chave de API**.
2. Edite a chave:
   - **Restrições de aplicativo › Sites**: `https://isaacbraym.github.io/*` **e**
     `https://docs.google.com/*` (o seletor exige os dois).
   - **Restrições de API**: só **Google Picker API**.
3. Copie a chave. Pegue também o **número do projeto** (Painel do projeto › "Número do projeto").

## 5. Preencher `js/config.js`
```js
export const CONFIG = {
  GOOGLE_CLIENT_ID: '1234567890-abc...apps.googleusercontent.com',
  GOOGLE_API_KEY: 'AIza...',      // opcional (seletor de pasta)
  GOOGLE_APP_ID: '1234567890',    // número do projeto (seletor de pasta)
  DEFAULT_FOLDER_NAME: 'Capturas de Vídeo',
};
```
Esses três valores **podem** ficar no repositório público: são identificadores, não segredos.
A segurança vem das restrições dos passos 3 e 4. Nunca coloque aqui um "client secret" nem
chave de IA.

## 6. Escolher a pasta de destino
Na etapa **Enviar** do app:
- **Escolher no Drive**: abre o seletor do Google. Escolha a sua pasta (ex.: a que você já
  criou). O app ganha acesso **só a ela**. A autorização fica gravada na sua conta Google,
  então em outro aparelho basta **Colar link da pasta**.
- **Pasta automática**: o app cria `Capturas de Vídeo` no seu Drive. Funciona sem a chave
  de API. Você pode mover essa pasta para onde quiser depois, e o app continua com acesso.

> **Sobre a pasta com "qualquer pessoa com o link pode editar":** desative isso (deixe
> **Restrito**). O app grava pela sua conta e o ChatGPT lê pela sua conta. O link público só
> permite que estranhos apaguem ou alterem suas capturas.

## Problemas comuns
| Mensagem | Causa / solução |
|---|---|
| `redirect_uri_mismatch` / `origin_mismatch` | A origem do passo 3 não bate com o endereço do site (confira https, sem barra no fim). |
| "Acesso bloqueado: o app não concluiu a verificação" | Seu e-mail não está em **Usuários de teste** (passo 2.4). |
| "O app ainda não tem acesso a essa pasta" | Com `drive.file`, a pasta precisa ser escolhida uma vez pelo seletor (ou ter sido criada pelo app). |
| Seletor abre em branco ou dá erro 403 | Restrições da chave de API: falta `https://docs.google.com/*` ou a Picker API. |
| Janela de login não abre | Bloqueador de pop-up: permita pop-ups para o site. |
