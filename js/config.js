// config.js — identificadores públicos do Google Cloud.
//
// Nada aqui é segredo: o Client ID de OAuth e a chave de API do Picker são
// feitos para ficar no navegador. A proteção vem das restrições configuradas
// no Google Cloud (origens autorizadas e restrição de referenciador da chave).
// NUNCA coloque aqui um "client secret", token de acesso ou chave de API de IA.
//
// Passo a passo para obter os valores: docs/CONFIGURAR_GOOGLE.md

export const CONFIG = {
  // OAuth 2.0 → "ID do cliente" do tipo "Aplicativo da Web"
  GOOGLE_CLIENT_ID: '',

  // Opcional (recomendado): permite escolher a pasta pelo seletor do Google Drive.
  // Chave de API restrita a "Google Picker API" e aos sites https://SEU-USUARIO.github.io/* e https://docs.google.com/*
  GOOGLE_API_KEY: '',
  // Número do projeto no Google Cloud (Painel → "Número do projeto")
  GOOGLE_APP_ID: '',

  // Nome da pasta criada automaticamente se você não escolher uma
  DEFAULT_FOLDER_NAME: 'Capturas de Vídeo',
};
