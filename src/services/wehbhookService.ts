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

  if (eventoStr.includes('CANCEL') || statusStr.includes('CANCEL')) {
    url = 'https://n8n-new.arsenalestrategia.com.br/webhook/cancel-agend';
  }

  if (!url) {
    console.log(`⚠️ [Webhook n8n] Erro: URL não definida.`);
    return;
  }

  try {
    const eventoFinal = dados.evento || (statusStr.includes('CANCEL') ? 'ENSAIO_CANCELADO' : 'ensaio.agendado');
    
  await axios.post(url, {
    ...dados,
    evento: eventoFinal,
    data_formatada: dados.data_ensaio ? new Date(dados.data_ensaio).toLocaleDateString('pt-BR') : '',
    hora_inicio_curta: dados.hora_inicio ? dados.hora_inicio.substring(0, 5) : '',
    hora_fim_curta: dados.hora_fim ? dados.hora_fim.substring(0, 5) : '',
    // 👇 Adiciona isso aqui
    calendar_start: dados.data_ensaio && dados.hora_inicio 
      ? `${dados.data_ensaio.substring(0, 10)}T${dados.hora_inicio}-03:00` 
      : '',
    calendar_end: dados.data_ensaio && dados.hora_fim 
      ? `${dados.data_ensaio.substring(0, 10)}T${dados.hora_fim}-03:00` 
      : ''
  });

    console.log(`✅ [Webhook n8n] Enviado com sucesso para: ${url}`);
  } catch (error: any) {
    console.error('❌ [Webhook n8n] Erro de conexão:', error.message || error);
  }
}