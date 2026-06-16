import { pool } from '../database.js';

// ============================================================
// SERVIÇO DE RELATÓRIO DIÁRIO DA EQUIPE
// Executa todos os dias no horário configurado via cron.
// Envia para o n8n um payload com cada membro da equipe,
// seus ensaios agendados (status = 'Agendado'), papel em cada
// um, e dados de contato (nome + telefone).
// ============================================================

function formatarTelefoneWhatsapp(telefone: string | null | undefined): string {
  if (!telefone) return '';
  let limpo = telefone.replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = '55' + limpo;
  return limpo;
}

export async function dispararRelatorioDiario(): Promise<void> {
  const urlWebhook = process.env.N8N_RELATORIO_DIARIO_WEBHOOK_URL;

  if (!urlWebhook) {
    console.warn('⚠️  [Relatório Diário] N8N_RELATORIO_DIARIO_WEBHOOK_URL não configurada. Pulando envio.');
    return;
  }

  try {
    console.log('📊 [Relatório Diário] Iniciando coleta de dados da equipe...');

    // 1. Busca todos os membros da equipe com nome e telefone
    const membrosResult = await pool.query(
      'SELECT id, nome, telefone, email FROM equipe ORDER BY nome ASC'
    );
    const membros = membrosResult.rows;

    // 2. Busca todos os ensaios com status 'Agendado' que têm equipe designada
    const ensaiosResult = await pool.query(`
      SELECT
        id,
        empresa_nome,
        TO_CHAR(data_ensaio, 'DD/MM/YYYY') as data_ensaio,
        hora_inicio,
        hora_fim,
        status,
        objetivos,
        fotografo_responsavel,
        roteirista_responsavel,
        auxiliar_responsavel
      FROM ensaios
      WHERE status = 'Agendado'
        AND (
          fotografo_responsavel IS NOT NULL OR
          roteirista_responsavel IS NOT NULL OR
          auxiliar_responsavel IS NOT NULL
        )
      ORDER BY data_ensaio ASC, hora_inicio ASC
    `);
    const ensaiosAgendados = ensaiosResult.rows;

    // 3. Para cada membro, monta o objeto com seus trabalhos e papel
    const relatorioEquipe = membros.map((membro) => {
      const trabalhosDoMembro: Array<{
        ensaio_id: number;
        empresa_nome: string;
        data_ensaio: string;
        hora_inicio: string;
        hora_fim: string;
        objetivos: string;
        papel: string;
      }> = [];

      for (const ensaio of ensaiosAgendados) {
        let papel: string | null = null;

        if (ensaio.fotografo_responsavel === membro.nome) papel = 'Filmmaker';
        else if (ensaio.roteirista_responsavel === membro.nome) papel = 'Roteirista';
        else if (ensaio.auxiliar_responsavel === membro.nome) papel = 'Auxiliar Técnico';

        if (papel) {
          trabalhosDoMembro.push({
            ensaio_id: ensaio.id,
            empresa_nome: ensaio.empresa_nome,
            data_ensaio: ensaio.data_ensaio,
            hora_inicio: ensaio.hora_inicio.substring(0, 5),
            hora_fim: ensaio.hora_fim.substring(0, 5),
            objetivos: ensaio.objetivos || '',
            papel,
          });
        }
      }

      return {
        nome: membro.nome,
        email: membro.email,
        telefone: formatarTelefoneWhatsapp(membro.telefone),
        total_agendados: trabalhosDoMembro.length,
        trabalhos: trabalhosDoMembro,
      };
    });

    // Remove membros sem nenhum trabalho agendado
    const relatorioFiltrado = relatorioEquipe.filter((m) => m.total_agendados > 0);

    // 4. Monta o payload final e envia ao n8n
    const payload = {
      evento: 'RELATORIO_DIARIO_EQUIPE',
      gerado_em: new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      total_membros_ativos: relatorioFiltrado.length,
      total_ensaios_agendados: ensaiosAgendados.length,
      equipe: relatorioFiltrado,
    };

    const axios = (await import('axios')).default;
    await axios.post(urlWebhook, payload);

    console.log(
      `✅ [Relatório Diário] Enviado com sucesso para o n8n. ` +
      `${relatorioFiltrado.length} membro(s) com trabalhos agendados.`
    );

  } catch (error: any) {
    console.error('❌ [Relatório Diário] Erro ao gerar ou enviar relatório:', error.message);
  }
}

// ============================================================
// AGENDADOR INTERNO (cron simples sem dependência externa)
// Dispara todos os dias às 07:00 horário de Brasília.
// Para alterar o horário, mude HORA_DISPARO e MINUTO_DISPARO.
// ============================================================

const HORA_DISPARO = 7;   // 07h
const MINUTO_DISPARO = 0; // 00min

function agendarProximoDisparo(): void {
  const agora = new Date();

  // Calcula o próximo disparo em horário de Brasília (UTC-3)
  const agoraBrasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

  const proximoDisparo = new Date(agoraBrasilia);
  proximoDisparo.setHours(HORA_DISPARO, MINUTO_DISPARO, 0, 0);

  // Se o horário de hoje já passou, agenda para amanhã
  if (proximoDisparo <= agoraBrasilia) {
    proximoDisparo.setDate(proximoDisparo.getDate() + 1);
  }

  const msAteDisparo = proximoDisparo.getTime() - agoraBrasilia.getTime();

  console.log(
    `⏰ [Relatório Diário] Próximo disparo em: ` +
    `${proximoDisparo.toLocaleString('pt-BR')} ` +
    `(${Math.round(msAteDisparo / 1000 / 60)} minutos)`
  );

  setTimeout(async () => {
    await dispararRelatorioDiario();
    agendarProximoDisparo(); // reagenda para o dia seguinte
  }, msAteDisparo);
}

// Função de entrada — chame isso no seu server.ts / index.ts
export function iniciarRelatorioDiario(): void {
  console.log('🚀 [Relatório Diário] Serviço iniciado.');
  agendarProximoDisparo();
}