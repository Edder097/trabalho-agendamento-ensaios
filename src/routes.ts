import { Router } from 'express';
import { pool } from './database.js';
import { adicionarEnsaioNaPlanilha } from './services/sheetsService.js';
import { 
  enviarEmailConfirmacaoCliente, 
  notificarColaboradorAtribuido, 
  enviarEmailCancelamentoInterno
} from './services/notificationService.js';
import { enviarParaN8n } from './services/wehbhookService.js'; 
import crypto from 'crypto';

const router = Router();

// ==========================================
// ROTAS DO CLIENTE (PÚBLICAS)
// ==========================================

// 1. VERIFICAR HORÁRIOS DISPONÍVEIS
router.get('/agenda/disponibilidade', async (req, res) => {
  try {
    const { data } = req.query; 
    if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

    const dataSelecionada = new Date(data as string);
    const diaDaSemana = dataSelecionada.getUTCDay(); 

    // 🔥 VALIDAÇÃO DOS 3 DIAS DE ANTECEDÊNCIA MÍNIMA
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
    // Define a data mínima permitida (Hoje + 3 dias)
    const dataMinimaPermitida = new Date(hoje);
    dataMinimaPermitida.setDate(dataMinimaPermitida.getDate() + 3);

    const dataComparacao = new Date(dataSelecionada.getUTCFullYear(), dataSelecionada.getUTCMonth(), dataSelecionada.getUTCDate());

    if (dataComparacao < dataMinimaPermitida) {
      return res.json({ 
        permitido: false, 
        mensagem: 'Os ensaios devem ser agendados com no mínimo 3 dias de antecedência para planejamento estratégico da equipe. Por favor, escolha uma data posterior.' 
      });
    }

    if (diaDaSemana === 0 || diaDaSemana === 1) {
      return res.json({ 
        permitido: false, 
        mensagem: 'Para agendar neste dia, confirme disponibilidade com a equipe pelo grupo de WhatsApp da sua empresa.' 
      });
    }
    
    const dataAnteriorObj = new Date(dataSelecionada);
    dataAnteriorObj.setUTCDate(dataAnteriorObj.getUTCDate() - 1);
    const dataAnterior = dataAnteriorObj.toISOString().split('T')[0];

    // 🔹 CORREÇÃO 1: Ignora ensaios 'Cancelado' e 'Concluído' no cálculo do dia anterior
    const queryAnterior = `
      SELECT COUNT(*) FROM ensaios 
      WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')
    `;
    const resAnterior = await pool.query(queryAnterior, [dataAnterior]);
    const totalEnsaiosDiaAnterior = parseInt(resAnterior.rows[0].count);

    // 🔹 CORREÇÃO 2: Ignora ensaios 'Cancelado' e 'Concluído' no cálculo do dia atual
    const queryAtual = `
      SELECT COUNT(*) FROM ensaios 
      WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')
    `;
    const resAtual = await pool.query(queryAtual, [data as string]);
    const totalEnsaiosDiaAtual = parseInt(resAtual.rows[0].count);

    if (totalEnsaiosDiaAnterior >= 2 && totalEnsaiosDiaAtual >= 1) {
      return res.json({
        permitido: false,
        mensagem: 'Agenda limitada para este dia. O limite de agendamentos foi atingido devido ao volume de produções do dia anterior para garantir o tempo de edição do Filmmaker.'
      });
    }

// 🕒 LISTA DE HORÁRIOS PERMITIDOS (Permite início até as 19:00)
    const horariosPossiveis = [
      '07:00', '08:00', '09:00', '10:00', '11:00', 
      '12:00', '13:00', '14:00', '15:00', '16:00', 
      '17:00', '18:00', '19:00'
    ];

    // 🔹 CORREÇÃO 3: Ignora ensaios 'Cancelado' e 'Concluído' para liberar os blocos de horários na grade
    const ensaiosExistentes = await pool.query(
      `SELECT hora_inicio, hora_fim FROM ensaios WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')`,
      [data as string]
    );

    const bloqueiosAdm = await pool.query(
      `SELECT hora_inicio, hora_fim FROM bloqueios_agenda WHERE data_bloqueio = $1`,
      [data as string]
    );

    const horariosDisponiveis = horariosPossiveis.filter(horario => {
      const [h, m] = horario.split(':').map(Number);
      const inicioProposto = h * 60 + m;
      const fimProposto = inicioProposto + 240; // 4 horas de ensaio

      // 🔥 CORREÇÃO DA TRAVA: Garante que o último INÍCIO permitido seja as 19h (19 * 60 = 1140 minutos)
      if (inicioProposto > 19 * 60) return false;

      for (let ensaio of ensaiosExistentes.rows) {
        const [hIn, mIn] = ensaio.hora_inicio.split(':').map(Number);
        const [hFim, mFim] = ensaio.hora_fim.split(':').map(Number);
        const ensaioInicio = hIn * 60 + mIn;
        const ensaioFimComDeslocamento = (hFim * 60 + mFim) + 120; // +2h deslocamento

        if (inicioProposto < ensaioFimComDeslocamento && fimProposto + 120 > ensaioInicio) return false;
      }

      for (let bloqueio of bloqueiosAdm.rows) {
        if (!bloqueio.hora_inicio) return false; 
        const [hIn, mIn] = bloqueio.hora_inicio.split(':').map(Number);
        const [hFim, mFim] = bloqueio.hora_fim.split(':').map(Number);
        if (inicioProposto < (hFim * 60 + mFim) && fimProposto > (hIn * 60 + mIn)) return false;
      }

      return true;
    });

    return res.json({ permitido: true, horarios: horariosDisponiveis });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno ao calcular disponibilidade.' });
  }
});

// 2. AGENDAR ENSAIO
router.post('/agenda/agendar', async (req, res) => {
  try {
    const { empresa_nome, email_cliente, objetivos, contato_nome, contato_telefone, data_ensaio, hora_inicio } = req.body;

    const [h, m] = hora_inicio.split(':').map(Number);
    const horaFimFormatada = `${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;

    const tokenCancelamento = crypto.randomUUID();

    const novoEnsaio = await pool.query(
      `INSERT INTO ensaios 
       (empresa_nome, email_cliente, objetivos, contato_nome, contato_telefone, data_ensaio, hora_inicio, hora_fim, token_cancelamento) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [empresa_nome, email_cliente, objetivos, contato_nome, contato_telefone, data_ensaio, hora_inicio, horaFimFormatada, tokenCancelamento]
    );

    const ensaioCriado = novoEnsaio.rows[0];

    // GATILHOS DE AUTOMATIZAÇÃO PREDETERMINADOS
    adicionarEnsaioNaPlanilha(ensaioCriado);
    enviarEmailConfirmacaoCliente(ensaioCriado);
    
    // 🔥 GERAR O LINK DE CANCELAMENTO DINÂMICO AQUI
    const protocolo = req.protocol;
    const host = req.get('host');
    const linkCancelamento = `${protocolo}://${host}/api/v1/agendamentos/cancelar?id=${ensaioCriado.id}&token=${tokenCancelamento}`;

    // 🚀 DISPARO PARA O n8n (WhatsApp) COM O LINK INCLUSO
    enviarParaN8n({
      id: ensaioCriado.id,
      empresa_nome: ensaioCriado.empresa_nome,
      email_cliente: ensaioCriado.email_cliente,
      contato_nome: ensaioCriado.contato_nome,
      contato_telefone: ensaioCriado.contato_telefone,
      data_ensaio: ensaioCriado.data_ensaio,
      hora_inicio: ensaioCriado.hora_inicio,
      hora_fim: ensaioCriado.hora_fim,
      objetivos: ensaioCriado.objetivos,
      status: 'Agendado',
      link_cancelamento: linkCancelamento // 🔹 Pronto para o n8n antigo pescar!
    });

    return res.status(201).json({
      message: 'Seu ensaio foi agendado com sucesso!',
      ensaio: ensaioCriado
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao processar o agendamento.' });
  }
});

// ==========================================
// ROTAS ADMINISTRATIVAS
// ==========================================

router.get('/admin/ensaios', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT e.*, f.nome as filmmaker_nome, r.nome as roteirista_nome, d.nome as diretor_nome
      FROM ensaios e
      LEFT JOIN colaboradores f ON e.filmmaker_id = f.id
      LEFT JOIN colaboradores r ON e.roteirista_id = r.id
      LEFT JOIN colaboradores d ON e.diretor_id = d.id
    `;
    const params = [];
    if (status) {
      query += ` WHERE e.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY e.data_ensaio ASC, e.hora_inicio ASC`;
    const resultado = await pool.query(query, params);
    return res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao buscar ensaios.' });
  }
});

router.post('/admin/colaboradores', async (req, res) => {
  try {
    const { nome, funcao, telephone, email } = req.body;
    const novoColaborador = await pool.query(
      `INSERT INTO colaboradores (nome, funcao, telefone, email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [nome, funcao, telephone, email]
    );
    return res.status(201).json(novoColaborador.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao cadastrar colaborador.' });
  }
});

router.get('/admin/colaboradores', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM colaboradores ORDER BY nome ASC');
    return res.json(resultado.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao listar colaboradores.' });
  }
});

router.put('/admin/ensaios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { filmmaker_id, roteirista_id, diretor_id, status } = req.body;
    
    const ensaioAtualizado = await pool.query(
      `UPDATE ensaios 
       SET filmmaker_id = COALESCE($1, filmmaker_id),
           roteirista_id = COALESCE($2, roteirista_id),
           diretor_id = COALESCE($3, diretor_id),
           status = COALESCE($4, status)
       WHERE id = $5 RETURNING *`,
      [filmmaker_id, roteirista_id, diretor_id, status, id]
    );
    
    if (ensaioAtualizado.rowCount === 0) return res.status(404).json({ error: 'Ensaio não encontrado.' });

    const ensaioEditado = ensaioAtualizado.rows[0];

    if (filmmaker_id) {
      const buscaFilmmaker = await pool.query('SELECT * FROM colaboradores WHERE id = $1', [filmmaker_id]);
      if (buscaFilmmaker.rows && buscaFilmmaker.rows.length > 0) {
        await notificarColaboradorAtribuido(buscaFilmmaker.rows[0], ensaioEditado);
      }
    }

    return res.json({ message: 'Ensaio updated com sucesso!', ensaio: ensaioEditado });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao atualizar o ensaio.' });
  }
});

// =========================================================================
// CONTROLLER DE CANCELAMENTO COMPARTILHADO (ADMIN / FILMMAKER / GENÉRICO)
// =========================================================================
const executarCancelamentoEnsaio = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const motivo = req.body.motivo_cancelamento || req.body.motivo;
    
    if (!motivo || String(motivo).trim() === '') {
      return res.status(400).json({ error: 'O motivo do cancelamento é obrigatório.' });
    }
    
    // 1. Atualiza o banco de dados
    const ensaioCancelado = await pool.query(
      `UPDATE ensaios SET status = 'Cancelado', motivo_cancelamento = $1 WHERE id = $2 RETURNING *`,
      [motivo.trim(), id]
    );
    
    if (ensaioCancelado.rowCount === 0) {
      return res.status(404).json({ error: 'Ensaio não encontrado.' });
    }

    const ensaio = ensaioCancelado.rows[0];
    console.log(`✅ [Cancelamento] Ensaio ID ${id} cancelado com sucesso no banco.`);

    // 2. Dispara para o n8n de forma isolada
    try {
      await enviarParaN8n({
        ...ensaio,
        evento: 'ENSAIO_CANCELADO'
      });
    } catch (n8nErr: any) {
      console.error('⚠️ Falha no n8n, mas o banco foi atualizado:', n8nErr.message);
    }

    return res.json({ message: 'Ensaio cancelado com sucesso.', ensaio });

  } catch (error: any) {
    console.error('❌ Erro crítico no banco de dados ao cancelar:', error.message || error);
    return res.status(500).json({ error: 'Erro interno ao cancelar o ensaio.' });
  }
};

// 🔹 Vincula a função a todas as variantes possíveis que o front-end pode estar chamando
router.put('/admin/ensaios/:id/cancelar', executarCancelamentoEnsaio);
router.patch('/admin/ensaios/:id/cancelar', executarCancelamentoEnsaio);

router.put('/filmmaker/ensaios/:id/cancelar', executarCancelamentoEnsaio);
router.patch('/filmmaker/ensaios/:id/cancelar', executarCancelamentoEnsaio);

router.put('/ensaios/:id/cancelar', executarCancelamentoEnsaio);
router.patch('/ensaios/:id/cancelar', executarCancelamentoEnsaio);

// ==========================================
// ROTAS DO PAINEL OPERACIONAL
// ==========================================

router.get('/painel/equipe', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM equipe ORDER BY nome ASC');
    return res.json(resultado.rows);
  } catch (error) {
    console.error('❌ Erro ao buscar membros da equipe:', error);
    return res.status(500).json({ error: 'Erro ao buscar equipe.' });
  }
});

router.get('/painel/ensaios', async (req, res) => {
  try {
    const query = `
      SELECT id, empresa_nome, contato_nome, contato_telefone, email_cliente, objetivos, 
             TO_CHAR(data_ensaio, 'YYYY-MM-DD') as data_ensaio, 
             hora_inicio, hora_fim, status,
             fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel,
             motivo_cancelamento
      FROM ensaios 
      ORDER BY data_ensaio ASC, hora_inicio ASC
    `;
    const resultado = await pool.query(query);
    return res.json(resultado.rows);
  } catch (error) {
    console.error('❌ Erro ao buscar ensaios:', error);
    return res.status(500).json({ error: 'Erro ao buscar dados do painel.' });
  }
});

router.patch('/painel/ensaios/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      motivo_cancelamento,
      fotografo_responsavel,
      roteirista_responsavel,
      auxiliar_responsavel
    } = req.body;

    // =============================================
    // CASO 1: CANCELAMENTO
    // =============================================
    if (status === 'Cancelado') {
      if (!motivo_cancelamento || motivo_cancelamento.trim() === '') {
        return res.status(400).json({ error: 'O motivo do cancelamento é obrigatório.' });
      }

      const resultado = await pool.query(
        `UPDATE ensaios SET status = 'Cancelado', motivo_cancelamento = $1 WHERE id = $2 RETURNING *`,
        [motivo_cancelamento.trim(), id]
      );

      if (resultado.rowCount === 0) {
        return res.status(404).json({ error: 'Ensaio não encontrado.' });
      }

const ensaioCancelado = resultado.rows[0];

  // Busca email e telefone da equipe alocada neste ensaio
  let dadosFotografo  = { email: '', telefone: '' };
  let dadosRoteirista = { email: '', telefone: '' };
  let dadosAuxiliar   = { email: '', telefone: '' };

  const nomesResponsaveis = [
    ensaioCancelado.fotografo_responsavel,
    ensaioCancelado.roteirista_responsavel,
    ensaioCancelado.auxiliar_responsavel
  ].filter(nome => nome && nome.trim() !== '');

  if (nomesResponsaveis.length > 0) {
    const buscaEquipe = await pool.query(
      'SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)',
      [nomesResponsaveis]
    );
    buscaEquipe.rows.forEach(colaborador => {
      if (colaborador.nome === ensaioCancelado.fotografo_responsavel)  dadosFotografo  = colaborador;
      if (colaborador.nome === ensaioCancelado.roteirista_responsavel) dadosRoteirista = colaborador;
      if (colaborador.nome === ensaioCancelado.auxiliar_responsavel)   dadosAuxiliar   = colaborador;
    });
  }

  try {
    await enviarParaN8n({
      ...ensaioCancelado,
      evento: 'ENSAIO_CANCELADO',
      fotografo_email:     dadosFotografo.email    || '',
      fotografo_telefone:  formatarTelefoneWhatsapp(dadosFotografo.telefone),
      roteirista_email:    dadosRoteirista.email   || '',
      roteirista_telefone: formatarTelefoneWhatsapp(dadosRoteirista.telefone),
      auxiliar_email:      dadosAuxiliar.email     || '',
      auxiliar_telefone:   formatarTelefoneWhatsapp(dadosAuxiliar.telefone)
    } as any);
  } catch (n8nErr: any) {
    console.error('⚠️ Falha n8n no cancelamento:', n8nErr.message);
  }

  return res.json({ message: 'Ensaio cancelado com sucesso.', ensaio: ensaioCancelado });
}

    // =============================================
    // CASO 2: CONCLUSÃO
    // =============================================
    if (status === 'Concluído') {
      const resultado = await pool.query(
        `UPDATE ensaios SET status = 'Concluído' WHERE id = $1 RETURNING *`,
        [id]
      );

      if (resultado.rowCount === 0) {
        return res.status(404).json({ error: 'Ensaio não encontrado.' });
      }

      return res.json({ message: 'Ensaio concluído!', ensaio: resultado.rows[0] });
    }

    // =============================================
    // CASO 3: ESCALAÇÃO DE EQUIPE
    // Só aqui valida os campos obrigatórios
    // =============================================
    if (
      !fotografo_responsavel || fotografo_responsavel.trim() === '' ||
      !roteirista_responsavel || roteirista_responsavel.trim() === '' ||
      !auxiliar_responsavel   || auxiliar_responsavel.trim()   === ''
    ) {
      return res.status(400).json({
        error: 'Ação bloqueada: Você precisa selecionar todos os encarregados (Fotógrafo, Roteirista e Auxiliar) antes de salvar.'
      });
    }

    const ensaioAtual = await pool.query('SELECT * FROM ensaios WHERE id = $1', [id]);
    if (ensaioAtual.rowCount === 0) {
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    const novoStatus = status !== undefined ? status : ensaioAtual.rows[0].status;

    const queryUpdate = `
      UPDATE ensaios 
      SET status = $1, fotografo_responsavel = $2, roteirista_responsavel = $3, auxiliar_responsavel = $4
      WHERE id = $5 RETURNING *
    `;
    const resultado = await pool.query(queryUpdate, [
      novoStatus, fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel, id
    ]);
    const ensaioAtualizado = resultado.rows[0];

    const nomesEquipe = [fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel];
    let dadosFotografo  = { email: '', telefone: '' };
    let dadosRoteirista = { email: '', telefone: '' };
    let dadosAuxiliar   = { email: '', telefone: '' };

    const buscaEquipe = await pool.query(
      'SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)',
      [nomesEquipe]
    );

    buscaEquipe.rows.forEach(colaborador => {
      if (colaborador.nome === fotografo_responsavel)  dadosFotografo  = colaborador;
      if (colaborador.nome === roteirista_responsavel) dadosRoteirista = colaborador;
      if (colaborador.nome === auxiliar_responsavel)   dadosAuxiliar   = colaborador;
    });

    const urlWebhookAtribuicao = process.env.N8N_ATRIBUICAO_WEBHOOK_URL;
    if (urlWebhookAtribuicao) {
      try {
        const axios = (await import('axios')).default;

        const dataBanco = new Date(ensaioAtualizado.data_ensaio);
        const ano = dataBanco.getUTCFullYear();
        const mes = String(dataBanco.getUTCMonth() + 1).padStart(2, '0');
        const dia = String(dataBanco.getUTCDate()).padStart(2, '0');
        const dataFormatadaISO = `${ano}-${mes}-${dia}`;

        const inicioComSegundos = ensaioAtualizado.hora_inicio?.length === 5
          ? `${ensaioAtualizado.hora_inicio}:00`
          : ensaioAtualizado.hora_inicio;

        const fimComSegundos = ensaioAtualizado.hora_fim?.length === 5
          ? `${ensaioAtualizado.hora_fim}:00`
          : ensaioAtualizado.hora_fim;

        await axios.post(urlWebhookAtribuicao, {
          evento: 'EQUIPE_ATRIBUIDA',
          id: ensaioAtualizado.id,
          empresa_nome: ensaioAtualizado.empresa_nome,
          contato_nome: ensaioAtualizado.contato_nome,
          contato_telefone: ensaioAtualizado.contato_telefone,
          objetivos: ensaioAtualizado.objetivos,
          status: ensaioAtualizado.status,
          google_start_time: `${dataFormatadaISO}T${inicioComSegundos}-03:00`,
          google_end_time:   `${dataFormatadaISO}T${fimComSegundos}-03:00`,
          data_ensaio_ptbr:  `${dia}/${mes}/${ano}`,
          hora_inicio_curta: inicioComSegundos?.substring(0, 5) ?? '',
          hora_fim_curta:    fimComSegundos?.substring(0, 5)    ?? '',
          fotografo_responsavel,
          fotografo_email:    dadosFotografo.email,
          fotografo_telefone: formatarTelefoneWhatsapp(dadosFotografo.telefone),
          roteirista_responsavel,
          roteirista_email:    dadosRoteirista.email,
          roteirista_telefone: formatarTelefoneWhatsapp(dadosRoteirista.telefone),
          auxiliar_responsavel,
          auxiliar_email:    dadosAuxiliar.email,
          auxiliar_telefone: formatarTelefoneWhatsapp(dadosAuxiliar.telefone)
        });

        console.log('✅ [Webhook n8n] Notificação de equipe enviada!');
      } catch (n8nError: any) {
        console.error('❌ [Webhook n8n] Erro:', n8nError.message);
      }
    }

    return res.json({ message: 'Agendamento atualizado com sucesso!', ensaio: ensaioAtualizado });

  } catch (error) {
    console.error('❌ Erro ao atualizar dados do ensaio:', error);
    return res.status(500).json({ error: 'Erro ao atualizar dados.' });
  }
});

// =========================================================================
// 1. TELA DE FORMULÁRIO DE CANCELAMENTO (GET)
// =========================================================================
router.get('/v1/agendamentos/cancelar', async (req, res) => {
  const { id, token } = req.query;

  if (!id || !token) {
    return res.status(400).send('<h1>Erro</h1><p>Parâmetros inválidos.</p>');
  }

  try {
    const buscaEnsaio = await pool.query('SELECT * FROM ensaios WHERE id = $1', [id]);
    const ensaio = buscaEnsaio.rows[0];

    if (!ensaio || ensaio.token_cancelamento !== token) {
      return res.status(403).send('<h1>Acesso Negado</h1><p>Link inválido ou expirado.</p>');
    }

    if (ensaio.status === 'Cancelado' || ensaio.status === 'CANCELADO') {
      return res.send(`
        <div style="font-family: sans-serif; text-align: center; padding: 50px; background-color: #0f172a; color: #fff; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
          <h2 style="color: #e2e8f0; margin: 0 0 10px 0;">Este ensaio já foi cancelado!</h2>
          <p style="color: #94a3b8; margin: 0;">Nenhuma ação adicional é necessária.</p>
        </div>
      `);
    }

    return res.send(`
      <div style="font-family: sans-serif; background-color: #0f172a; color: #fff; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 20px;">
        <div style="background-color: #1e293b; padding: 30px; border-radius: 12px; max-width: 450px; width: 100%; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); border: 1px solid #334155;">
          <h2 style="color: #ef4444; margin-top: 0;">Cancelar Agendamento? ⚠️</h2>
          <p style="color: #cbd5e1; font-size: 14px;">Você está prestes a cancelar o ensaio da empresa <strong>${ensaio.empresa_nome}</strong>.</p>
          
          <form action="/api/v1/agendamentos/cancelar/confirmar" method="POST" style="margin-top: 20px;">
            <input type="hidden" name="id" value="${id}">
            <input type="hidden" name="token" value="${token}">
            
            <label style="display: block; margin-bottom: 8px; font-size: 14px; color: #94a3b8;">Por gentileza, informe o motivo do cancelamento:</label>
            <textarea name="motivo" rows="4" required placeholder="Ex: Mudança de planos da empresa, imprevisto na data..." style="width: 100%; padding: 10px; border-radius: 6px; background-color: #0f172a; border: 1px solid #475569; color: #fff; font-family: sans-serif; resize: none; box-sizing: border-box; margin-bottom: 20px;"></textarea>
            
            <button type="submit" style="width: 100%; background-color: #ef4444; color: #fff; border: none; padding: 12px; font-weight: bold; border-radius: 6px; cursor: pointer; font-size: 15px;">Confirmar Cancelamento</button>
          </form>
        </div>
      </div>
    `);
  } catch (error) {
    console.error(error);
    return res.status(500).send('<h1>Erro Interno</h1>');
  }
});

// =========================================================================
// FUNÇÃO AUXILIAR: FORMATAR NÚMERO PARA PADRÃO WHATSAPP (55DDD9XXXXXXXX)
// =========================================================================
function formatarTelefoneWhatsapp(telefoneCru: string): string {
  if (!telefoneCru) return '';

  // 1. Remove espaços, hífens, parênteses e qualquer caractere não-numérico
  let apenasNumeros = telefoneCru.replace(/\D/g, '');

  if (!apenasNumeros) return '';

  // 2. Se o usuário digitou com o 0 na frente do DDD (ex: 062...), remove o zero
  if (apenasNumeros.startsWith('0')) {
    apenasNumeros = apenasNumeros.substring(1);
  }

  // 3. Se o número já começar com 55 e tiver o tamanho certo, retorna ele
  if (apenasNumeros.startsWith('55') && (apenasNumeros.length === 12 || apenasNumeros.length === 13)) {
    return apenasNumeros;
  }

  // 4. Se não tem o 55, analisa o tamanho do bloco (DDD + Número)
  // Caso 1: Tem 10 dígitos (ex: 62 84243353) -> Falta o 55 e o 9 artificial
  if (apenasNumeros.length === 10) {
    const ddd = apenasNumeros.substring(0, 2);
    const numero = apenasNumeros.substring(2);
    return `55${ddd}9${numero}`;
  }

  // Caso 2: Tem 11 dígitos (ex: 62 984243353) -> Falta apenas o 55 do país
  if (apenasNumeros.length === 11) {
    return `55${apenasNumeros}`;
  }

  // Caso 3: Tem 8 ou 9 dígitos (Salvo sem DDD) -> Assume o DDD 62 padrão da região
  if (apenasNumeros.length === 8) {
    return `55629${apenasNumeros}`;
  }
  if (apenasNumeros.length === 9) {
    return `5562${apenasNumeros}`;
  }

  return apenasNumeros.startsWith('55') ? apenasNumeros : `55${apenasNumeros}`;
}

// =========================================================================
// 2. PROCESSAR O CANCELAMENTO E DISPARAR N8N (POST)
// =========================================================================
router.post('/v1/agendamentos/cancelar/confirmar', async (req, res) => {
  const { id, token, motivo } = req.body;

  if (!id || !token || !motivo) {
    return res.status(400).send('<h1>Erro</h1><p>Dados incompletos.</p>');
  }

  try {
    // 1. Busca o ensaio completo antes de qualquer alteração
    const buscaEnsaio = await pool.query('SELECT * FROM ensaios WHERE id = $1', [id]);
    const ensaio = buscaEnsaio.rows[0];

    if (!ensaio || ensaio.token_cancelamento !== token) {
      return res.status(403).send('<h1>Acesso Negado</h1><p>Token inválido.</p>');
    }

    if (ensaio.status === 'Cancelado' || ensaio.status === 'CANCELADO') {
      return res.send('<h1>Este ensaio já foi cancelado anteriormente.</h1>');
    }

    // 2. Atualiza no banco salvando o motivo que o cliente digitou
    await pool.query(
      "UPDATE ensaios SET status = 'Cancelado', motivo_cancelamento = $1 WHERE id = $2", 
      [motivo, id]
    );

    // 3. Busca e-mails e telefones da equipe alocada (Protegido contra valores nulos/vazios)
    const fotografoNome = ensaio.fotografo_responsavel ? ensaio.fotografo_responsavel.trim() : '';
    const roteiristaNome = ensaio.roteirista_responsavel ? ensaio.roteirista_responsavel.trim() : '';
    const auxiliarNome = ensaio.auxiliar_responsavel ? ensaio.auxiliar_responsavel.trim() : '';

    const nomesResponsaveis = [fotografoNome, roteiristaNome, auxiliarNome].filter(nome => nome !== '');

    // Criamos objetos de segurança caso ninguém esteja alocado
    let dadosFotografo = { email: '', telefone: '' };
    let dadosRoteirista = { email: '', telefone: '' };
    let dadosAuxiliar = { email: '', telefone: '' };

    if (nomesResponsaveis.length > 0) {
      const buscaEquipe = await pool.query('SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)', [nomesResponsaveis]);
      
      // Mapeia os contatos de cada um de volta para suas respectivas funções
      buscaEquipe.rows.forEach(colaborador => {
        if (colaborador.nome === ensaio.fotografo_responsavel) dadosFotografo = colaborador;
        if (colaborador.nome === ensaio.roteirista_responsavel) dadosRoteirista = colaborador;
        if (colaborador.nome === ensaio.auxiliar_responsavel) dadosAuxiliar = colaborador;
      });

      // Dispara os e-mails internos direto pelo Node
      for (const colaborador of buscaEquipe.rows) {
        let funcao = 'Equipe';
        if (colaborador.nome === ensaio.fotografo_responsavel) funcao = 'Fotógrafo/Filmmaker';
        if (colaborador.nome === ensaio.roteirista_responsavel) funcao = 'Roteirista';
        if (colaborador.nome === ensaio.auxiliar_responsavel) funcao = 'Auxiliar Técnico';

        try {
          await enviarEmailCancelamentoInterno({ ...colaborador, funcao }, { ...ensaio, motivo_cancelamento: motivo });
        } catch (emailError) {
          console.error('⚠️ Falha ao enviar e-mail de cancelamento interno:', emailError);
        }
      }
    }

    // 4. Reconstrói o link público para histórico ou consulta
    const protocolo = req.protocol;
    const host = req.get('host');
    const linkCancelamento = `${protocolo}://${host}/api/v1/agendamentos/cancelar?id=${ensaio.id}&token=${token}`;

    // 5. 🚀 ENVIANDO O PAYLOAD COMPLETO PARA O N8N NOVO
    try {
      await enviarParaN8n({
        id: ensaio.id,
        empresa_nome: ensaio.empresa_nome,
        email_cliente: ensaio.email_cliente,
        contato_nome: ensaio.contato_nome,
        contato_telefone: ensaio.contato_telefone,
        data_ensaio: ensaio.data_ensaio,
        hora_inicio: ensaio.hora_inicio,
        hora_fim: ensaio.hora_fim,
        objetivos: ensaio.objetivos,
        evento: 'ENSAIO_CANCELADO',
        status: 'Cancelado',
        motivo_cancelamento: motivo,
        link_cancelamento: linkCancelamento,
        
        // 🔹 Dados do Fotógrafo (Tratado contra erros de formatação!)
        fotografo_responsavel: ensaio.fotografo_responsavel || 'Não atribuído',
        fotografo_email: dadosFotografo.email || '',
        fotografo_telefone: dadosFotografo.telefone ? formatarTelefoneWhatsapp(dadosFotografo.telefone) : '',

        // 🔹 Dados do Roteirista (Tratado!)
        roteirista_responsavel: ensaio.roteirista_responsavel || 'Não atribuído',
        roteirista_email: dadosRoteirista.email || '',
        roteirista_telefone: dadosRoteirista.telefone ? formatarTelefoneWhatsapp(dadosRoteirista.telefone) : '',

        // 🔹 Dados do Auxiliar (Tratado!)
        auxiliar_responsavel: ensaio.auxiliar_responsavel || 'Não atribuído',
        auxiliar_email: dadosAuxiliar.email || '',
        auxiliar_telefone: dadosAuxiliar.telefone ? formatarTelefoneWhatsapp(dadosAuxiliar.telefone) : ''
      } as any);
      
      console.log('🚀 Webhook enviado com contatos limpos e padronizados para WhatsApp!');
    } catch (n8nError) {
      console.error('❌ Falha ao processar função enviarParaN8n:', n8nError);
    }

    return res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px; background-color: #0f172a; color: #fff; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        <h1 style="color: #ef4444; font-size: 32px; margin: 0 0 10px 0;">Cancelamento Confirmado! 🔥</h1>
        <p style="color: #cbd5e1; font-size: 16px; margin: 0;">O agendamento da empresa <strong>${ensaio.empresa_nome}</strong> foi cancelado com sucesso.</p>
      </div>
    `);

  } catch (error) {
    console.error('❌ Erro ao confirmar cancelamento:', error);
    return res.status(500).send('<h1>Erro Interno ao processar cancelamento.</h1>');
  }
});

// ✅ CORREÇÃO CRÍTICA: Mudança de export default para Named Export para sanar o SyntaxError
export { router };