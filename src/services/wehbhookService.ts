/// <reference types="node" />
import axios from 'axios';

export interface DadosWebhookEnsaio {
  id: number;
  empresa_nome: string;
  email_cliente: string;
  contato_nome: string;
  contato_telefone: string;
  data_ensaio: string;
  hora_inicio: string;
  hora_fim: string;
  objetivos: string;
  evento?: string;             
  status?: string;             
  motivo_cancelamento?: string; 
  link_cancelamento?: string; // 👈 Adicionado aqui na interface global
  fotografo_responsavel?: string;
  roteirista_responsavel?: string;
  auxiliar_responsavel?: string;
}

export async function enviarParaN8n(dados: DadosWebhookEnsaio) {
  const eventoStr = String(dados.evento || '').toUpperCase();
  const statusStr = String(dados.status || '').toUpperCase();

  let url = process.env.N8N_WHATSAPP_WEBHOOK_URL;

  // 1. Identifica se é cancelamento e joga para o webhook certo
  if (eventoStr.includes('CANCEL') || statusStr.includes('CANCEL')) {
    url = 'https://n8n-new.arsenalestrategia.com.br/webhook/cancel-agend';
  }

  if (!url) {
    console.log(`⚠️ [Webhook n8n] Erro: URL não definida.`);
    return;
  }

  try {
    const eventoFinal = dados.evento || (statusStr.includes('CANCEL') ? 'ENSAIO_CANCELADO' : 'ensaio.agendado');
    
    // 2. Tratamento da data corrigido para o TypeScript aceitar sem reclamar
    let dataPura = '';
    let dataFormatadaBR = '';
    
    if (dados.data_ensaio) {
      const dataRaw = dados.data_ensaio as any; // Ignora o check estrito do TS aqui
      
      // Se for um objeto Date real, usa toISOString, se não, trata como string pura
      dataPura = typeof dataRaw.toISOString === 'function'
        ? dataRaw.toISOString().split('T')[0] 
        : String(dataRaw).split('T')[0];
      
      const [ano, mes, dia] = dataPura.split('-');
      dataFormatadaBR = `${dia}/${mes}/${ano}`; // Mantém o formato padrão BR pro seu n8n
    }

    // 3. Garante que o horário vai com segundos para o Google Calendar
    const inicioComSegundos = dados.hora_inicio?.length === 5 ? `${dados.hora_inicio}:00` : dados.hora_inicio;
    const fimComSegundos = dados.hora_fim?.length === 5 ? `${dados.hora_fim}:00` : dados.hora_fim;

    await axios.post(url, {
      ...dados,
      evento: eventoFinal,
      data_formatada: dataFormatadaBR,
      hora_inicio_curta: dados.hora_inicio ? dados.hora_inicio.substring(0, 5) : '',
      hora_fim_curta: dados.hora_fim ? dados.hora_fim.substring(0, 5) : '',
      // Envia as datas blindadas contra o fuso horário da Render
      calendar_start: dataPura && dados.hora_inicio ? `${dataPura}T${inicioComSegundos}-03:00` : '',
      calendar_end: dataPura && dados.hora_fim ? `${dataPura}T${fimComSegundos}-03:00` : ''
    });

    console.log(`✅ [Webhook n8n] Enviado com sucesso para: ${url}`);
  } catch (error: any) {
    console.error('❌ [Webhook n8n] Erro de conexão:', error.message || error);
  }
}