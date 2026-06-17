import { Router } from 'express';
import { dispararRelatorioDiario } from './services/Relatorioservice.js';
import { pool } from './database.js';
import { adicionarEnsaioNaPlanilha } from './services/sheetsService.js';
import { 
  enviarEmailConfirmacaoCliente, 
  notificarColaboradorAtribuido, 
  enviarEmailCancelamentoInterno
} from './services/notificationService.js';
import { enviarParaN8n } from './services/wehbhookService.js'; 
import crypto from 'crypto';

// 🟢 NOVOS IMPORTS PARA FAZER O UPLOAD DO PDF FUNCIONAR REALMENTE
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const router = Router();

// Configuração do Multer para ler o arquivo na memória RAM antes de enviar ao R2
const upload = multer({ storage: multer.memoryStorage() });

// Configuração do cliente S3 apontando para o Cloudflare R2 via variáveis de ambiente (.env)
const s3 = new S3Client({
  endpoint: process.env.CLOUDFLARE_R2_ENDPOINT, // Exemplo: https://<account_id>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
  },
  region: 'auto',
});

// FUNÇÃO AUXILIAR DE FORMATAÇÃO DE WHATSAPP (Mantenha se já possuir no seu arquivo original)
function formatarTelefoneWhatsapp(telefone: string | null | undefined): string {
  if (!telefone) return '';
  let limpo = telefone.replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = '55' + limpo;
  return limpo;
}

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

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    
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

    const queryAnterior = `
      SELECT COUNT(*) FROM ensaios 
      WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')
    `;
    const resAnterior = await pool.query(queryAnterior, [dataAnterior]);
    const totalEnsaiosDiaAnterior = parseInt(resAnterior.rows[0].count);

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

    const horariosPossiveis = [
      '07:00', '08:00', '09:00', '10:00', '11:00', 
      '12:00', '13:00', '14:00', '15:00', '16:00', 
      '17:00', '18:00', '19:00'
    ];

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
      const fimProposto = inicioProposto + 240; 

      if (inicioProposto > 19 * 60) return false;

      for (let ensaio of ensaiosExistentes.rows) {
        const [hIn, mIn] = ensaio.hora_inicio.split(':').map(Number);
        const [hFim, mFim] = ensaio.hora_fim.split(':').map(Number);
        const ensaioInicio = hIn * 60 + mIn;
        const ensaioFimComDeslocamento = (hFim * 60 + mFim) + 120; 

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

// 1.1 VERIFICAR DISPONIBILIDADE DO MÊS INTEIRO
router.get('/agenda/disponibilidade-mes', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    if (!ano || !mes) return res.status(400).json({ error: 'Ano e mês são obrigatórios.' });

    const anoNum = parseInt(ano as string);
    const mesNum = parseInt(mes as string) - 1; 

    const ultimoDiaDoMes = new Date(anoNum, mesNum + 1, 0).getDate();
    const diasResultado = [];

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const dataMinimaPermitida = new Date(hoje);
    dataMinimaPermitida.setDate(dataMinimaPermitida.getDate() + 3);

    for (let dia = 1; dia <= ultimoDiaDoMes; dia++) {
      const dataCorrente = new Date(Date.UTC(anoNum, mesNum, dia));
      const dataFormatadaISO = dataCorrente.toISOString().split('T')[0]; 
      const diaDaSemana = dataCorrente.getUTCDay();

      const dataComparacao = new Date(dataCorrente.getUTCFullYear(), dataCorrente.getUTCMonth(), dataCorrente.getUTCDate());
      if (dataComparacao < dataMinimaPermitida) {
        diasResultado.push({ data: dataFormatadaISO, permitido: false, mensagem: 'Os ensaios devem ser agendados com no mínimo 3 dias de antecedência.' });
        continue;
      }

      if (diaDaSemana === 0 || diaDaSemana === 1) {
        diasResultado.push({ data: dataFormatadaISO, permitido: false, mensagem: 'Para agendar neste dia, confirme disponibilidade com a equipe pelo WhatsApp.' });
        continue;
      }

      const dataAnteriorObj = new Date(dataCorrente);
      dataAnteriorObj.setUTCDate(dataAnteriorObj.getUTCDate() - 1);
      const dataAnteriorFormatada = dataAnteriorObj.toISOString().split('T')[0];

      const resAnterior = await pool.query(
        `SELECT COUNT(*) FROM ensaios WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')`,
        [dataAnteriorFormatada]
      );
      const totalEnsaiosDiaAnterior = parseInt(resAnterior.rows[0].count);

      const resAtual = await pool.query(
        `SELECT COUNT(*) FROM ensaios WHERE data_ensaio = $1 AND status NOT IN ('Cancelado', 'Concluído')`,
        [dataFormatadaISO]
      );
      const totalEnsaiosDiaAtual = parseInt(resAtual.rows[0].count);

      if (totalEnsaiosDiaAnterior >= 2 && totalEnsaiosDiaAtual >= 1) {
        diasResultado.push({ data: dataFormatadaISO, permitido: false, mensagem: 'Agenda limitada para este dia devido ao volume de produções do dia anterior.' });
        continue;
      }

      diasResultado.push({ data: dataFormatadaISO, permitido: true, mensagem: 'Horários disponíveis.' });
    }

    return res.json(diasResultado);
  } catch (error) {
    console.error('❌ Erro ao calcular disponibilidade mensal:', error);
    return res.status(500).json({ error: 'Erro interno ao calcular disponibilidade mensal.' });
  }
});

// 2. AGENDAR ENSAIO
router.post('/agenda/agendar', async (req, res) => {
  try {
    const { empresa_nome, email_cliente, objetivos, contato_nome, contato_telefone, data_ensaio, hora_inicio } = req.body;

    if (!data_ensaio || data_ensaio.trim() === '') return res.status(400).json({ error: 'A data do ensaio é obrigatória.' });
    if (!hora_inicio || hora_inicio.trim() === '') return res.status(400).json({ error: 'O horário de início é obrigatório.' });

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
    adicionarEnsaioNaPlanilha(ensaioCriado);
    enviarEmailConfirmacaoCliente(ensaioCriado);
    
    const protocolo = req.protocol;
    const host = req.get('host');
    const linkCancelamento = `${protocolo}://${host}/api/v1/agendamentos/cancelar?id=${ensaioCriado.id}&token=${tokenCancelamento}`;

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
      link_cancelamento: linkCancelamento 
    });

    return res.status(201).json({ message: 'Seu ensaio foi agendado com sucesso!', ensaio: ensaioCriado });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao processar o agendamento.' });
  }
});

// ==========================================
// ROTAS ADMINISTRATIVAS ANTIGAS
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
    if (status) { query += ` WHERE e.status = $1`; params.push(status); }
    query += ` ORDER BY e.data_ensaio ASC, e.hora_inicio ASC`;
    const resultado = await pool.query(query, params);
    return res.json(resultado.rows);
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Erro ao buscar ensaios.' }); }
});

router.post('/admin/colaboradores', async (req, res) => {
  try {
    const { nome, funcao, telephone, email } = req.body;
    const novoColaborador = await pool.query(
      `INSERT INTO colaboradores (nome, funcao, telefone, email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [nome, funcao, telephone, email]
    );
    return res.status(201).json(novoColaborador.rows[0]);
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Erro ao cadastrar colaborador.' }); }
});

router.get('/admin/colaboradores', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM colaboradores ORDER BY nome ASC');
    return res.json(resultado.rows);
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Erro ao listar colaboradores.' }); }
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
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Erro ao atualizar o ensaio.' }); }
});

const ejecutarCancelamentoEnsaio = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const motivo = req.body.motivo_cancelamento || req.body.motivo;
    if (!motivo || String(motivo).trim() === '') return res.status(400).json({ error: 'O motivo do cancelamento é obrigatório.' });
    
    const ensaioCancelado = await pool.query(
      `UPDATE ensaios SET status = 'Cancelado', motivo_cancelamento = $1 WHERE id = $2 RETURNING *`,
      [motivo.trim(), id]
    );
    if (ensaioCancelado.rowCount === 0) return res.status(404).json({ error: 'Ensaio não encontrado.' });

    const ensaio = ensaioCancelado.rows[0];
    try { await enviarParaN8n({ ...ensaio, evento: 'ENSAIO_CANCELADO' }); } catch (n8nErr: any) { console.error(n8nErr.message); }

    return res.json({ message: 'Ensaio cancelado com sucesso.', ensaio });
  } catch (error: any) { return res.status(500).json({ error: 'Erro interno ao cancelar.' }); }
};

router.put('/admin/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);
router.patch('/admin/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);
router.put('/filmmaker/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);
router.patch('/filmmaker/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);
router.put('/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);
router.patch('/ensaios/:id/cancelar', ejecutarCancelamentoEnsaio);


// ==========================================
// ROTAS DO PAINEL OPERACIONAL (FOCADO NA TABELA 'EQUIPE')
// ==========================================

// 1. AUTENTICAÇÃO DO COLABORADOR (LOGIN DO PAINEL DINÂMICO COM EMAIL E SENHA)
router.post('/painel/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body; // 🟢 Captura o e-mail e a senha enviados pelo front-end
    if (!email || !senha) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    // 🟢 Adicionado 'senha' na busca do banco de dados
    const resultado = await pool.query(
      'SELECT id, nome, email, senha FROM equipe WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (resultado.rowCount === 0) {
      return res.status(404).json({ error: 'Colaborador não encontrado com este e-mail.' });
    }

    const usuario = resultado.rows[0];

    // 🟢 Validação da Senha (Comparação direta em texto plano)
    if (usuario.senha !== senha) {
      return res.status(401).json({ error: 'Senha incorreta. Verifique os dados e tente novamente.' });
    }

    // 🔒 Segurança: Remove a senha do objeto antes de enviar para o Front-end
    delete usuario.senha;

    return res.json(usuario);
  } catch (error) {
    console.error('❌ Erro no login do painel:', error);
    return res.status(500).json({ error: 'Erro interno no servidor ao autenticar.' });
  }
});

// 2. BUSCAR ENSAIOS ESPECÍFICOS DO COLABORADOR LOGADO
router.get('/painel/meus-ensaios', async (req, res) => {
  try {
    const { nomeColaborador } = req.query;
    if (!nomeColaborador) return res.status(400).json({ error: 'Nome do colaborador é obrigatório.' });

    const query = `
      SELECT id, empresa_nome, 
             TO_CHAR(data_ensaio, 'YYYY-MM-DD') as data_ensaio, 
             hora_inicio, hora_fim, status,
             fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel,
             link_roteiro, link_arquivos_ensaio, link_materiais_auxiliares
      FROM ensaios 
      WHERE (fotografo_responsavel = $1 OR roteirista_responsavel = $1 OR auxiliar_responsavel = $1)
        AND status != 'Cancelado'
      ORDER BY data_ensaio ASC, hora_inicio ASC
    `;
    
    const resultado = await pool.query(query, [nomeColaborador as string]);
    return res.json(resultado.rows);
  } catch (error) {
    console.error('❌ Erro ao buscar ensaios do colaborador:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar seus ensaios.' });
  }
});

// 3. DASHBOARD DA EQUIPE — VISÃO DO GERENTE
// Um único query eficiente: busca todos os ensaios onde alguém foi escalado,
// e agrupa no JS por membro + papel, sem N+1 queries.
router.get('/painel/dashboard/equipe', async (req, res) => {
  try {
    // Passo 1: Busca todos os membros da equipe
    const membrosResult = await pool.query(
      'SELECT id, nome, email FROM equipe ORDER BY nome ASC'
    );
    const membros = membrosResult.rows;

    // Passo 2: Busca todos os ensaios que têm pelo menos um responsável
    const ensaiosResult = await pool.query(`
      SELECT 
        id,
        empresa_nome,
        TO_CHAR(data_ensaio, 'DD/MM/YYYY') as data_ensaio,
        hora_inicio,
        status,
        fotografo_responsavel,
        roteirista_responsavel,
        auxiliar_responsavel
      FROM ensaios
      WHERE fotografo_responsavel IS NOT NULL
         OR roteirista_responsavel IS NOT NULL
         OR auxiliar_responsavel IS NOT NULL
      ORDER BY data_ensaio DESC, hora_inicio DESC
    `);
    const todosEnsaios = ensaiosResult.rows;

    // Passo 3: Para cada membro, filtra os ensaios dele e determina o papel
    const dashboard = membros.map((membro) => {
      const trabalhos: Array<{
        id: number;
        empresa_nome: string;
        data_ensaio: string;
        hora_inicio: string;
        status: string;
        papel: string;
      }> = [];

      for (const ensaio of todosEnsaios) {
        let papel: string | null = null;
        if (ensaio.fotografo_responsavel === membro.nome) papel = 'Filmmaker';
        else if (ensaio.roteirista_responsavel === membro.nome) papel = 'Roteirista';
        else if (ensaio.auxiliar_responsavel === membro.nome) papel = 'Auxiliar Técnico';

        if (papel) {
          trabalhos.push({
            id: ensaio.id,
            empresa_nome: ensaio.empresa_nome,
            data_ensaio: ensaio.data_ensaio,
            hora_inicio: ensaio.hora_inicio,
            status: ensaio.status,
            papel,
          });
        }
      }

      const totais = trabalhos.reduce(
        (acc, t) => {
          acc.total++;
          if (t.status === 'Concluído') acc.concluidos++;
          if (t.status === 'Agendado') acc.agendados++;
          if (t.papel === 'Filmmaker') acc.filmmaker++;
          if (t.papel === 'Roteirista') acc.roteirista++;
          if (t.papel === 'Auxiliar Técnico') acc.auxiliar++;
          return acc;
        },
        { total: 0, concluidos: 0, agendados: 0, filmmaker: 0, roteirista: 0, auxiliar: 0 }
      );

      return { ...membro, totais, trabalhos };
    });

    // Retorna apenas membros que participaram de pelo menos 1 ensaio
    return res.json(dashboard.filter((m) => m.totais.total > 0));
  } catch (error) {
    console.error('❌ Erro ao buscar dashboard da equipe:', error);
    return res.status(500).json({ error: 'Erro ao buscar dashboard da equipe.' });
  }
});

// 3.1. LISTAR TODA A EQUIPE
router.get('/painel/equipe', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM equipe ORDER BY nome ASC');
    return res.json(resultado.rows);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar equipe.' }); }
});

// 4. LISTAR TODOS OS ENSAIOS (VISÃO GERAL) - CORRIGIDO!
router.get('/painel/ensaios', async (req, res) => {
  try {
    const query = `
      SELECT id, empresa_nome, contato_nome, contato_telefone, email_cliente, objetivos, 
             TO_CHAR(data_ensaio, 'YYYY-MM-DD') as data_ensaio, 
             hora_inicio, hora_fim, status,
             fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel,
             link_roteiro, link_arquivos_ensaio, link_materiais_auxiliares
      FROM ensaios 
      WHERE status != 'Cancelado'
      ORDER BY data_ensaio ASC, hora_inicio ASC
    `;
    const resultado = await pool.query(query);
    return res.json(resultado.rows);
  } catch (error) { 
    console.error('❌ Erro ao buscar ensaios no painel:', error);
    return res.status(500).json({ error: 'Erro ao buscar dados do painel.' }); 
  }
});

// 5. ATUALIZAÇÃO DE STATUS / INTERCEPTADOR DE LINKS ENVIADOS PELO PAINEL DINÂMICO
router.patch('/painel/ensaios/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      motivo_cancelamento,
      fotografo_responsavel,
      roteirista_responsavel,
      auxiliar_responsavel,
      link_arquivos_ensaio,     
      link_materiais_auxiliares 
    } = req.body;

    // 🟢 INTERCEPTADOR: Se a requisição veio do Painel Dinâmico apenas para salvar um link de texto (Filmmaker ou Auxiliar)
    if (link_arquivos_ensaio !== undefined || link_materiais_auxiliares !== undefined) {
      const camposAlterar = [];
      const valores = [];
      let index = 1;

      if (link_arquivos_ensaio !== undefined) {
        camposAlterar.push(`link_arquivos_ensaio = $${index++}`);
        valores.push(link_arquivos_ensaio);

        // 🔥 O PULO DO GATO: Se o filmmaker subiu um link válido (não vazio), altera o status para 'Concluído' automaticamente
        if (link_arquivos_ensaio && link_arquivos_ensaio.trim() !== '') {
          camposAlterar.push(`status = $${index++}`);
          valores.push('Concluído');
        }
      }
      if (link_materiais_auxiliares !== undefined) {
        camposAlterar.push(`link_materiais_auxiliares = $${index++}`);
        valores.push(link_materiais_auxiliares);
      }

      valores.push(id);
      const queryLinks = `UPDATE ensaios SET ${camposAlterar.join(', ')} WHERE id = $${index} RETURNING *`;
      const resLinks = await pool.query(queryLinks, valores);
      
      if (resLinks.rowCount === 0) return res.status(404).json({ error: 'Ensaio não encontrado.' });
      const ensaioAtualizado = resLinks.rows[0];

      // 🚀 DISPARO DO WEBHOOK CENTRALIZADO PARA O N8N
      try {
        const axios = (await import('axios')).default;
        
        // Define dinamicamente o tipo de evento e o link correspondente
        const eventoDefinido = link_arquivos_ensaio !== undefined ? 'ARQUIVOS_BRUTOS_ENVIADOS' : 'MATERIAIS_AUXILIARES_ENVIADOS';
        const linkEnviado = link_arquivos_ensaio !== undefined ? link_arquivos_ensaio : link_materiais_auxiliares;

        // Busca dados de contato de todos os membros da equipe escalados
        let dFoto = { email: '', telefone: '' }, dRote = { email: '', telefone: '' }, dAux = { email: '', telefone: '' };
        const nomesEquipe = [ensaioAtualizado.fotografo_responsavel, ensaioAtualizado.roteirista_responsavel, ensaioAtualizado.auxiliar_responsavel].filter(n => n && n.trim() !== '');

        if (nomesEquipe.length > 0) {
          const buscaEquipe = await pool.query('SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)', [nomesEquipe]);
          buscaEquipe.rows.forEach(membro => {
            if (membro.name === ensaioAtualizado.fotografo_responsavel || membro.nome === ensaioAtualizado.fotografo_responsavel) dFoto = membro;
            if (membro.name === ensaioAtualizado.roteirista_responsavel || membro.nome === ensaioAtualizado.roteirista_responsavel) dRote = membro;
            if (membro.name === ensaioAtualizado.auxiliar_responsavel || membro.nome === ensaioAtualizado.auxiliar_responsavel) dAux = membro;
          });
        }

        const dataBanco = new Date(ensaioAtualizado.data_ensaio);
        const dataFormatada = `${dataBanco.getUTCFullYear()}-${String(dataBanco.getUTCMonth() + 1).padStart(2, '0')}-${String(dataBanco.getUTCDate()).padStart(2, '0')}`;

        await axios.post('https://n8n-new.arsenalestrategia.com.br/webhook/acao_equipe', {
          evento: eventoDefinido,
          ensaio_id: ensaioAtualizado.id,
          empresa_nome: ensaioAtualizado.empresa_nome,
          link_atualizado: linkEnviado,
          data_ensaio: dataFormatada,
          hora_inicio: ensaioAtualizado.hora_inicio,
          
          // Informações do Filmmaker
          filmmaker_nome: ensaioAtualizado.fotografo_responsavel || 'Não escalado',
          filmmaker_email: dFoto.email || '',
          filmmaker_telefone: formatarTelefoneWhatsapp(dFoto.telefone),

          // Informações do Roteirista
          roteirista_nome: ensaioAtualizado.roteirista_responsavel || 'Não escalado',
          roteirista_email: dRote.email || '',
          roteirista_telefone: formatarTelefoneWhatsapp(dRote.telefone),

          // Informações do Auxiliar
          auxiliar_nome: ensaioAtualizado.auxiliar_responsavel || 'Não escalado',
          auxiliar_email: dAux.email || '',
          auxiliar_telefone: formatarTelefoneWhatsapp(dAux.telefone)
        });

        console.log(`📡 Webhook [${eventoDefinido}] disparado com sucesso para a empresa ${ensaioAtualizado.empresa_nome}`);
      } catch (webhookErr: any) {
        console.error('❌ Erro ao enviar webhook de links de texto para o n8n:', webhookErr.message);
      }
      
      return res.json({ message: 'Link atualizado com sucesso!', ensaio: ensaioAtualizado });
    }

    // CASO 1: CANCELAMENTO GERAL (Mantém o seu código padrão daqui para baixo...)
    if (status === 'Cancelado') {
      if (!motivo_cancelamento || motivo_cancelamento.trim() === '') return res.status(400).json({ error: 'O motivo do cancelamento é obrigatório.' });

      const resultado = await pool.query(`UPDATE ensaios SET status = 'Cancelado', motivo_cancelamento = $1 WHERE id = $2 RETURNING *`, [motivo_cancelamento.trim(), id]);
      if (resultado.rowCount === 0) return res.status(404).json({ error: 'Ensaio não encontrado.' });

      const ensaioCancelado = resultado.rows[0];
      let dFoto = { email: '', telefone: '' }, dRote = { email: '', telefone: '' }, dAux = { email: '', telefone: '' };
      const nomes = [ensaioCancelado.fotografo_responsavel, ensaioCancelado.roteirista_responsavel, ensaioCancelado.auxiliar_responsavel].filter(n => n && n.trim() !== '');

      if (nomes.length > 0) {
        const buscaEquipe = await pool.query('SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)', [nomes]);
        buscaEquipe.rows.forEach(c => {
          if (c.nome === ensaioCancelado.fotografo_responsavel) dFoto = c;
          if (c.nome === ensaioCancelado.roteirista_responsavel) dRote = c;
          if (c.nome === ensaioCancelado.auxiliar_responsavel) dAux = c;
        });
      }

      try {
        await enviarParaN8n({
          ...ensaioCancelado,
          evento: 'ENSAIO_CANCELADO',
          fotografo_email: dFoto.email, fotografo_telefone: formatarTelefoneWhatsapp(dFoto.telefone),
          roteirista_email: dRote.email, roteirista_telefone: formatarTelefoneWhatsapp(dRote.telefone),
          auxiliar_email: dAux.email, auxiliar_telefone: formatarTelefoneWhatsapp(dAux.telefone)
        } as any);
      } catch (err: any) { console.error('Falha n8n cancelamento:', err.message); }

      return res.json({ message: 'Ensaio cancelado com sucesso.', ensaio: ensaioCancelado });
    }

    // CASO 2: CONCLUSÃO DE STATUS
    if (status === 'Concluído') {
      const resultado = await pool.query(`UPDATE ensaios SET status = 'Concluído' WHERE id = $1 RETURNING *`, [id]);
      if (resultado.rowCount === 0) return res.status(404).json({ error: 'Ensaio não encontrado.' });
      return res.json({ message: 'Ensaio concluído!', ensaio: resultado.rows[0] });
    }

    // CASO 3: ESCALAÇÃO COMPLETA DE EQUIPE VIA GERENCIAMENTO GERAL
    if (!fotografo_responsavel || !roteirista_responsavel || !auxiliar_responsavel) {
      return res.status(400).json({ error: 'Ação bloqueada: Você precisa selecionar todos os encarregados antes de salvar.' });
    }

    const queryUpdate = `UPDATE ensaios SET status = COALESCE($1, status), fotografo_responsavel = $2, roteirista_responsavel = $3, auxiliar_responsavel = $4 WHERE id = $5 RETURNING *`;
    const resultado = await pool.query(queryUpdate, [status, fotografo_responsavel, roteirista_responsavel, auxiliar_responsavel, id]);
    if (resultado.rowCount === 0) return res.status(404).json({ error: 'Agendamento não encontrado.' });

    // Envio do Webhook de atribuição
    const urlWebhookAtribuicao = process.env.N8N_ATRIBUICAO_WEBHOOK_URL;
    if (urlWebhookAtribuicao) {
      try {
        const axios = (await import('axios')).default;
        const dataBanco = new Date(resultado.rows[0].data_ensaio);
        const formatISO = `${dataBanco.getUTCFullYear()}-${String(dataBanco.getUTCMonth() + 1).padStart(2,'0')}-${String(dataBanco.getUTCDate()).padStart(2,'0')}`;
        await axios.post(urlWebhookAtribuicao, {
          evento: 'EQUIPE_ATRIBUIDA',
          id: resultado.rows[0].id,
          empresa_nome: resultado.rows[0].empresa_nome,
          fotografo_responsavel,
          roteirista_responsavel,
          auxiliar_responsavel,
          google_start_time: `${formatISO}T${resultado.rows[0].hora_inicio}-03:00`,
          google_end_time: `${formatISO}T${resultado.rows[0].hora_fim}-03:00`
        });
      } catch (err: any) { console.error('Erro webhook atribuição:', err.message); }
    }

    return res.json({ message: 'Agendamento updated com sucesso!', ensaio: resultado.rows[0] });
  } catch (error) {
    console.error('❌ Erro ao atualizar dados do ensaio:', error);
    return res.status(500).json({ error: 'Erro ao atualizar dados.' });
  }
});

// 6. 🔥 REESCRITA WITH MULTER: ROTA DE UPLOAD DO PDF DO ROTEIRO DIRETO PRO CLOUDFLARE R2
router.patch('/painel/ensaios/:id/roteiro', upload.single('roteiro'), async (req, res) => {
  try {
    const { id } = req.params;

    // 🛡️ Garante que o arquivo físico foi de fato capturado pelo Multer
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo PDF foi enviado no campo "roteiro".' });
    }

    // Define o nome único e a pasta onde o roteiro viverá dentro do Bucket R2
    const nomeDoArquivoNoBucket = `roteiros/ensaio-${id}-${Date.now()}.pdf`;

    // Dispara o arquivo em buffer diretamente para o Cloudflare R2
    const comandoR2 = new PutObjectCommand({
      Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
      Key: nomeDoArquivoNoBucket,
      Body: req.file.buffer,
      ContentType: 'application/pdf',
    });

    await s3.send(comandoR2);

    // Monta a URL pública definitiva baseada no seu subdomínio ou URL pública do R2
    const urlPublicaR2 = `${process.env.CLOUDFLARE_R2_PUBLIC_URL}/${nomeDoArquivoNoBucket}`;

    // 🟢 ALTERADO: Atualiza o banco de dados e retorna todos os campos (*)
    const resultado = await pool.query(
      `UPDATE ensaios SET link_roteiro = $1 WHERE id = $2 RETURNING *`,
      [urlPublicaR2, id]
    );

    if (resultado.rowCount === 0) {
      return res.status(404).json({ error: 'Ensaio não encontrado.' });
    }

    const ensaioAtualizado = resultado.rows[0];

    // 🚀 DISPARO DO WEBHOOK CENTRALIZADO PARA O N8N
    try {
      const axios = (await import('axios')).default;

      // Busca dados de contato de todos os membros da equipe escalados
      let dFoto = { email: '', telefone: '' }, dRote = { email: '', telefone: '' }, dAux = { email: '', telefone: '' };
      const nomesEquipe = [ensaioAtualizado.fotografo_responsavel, ensaioAtualizado.roteirista_responsavel, ensaioAtualizado.auxiliar_responsavel].filter(n => n && n.trim() !== '');

      if (nomesEquipe.length > 0) {
        const buscaEquipe = await pool.query('SELECT nome, email, telefone FROM equipe WHERE nome = ANY($1)', [nomesEquipe]);
        buscaEquipe.rows.forEach(membro => {
          if (membro.name === ensaioAtualizado.fotografo_responsavel || membro.nome === ensaioAtualizado.fotografo_responsavel) dFoto = membro;
          if (membro.name === ensaioAtualizado.roteirista_responsavel || membro.nome === ensaioAtualizado.roteirista_responsavel) dRote = membro;
          if (membro.name === ensaioAtualizado.auxiliar_responsavel || membro.nome === ensaioAtualizado.auxiliar_responsavel) dAux = membro;
        });
      }

      const dataBanco = new Date(ensaioAtualizado.data_ensaio);
      const dataFormatada = `${dataBanco.getUTCFullYear()}-${String(dataBanco.getUTCMonth() + 1).padStart(2, '0')}-${String(dataBanco.getUTCDate()).padStart(2, '0')}`;

      await axios.post('https://n8n-new.arsenalestrategia.com.br/webhook/acao_equipe', {
        evento: 'ROTEIRO_ENVIADO',
        ensaio_id: ensaioAtualizado.id,
        empresa_nome: ensaioAtualizado.empresa_nome,
        link_atualizado: urlPublicaR2,
        data_ensaio: dataFormatada,
        hora_inicio: ensaioAtualizado.hora_inicio,
        
        // Informações do Filmmaker
        filmmaker_nome: ensaioAtualizado.fotografo_responsavel || 'Não escalado',
        filmmaker_email: dFoto.email || '',
        filmmaker_telefone: formatarTelefoneWhatsapp(dFoto.telefone),

        // Informações do Roteirista
        roteirista_nome: ensaioAtualizado.roteirista_responsavel || 'Não escalado',
        roteirista_email: dRote.email || '',
        roteirista_telefone: formatarTelefoneWhatsapp(dRote.telefone),

        // Informações do Auxiliar
        auxiliar_nome: ensaioAtualizado.auxiliar_responsavel || 'Não escalado',
        auxiliar_email: dAux.email || '',
        auxiliar_telefone: formatarTelefoneWhatsapp(dAux.telefone)
      });

      console.log(`📡 Webhook [ROTEIRO_ENVIADO] disparado com sucesso para a empresa ${ensaioAtualizado.empresa_nome}`);
    } catch (webhookErr: any) {
      console.error('❌ Erro ao enviar webhook do roteiro para o n8n:', webhookErr.message);
    }

    // Retorna exatamente o objeto que o front-end espera para atualizar o state em tempo real!
    return res.json({ 
      message: 'Roteiro updated com sucesso!', 
      link_roteiro: ensaioAtualizado.link_roteiro 
    });

  } catch (error: any) {
    console.error('❌ Erro crítico no upload do Roteiro R2:', error);
    return res.status(500).json({ error: 'Erro interno ao processar e salvar o PDF do roteiro.' });
  }
});

// 🧪 ROTA DE TESTE — REMOVER DEPOIS
router.get('/painel/testar-relatorio', async (req, res) => {
  try {
    await dispararRelatorioDiario();
    return res.json({ message: 'Relatório disparado! Verifique o n8n e o console do servidor.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export { router };