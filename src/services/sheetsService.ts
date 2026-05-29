import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

// Configurar autenticação com o Google (Formato corrigido em objeto)
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

export async function adicionarEnsaioNaPlanilha(ensaio: any) {
  try {
    if (!spreadsheetId) return console.log('⚠️ Spreadsheet ID não configurado.');

    const valores = [
      [
        ensaio.id,
        ensaio.empresa_nome,
        ensaio.email_cliente,
        ensaio.contato_nome,
        ensaio.contato_telefone,
        ensaio.data_ensaio,
        ensaio.hora_inicio,
        ensaio.hora_fim,
        ensaio.objetivos,
        ensaio.status,
        new Date().toLocaleString('pt-BR')
      ]
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Página1!A:K', 
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: valores },
    });

    console.log(`📊 Planilha Google Sheets atualizada para o ensaio ID: ${ensaio.id}`);
  } catch (error) {
    console.error('❌ Erro ao inserir dados no Google Sheets:', error);
  }
}